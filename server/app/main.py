from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict, dataclass, field
from pathlib import Path
from time import monotonic
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel

from .services import (
    DataSource,
    InfluxConfig,
    InfluxRepository,
    MockDataSource,
    TelemetryStore,
    WotDataSource,
    load_devices,
)
from .types import DeviceDefinition

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _load_environment(env_file: Path | None = None) -> None:
    load_dotenv(env_file or PROJECT_ROOT / ".env", override=False)


_load_environment()

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Settings:
    data_source: str
    poll_interval_seconds: float
    history_days: int
    max_points_per_series: int
    tds_directory: Path
    cors_origins: tuple[str, ...]
    influx: InfluxConfig | None

    @classmethod
    def from_environment(cls) -> "Settings":
        influx_host = os.getenv("INFLUX_HOST")
        influx_token = os.getenv("INFLUX_TOKEN") or os.getenv("INFLUX_DB_TOKEN")
        influx_database = os.getenv("INFLUX_DATABASE")
        influx = None
        if influx_host and influx_token and influx_database:
            influx = InfluxConfig(
                host=influx_host,
                token=influx_token,
                database=influx_database,
                organization=os.getenv("INFLUX_ORG"),
                measurement=os.getenv("INFLUX_MEASUREMENT", "device_telemetry"),
            )
        elif any((influx_host, influx_token, influx_database)):
            logger.warning(
                "InfluxDB is disabled because INFLUX_HOST, INFLUX_TOKEN, and "
                "INFLUX_DATABASE are not all configured"
            )

        source = os.getenv("DATA_SOURCE", "wot").lower()
        if source not in {"mock", "wot"}:
            raise ValueError("DATA_SOURCE must be 'mock' or 'wot'")
        default_tds = PROJECT_ROOT / "tds"
        return cls(
            data_source=source,
            poll_interval_seconds=float(os.getenv("POLL_INTERVAL_SECONDS", "2")),
            history_days=int(os.getenv("HISTORY_DAYS", "30")),
            max_points_per_series=int(os.getenv("MAX_POINTS_PER_SERIES", "50000")),
            tds_directory=Path(os.getenv("TDS_DIRECTORY", default_tds)),
            cors_origins=tuple(
                origin.strip()
                for origin in os.getenv(
                    "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
                ).split(",")
                if origin.strip()
            ),
            influx=influx,
        )


@dataclass(slots=True)
class Runtime:
    settings: Settings
    devices: dict[str, DeviceDefinition]
    store: TelemetryStore
    source: DataSource
    influx: InfluxRepository | None
    influx_status: str = "disabled"
    detached: set[str] = field(default_factory=set)

    def is_connected(self, device_id: str) -> bool:
        return device_id not in self.detached

    def connected_devices(self) -> list[DeviceDefinition]:
        return [device for device in self.devices.values() if self.is_connected(device.id)]


class ConnectionRequest(BaseModel):
    connected: bool


def _create_data_source(settings: Settings) -> DataSource:
    if settings.data_source == "mock":
        return MockDataSource()
    return WotDataSource()


def _device_payload(device: DeviceDefinition) -> dict[str, object]:
    return {
        "id": device.id,
        "title": device.title,
        "description": device.description,
        "metrics": [asdict(metric) for metric in device.metrics],
    }


async def _poll_forever(runtime: Runtime) -> None:
    while True:
        started_at = monotonic()
        active = runtime.connected_devices()
        results = await asyncio.gather(
            *(runtime.source.read(device) for device in active),
            return_exceptions=True,
        )
        points = []
        for device, result in zip(active, results):
            if isinstance(result, BaseException):
                logger.warning("Unable to read %s: %s", device.id, result)
                continue
            points.extend(result)
        await runtime.store.append_many(points)
        if runtime.influx is not None and points:
            try:
                await runtime.influx.write(points)
                runtime.influx_status = "connected"
            except Exception as error:
                runtime.influx_status = "error"
                logger.warning("Unable to persist telemetry to InfluxDB: %s", error)
        elapsed = monotonic() - started_at
        await asyncio.sleep(max(0, runtime.settings.poll_interval_seconds - elapsed))


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    settings = Settings.from_environment()
    logger.info("Starting with %s data source", settings.data_source)
    devices = load_devices(settings.tds_directory)
    store = TelemetryStore(settings.max_points_per_series)
    source = _create_data_source(settings)
    influx = InfluxRepository(settings.influx) if settings.influx else None
    runtime = Runtime(settings, devices, store, source, influx)
    app.state.runtime = runtime

    await source.start()
    if influx is not None:
        try:
            await store.append_many(await influx.load_history(settings.history_days))
            runtime.influx_status = "connected"
        except Exception as error:
            runtime.influx_status = "error"
            logger.warning("Unable to load InfluxDB history: %s", error)

    if settings.data_source == "mock" and runtime.influx_status != "connected":
        mock_source = source
        if isinstance(mock_source, MockDataSource):
            await store.append_many(mock_source.history(devices.values(), settings.history_days))

    poll_task = asyncio.create_task(_poll_forever(runtime), name="telemetry-poller")
    try:
        yield
    finally:
        poll_task.cancel()
        with suppress(asyncio.CancelledError):
            await poll_task
        await source.stop()
        if influx is not None:
            influx.close()


app = FastAPI(
    title="WoT Devices Dashboard API",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=Settings.from_environment().cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def _runtime() -> Runtime:
    return app.state.runtime


def _device_or_404(device_id: str) -> DeviceDefinition:
    device = _runtime().devices.get(device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@app.get("/api/health")
async def health() -> dict[str, object]:
    runtime = _runtime()
    return {
        "status": "ok" if runtime.influx_status != "error" else "degraded",
        "dataSource": runtime.settings.data_source,
        "influx": runtime.influx_status,
        "deviceCount": len(runtime.devices),
        "connectedCount": len(runtime.connected_devices()),
        "pollIntervalSeconds": runtime.settings.poll_interval_seconds,
    }


async def _device_state(runtime: Runtime, device: DeviceDefinition) -> dict[str, object]:
    item = _device_payload(device)
    connected = runtime.is_connected(device.id)
    item["connected"] = connected
    # A detached device is no longer polled, so it reports no current readings.
    item["latest"] = await runtime.store.latest(device.id) if connected else {}
    return item


@app.get("/api/devices")
async def devices() -> list[dict[str, object]]:
    runtime = _runtime()
    return [await _device_state(runtime, device) for device in runtime.devices.values()]


@app.post("/api/devices/{device_id}/connection")
async def set_device_connection(
    device_id: str, request: ConnectionRequest
) -> dict[str, object]:
    device = _device_or_404(device_id)
    runtime = _runtime()
    if request.connected:
        runtime.detached.discard(device.id)
    else:
        runtime.detached.add(device.id)
    logger.info(
        "Device %s is now %s", device.id, "connected" if request.connected else "detached"
    )
    return await _device_state(runtime, device)


@app.get("/api/devices/{device_id}/history")
async def device_history(
    device_id: str,
    metrics: str | None = Query(default=None, description="Comma-separated metric names"),
) -> dict[str, object]:
    device = _device_or_404(device_id)
    selected = {name.strip() for name in metrics.split(",")} if metrics else None
    known_metrics = {metric.name for metric in device.metrics}
    if selected and not selected.issubset(known_metrics):
        unknown = sorted(selected - known_metrics)
        raise HTTPException(status_code=400, detail=f"Unknown metrics: {', '.join(unknown)}")
    return {
        "deviceId": device_id,
        "series": await _runtime().store.history(device_id, selected),
    }


@app.get("/api/tds/{device_id}")
async def thing_description(device_id: str) -> dict[str, object]:
    return _device_or_404(device_id).td


@app.websocket("/api/ws/devices/{device_id}")
async def device_stream(websocket: WebSocket, device_id: str) -> None:
    runtime = _runtime()
    if device_id not in runtime.devices:
        await websocket.close(code=4404, reason="Device not found")
        return
    if not runtime.is_connected(device_id):
        await websocket.close(code=4409, reason="Device detached")
        return
    await websocket.accept()
    await websocket.send_json(
        {"type": "snapshot", "data": await runtime.store.latest(device_id)}
    )
    try:
        async for point in runtime.store.subscribe(device_id):
            await websocket.send_json({"type": "telemetry", "data": point.as_dict()})
    except (WebSocketDisconnect, RuntimeError):
        return

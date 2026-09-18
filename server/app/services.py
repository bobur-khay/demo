from __future__ import annotations

import asyncio
import json
import logging
import math
import random
from collections import defaultdict, deque
from collections.abc import AsyncIterator, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

from .types import DeviceDefinition, MetricDefinition, TelemetryPoint, TelemetryValue

logger = logging.getLogger(__name__)


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) else None


def _semantic_type(*sources: dict[str, Any]) -> str | None:
    for source in sources:
        raw_type = source.get("@type")
        candidates = raw_type if isinstance(raw_type, list) else [raw_type]
        for candidate in candidates:
            if isinstance(candidate, str) and candidate and candidate != "Thing":
                return candidate
    return None


def _metric_from_schema(
    name: str, kind: str, raw: dict[str, Any], metadata: dict[str, Any] | None = None
) -> MetricDefinition:
    schema = raw.get("data", raw)
    metadata = metadata or {}
    return MetricDefinition(
        name=name,
        title=str(
            metadata.get(
                "title", raw.get("title", name.replace("-", " ").replace("_", " ").title())
            )
        ),
        kind="event" if kind == "event" else "property",
        value_type=str(schema.get("type", "number")),
        unit=schema.get("unit"),
        minimum=_number(schema.get("minimum")),
        maximum=_number(schema.get("maximum")),
        semantic_type=_semantic_type(raw, metadata),
    )


def _load_original_td(path: Path) -> dict[str, Any]:
    """Read the vendor TD stored under `original/` with the same file name."""
    original_path = path.parent / "original" / path.name
    if not original_path.is_file():
        return {}
    content = original_path.read_bytes()
    try:
        return json.loads(content.decode("utf-8-sig"))
    except UnicodeDecodeError:
        return json.loads(content.decode("utf-16"))


def load_devices(directory: Path) -> dict[str, DeviceDefinition]:
    devices: dict[str, DeviceDefinition] = {}
    for path in sorted(directory.glob("*.td.json")):
        with path.open("r", encoding="utf-8") as td_file:
            td = json.load(td_file)
        title = str(td.get("title", path.name.removesuffix(".td.json")))
        original_td = _load_original_td(path)
        metrics = [
            _metric_from_schema(name, "event", raw, original_td.get("events", {}).get(name))
            for name, raw in td.get("events", {}).items()
        ]
        metrics.extend(
            _metric_from_schema(name, "property", raw, original_td.get("properties", {}).get(name))
            for name, raw in td.get("properties", {}).items()
        )
        device_id = str(td["id"])
        dev_eui = td.get("lorav:devEUI") or original_td.get("lorav:devEUI")
        devices[device_id] = DeviceDefinition(
            id=device_id,
            title=str(original_td.get("title", title)),
            description=str(original_td.get("description", td.get("description", ""))),
            td=td,
            metrics=tuple(metrics),
            dev_eui=str(dev_eui).lower() if dev_eui else None,
            original_td=original_td,
        )
    if not devices:
        raise RuntimeError(f"No Thing Descriptions found in {directory}")
    return devices


class TelemetryStore:
    def __init__(self, max_points_per_series: int) -> None:
        self._series: dict[tuple[str, str], deque[TelemetryPoint]] = defaultdict(
            lambda: deque(maxlen=max_points_per_series)
        )
        self._subscribers: dict[str, set[asyncio.Queue[TelemetryPoint]]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def append(self, point: TelemetryPoint) -> None:
        async with self._lock:
            self._series[(point.device_id, point.metric)].append(point)
            subscribers = tuple(self._subscribers.get(point.device_id, set()))
        for queue in subscribers:
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(point)

    async def append_many(self, points: Iterable[TelemetryPoint]) -> None:
        for point in sorted(points, key=lambda item: item.timestamp):
            await self.append(point)

    async def history(
        self, device_id: str, metrics: set[str] | None = None
    ) -> dict[str, list[dict[str, Any]]]:
        async with self._lock:
            return {
                metric: [point.as_dict() for point in points]
                for (stored_device_id, metric), points in self._series.items()
                if stored_device_id == device_id and (metrics is None or metric in metrics)
            }

    async def latest(self, device_id: str) -> dict[str, dict[str, Any]]:
        async with self._lock:
            return {
                metric: points[-1].as_dict()
                for (stored_device_id, metric), points in self._series.items()
                if stored_device_id == device_id and points
            }

    async def subscribe(self, device_id: str) -> AsyncIterator[TelemetryPoint]:
        queue: asyncio.Queue[TelemetryPoint] = asyncio.Queue(maxsize=256)
        self._subscribers[device_id].add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            self._subscribers[device_id].discard(queue)


class DataSource(Protocol):
    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    async def read(self, device: DeviceDefinition) -> list[TelemetryPoint]: ...


class MockDataSource:
    def __init__(self, seed: int = 731) -> None:
        self._seed = seed
        self._started_at = datetime.now(timezone.utc)

    async def start(self) -> None:
        self._started_at = datetime.now(timezone.utc)

    async def stop(self) -> None:
        return None

    def _value(self, device: DeviceDefinition, metric: MetricDefinition, now: datetime) -> TelemetryValue:
        elapsed = (now - self._started_at).total_seconds()
        if metric.name == "leakage_status":
            return "leak" if int(elapsed / 5) % 2 else "normal"

        randomizer = random.Random(f"{self._seed}:{device.id}:{metric.name}:{int(now.timestamp() / 2)}")
        wave = math.sin(now.timestamp() / 180 + len(metric.name))
        ranges = {
            "temperature": (20.0, 3.0),
            "humidity": (47.0, 9.0),
            "battery": (86.0, 2.0),
            "batteryVoltage": (3.45, 0.08),
            "lowBattery": (0.0, 0.0),
            "voltage-l1-n": (230.0, 3.0),
            "voltage-l2-n": (231.0, 3.0),
            "voltage-l3-n": (229.0, 3.0),
            "current-l1": (4.8, 1.2),
            "current-l2": (5.3, 1.1),
            "current-l3": (4.5, 1.0),
            "active-power-l1": (920.0, 180.0),
            "active-power-l2": (1040.0, 190.0),
            "active-power-l3": (870.0, 160.0),
            "line-frequency": (50.0, 0.2),
        }
        center, spread = ranges.get(metric.name, (50.0, 10.0))
        value = center + spread * wave + randomizer.uniform(-spread * 0.12, spread * 0.12)
        if metric.value_type == "integer":
            return round(value)
        if metric.value_type == "boolean":
            return bool(round(value))
        if metric.value_type == "string":
            return "normal"
        return round(value, 2)

    async def read(self, device: DeviceDefinition) -> list[TelemetryPoint]:
        now = datetime.now(timezone.utc)
        return [
            TelemetryPoint(device.id, metric.name, self._value(device, metric, now), now, "mock")
            for metric in device.metrics
        ]

    def history(self, devices: Iterable[DeviceDefinition], days: int) -> list[TelemetryPoint]:
        now = datetime.now(timezone.utc)
        interval = timedelta(minutes=30)
        cursor = now - timedelta(days=days)
        points: list[TelemetryPoint] = []
        while cursor < now:
            for device in devices:
                for metric in device.metrics:
                    if metric.value_type in {"number", "integer"}:
                        points.append(
                            TelemetryPoint(
                                device.id,
                                metric.name,
                                self._value(device, metric, cursor),
                                cursor,
                                "mock",
                            )
                        )
            cursor += interval
        return points


class WotDataSource:
    def __init__(self) -> None:
        self._servient: Any = None
        self._wot: Any = None
        self._things: dict[str, Any] = {}
        self._event_queue: deque[TelemetryPoint] = deque()
        self._subscriptions: list[Any] = []

    async def start(self) -> None:
        try:
            from wotpy.protocols.zenoh.client import ZenohClient
            from wotpy.wot.servient import Servient
            from wotpy.wot.wot import WoT
        except ImportError as error:
            raise RuntimeError("Installed WoTPy does not include the Zenoh client") from error
        self._servient = Servient(clients=[ZenohClient()])
        await self._servient.start()
        self._wot = WoT(servient=self._servient)

    async def stop(self) -> None:
        for subscription in self._subscriptions:
            subscription.dispose()
        if self._servient is not None:
            await self._servient.shutdown()

    def _consume(self, device: DeviceDefinition) -> Any:
        thing = self._wot.consume(json.dumps(device.td))
        self._things[device.id] = thing
        for metric in device.metrics:
            if metric.kind != "event":
                continue

            def on_event(event: Any, metric_name: str = metric.name) -> None:
                self._event_queue.append(
                    TelemetryPoint(
                        device.id,
                        metric_name,
                        getattr(event, "data", event),
                        datetime.now(timezone.utc),
                        "wot",
                    )
                )

            def on_error(error: Any, metric_name: str = metric.name) -> None:
                logger.warning(
                    "Event subscription %s/%s failed: %s", device.id, metric_name, error
                )

            self._subscriptions.append(
                thing.events[metric.name].subscribe(on_next=on_event, on_error=on_error)
            )
        return thing

    async def read(self, device: DeviceDefinition) -> list[TelemetryPoint]:
        thing = self._things.get(device.id)
        if thing is None:
            thing = self._consume(device)
        now = datetime.now(timezone.utc)
        points = [
            point for point in tuple(self._event_queue) if point.device_id == device.id
        ]
        self._event_queue = deque(
            point for point in self._event_queue if point.device_id != device.id
        )
        properties = [metric for metric in device.metrics if metric.kind == "property"]
        values = await asyncio.gather(
            *(thing.read_property(metric.name) for metric in properties),
            return_exceptions=True,
        )
        points.extend(
            TelemetryPoint(device.id, metric.name, value, now, "wot")
            for metric, value in zip(properties, values)
            if not isinstance(value, BaseException)
        )
        for metric, value in zip(properties, values):
            if isinstance(value, BaseException):
                logger.debug("Unable to read property %s/%s: %s", device.id, metric.name, value)
        return points


@dataclass(frozen=True, slots=True)
class InfluxConfig:
    host: str
    database: str
    username: str | None = None
    password: str | None = None
    # ChirpStack stores every decoded payload field in its own measurement.
    measurement_prefix: str = "device_frmpayload_data_"
    device_tag: str = "dev_eui"
    field_name: str = "value"


def _escape_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'")


class InfluxRepository:
    """Read-only access to the InfluxDB 1.8 database fed by the ChirpStack integration."""

    def __init__(self, config: InfluxConfig, max_points_per_series: int = 50000) -> None:
        import httpx

        self._config = config
        self._max_points = max_points_per_series
        self._client = httpx.AsyncClient(
            base_url=config.host.rstrip("/"),
            auth=(config.username, config.password) if config.username else None,
            timeout=30.0,
        )
        self._measurements: frozenset[str] | None = None

    async def _query(self, statements: Sequence[str]) -> list[list[dict[str, Any]]]:
        response = await self._client.get(
            "/query",
            params={
                "db": self._config.database,
                "q": ";".join(statements),
                "epoch": "ms",
            },
        )
        response.raise_for_status()
        results = sorted(
            response.json().get("results", []), key=lambda item: item.get("statement_id", 0)
        )
        tables: list[list[dict[str, Any]]] = []
        for result in results:
            if result.get("error"):
                raise RuntimeError(result["error"])
            rows: list[dict[str, Any]] = []
            for series in result.get("series", []):
                columns = series.get("columns", [])
                rows.extend(dict(zip(columns, values)) for values in series.get("values", []))
            tables.append(rows)
        return tables

    def measurement_for(self, metric: str) -> str:
        return f"{self._config.measurement_prefix}{metric}"

    async def measurements(self, refresh: bool = False) -> frozenset[str]:
        if self._measurements is None or refresh:
            rows = (await self._query(["SHOW MEASUREMENTS"]))[0]
            self._measurements = frozenset(str(row["name"]) for row in rows)
        return self._measurements

    async def available_metrics(self, device: DeviceDefinition) -> tuple[str, ...]:
        if not device.dev_eui:
            return ()
        known = await self.measurements()
        return tuple(
            metric.name
            for metric in device.metrics
            if self.measurement_for(metric.name) in known
        )

    async def history(
        self, device: DeviceDefinition, metrics: Sequence[str], minutes: int
    ) -> dict[str, list[dict[str, Any]]]:
        available = set(await self.available_metrics(device))
        selected = [metric for metric in metrics if metric in available]
        if not selected or not device.dev_eui:
            return {}
        dev_eui = _escape_literal(device.dev_eui)
        field = self._config.field_name
        statements = [
            f'SELECT "{field}" FROM "{self.measurement_for(metric)}" '
            f"WHERE \"{self._config.device_tag}\" = '{dev_eui}' "
            f"AND time >= now() - {max(1, int(minutes))}m "
            f"ORDER BY time LIMIT {self._max_points}"
            for metric in selected
        ]
        tables = await self._query(statements)
        series: dict[str, list[dict[str, Any]]] = {}
        for metric, rows in zip(selected, tables):
            points = [
                TelemetryPoint(
                    device_id=device.id,
                    metric=metric,
                    value=row[field],
                    timestamp=datetime.fromtimestamp(row["time"] / 1000, tz=timezone.utc),
                    source="influx",
                ).as_dict()
                for row in rows
                if row.get(field) is not None
            ]
            if points:
                series[metric] = points
        return series

    async def close(self) -> None:
        await self._client.aclose()

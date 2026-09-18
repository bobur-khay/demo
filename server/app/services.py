from __future__ import annotations

import asyncio
import json
import logging
import math
import random
from collections import defaultdict, deque
from collections.abc import AsyncIterator, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol, cast

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


def _load_archived_metadata(directory: Path) -> dict[str, dict[str, Any]]:
    metadata: dict[str, dict[str, Any]] = {}
    archive_directory = directory / "archive"
    for path in archive_directory.glob("*.json*"):
        content = path.read_bytes()
        try:
            td = json.loads(content.decode("utf-8-sig"))
        except UnicodeDecodeError:
            td = json.loads(content.decode("utf-16"))
        title = td.get("title")
        if isinstance(title, str) and title:
            metadata[title.casefold()] = td
    return metadata


def load_devices(directory: Path) -> dict[str, DeviceDefinition]:
    archived_metadata = _load_archived_metadata(directory)
    devices: dict[str, DeviceDefinition] = {}
    for path in sorted(directory.glob("*.td.json")):
        with path.open("r", encoding="utf-8") as td_file:
            td = json.load(td_file)
        title = str(td.get("title", path.name.removesuffix(".td.json")))
        original_td = archived_metadata.get(title.casefold(), {})
        metrics = [
            _metric_from_schema(name, "event", raw, original_td.get("events", {}).get(name))
            for name, raw in td.get("events", {}).items()
        ]
        metrics.extend(
            _metric_from_schema(name, "property", raw, original_td.get("properties", {}).get(name))
            for name, raw in td.get("properties", {}).items()
        )
        device_id = str(td["id"])
        devices[device_id] = DeviceDefinition(
            id=device_id,
            title=str(original_td.get("title", title)),
            description=str(original_td.get("description", td.get("description", ""))),
            td=td,
            metrics=tuple(metrics),
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
            *(thing.read_property(metric.name) for metric in properties)
        )
        points.extend(
            TelemetryPoint(device.id, metric.name, value, now, "wot")
            for metric, value in zip(properties, values)
        )
        return points


@dataclass(frozen=True, slots=True)
class InfluxConfig:
    host: str
    token: str
    database: str
    organization: str | None = None
    measurement: str = "device_telemetry"


class InfluxRepository:
    def __init__(self, config: InfluxConfig) -> None:
        from influxdb_client_3 import InfluxDBClient3

        self._config = config
        self._client = InfluxDBClient3(
            host=config.host,
            token=config.token,
            database=config.database,
            org=config.organization,
        )
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="influx")

    async def load_history(self, days: int) -> list[TelemetryPoint]:
        query = (
            f'SELECT time, device_id, metric, numeric_value, string_value, boolean_value '
            f'FROM "{self._config.measurement}" '
            f"WHERE time >= now() - INTERVAL '{days} days' ORDER BY time"
        )
        table = await asyncio.get_running_loop().run_in_executor(
            self._executor, lambda: self._client.query(query=query, language="sql")
        )
        rows = cast(Any, table).to_pylist()
        return [
            TelemetryPoint(
                device_id=str(row["device_id"]),
                metric=str(row["metric"]),
                value=next(
                    (
                        row[field]
                        for field in ("numeric_value", "string_value", "boolean_value")
                        if row.get(field) is not None
                    ),
                    None,
                ),
                timestamp=row["time"],
                source="influx",
            )
            for row in rows
        ]

    async def write(self, points: list[TelemetryPoint]) -> None:
        if not points:
            return
        records = []
        for point in points:
            if isinstance(point.value, bool):
                fields = {"boolean_value": point.value}
            elif isinstance(point.value, int | float):
                fields = {"numeric_value": float(point.value)}
            else:
                fields = {"string_value": str(point.value)}
            records.append({
                "measurement": self._config.measurement,
                "tags": {"device_id": point.device_id, "metric": point.metric},
                "fields": fields,
                "time": point.timestamp,
            })
        await asyncio.get_running_loop().run_in_executor(
            self._executor, lambda: self._client.write(record=records)
        )

    def close(self) -> None:
        self._client.close()
        self._executor.shutdown(wait=False, cancel_futures=True)

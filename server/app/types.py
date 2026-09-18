from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, TypeAlias


TelemetryValue: TypeAlias = float | int | str | bool | None
AffordanceKind: TypeAlias = Literal["event", "property"]


@dataclass(frozen=True, slots=True)
class MetricDefinition:
    name: str
    title: str
    kind: AffordanceKind
    value_type: str
    unit: str | None = None
    minimum: float | None = None
    maximum: float | None = None
    semantic_type: str | None = None


@dataclass(frozen=True, slots=True)
class DeviceDefinition:
    id: str
    title: str
    description: str
    td: dict[str, Any] = field(repr=False)
    metrics: tuple[MetricDefinition, ...]
    # LoRaWAN identifier used as the `dev_eui` tag in the ChirpStack InfluxDB database.
    dev_eui: str | None = None
    # Vendor TD the zenoh proxy TD was derived from, kept for side-by-side inspection.
    original_td: dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True, slots=True)
class TelemetryPoint:
    device_id: str
    metric: str
    value: TelemetryValue
    timestamp: datetime
    source: Literal["mock", "wot", "influx"]

    def as_dict(self) -> dict[str, Any]:
        return {
            "deviceId": self.device_id,
            "metric": self.metric,
            "value": self.value,
            "timestamp": self.timestamp.isoformat(),
            "source": self.source,
        }

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import Settings, _create_data_source, _load_environment, app
from app.services import MockDataSource, WotDataSource, load_devices
from app.types import DeviceDefinition, MetricDefinition


def configure_mock(monkeypatch) -> None:
    monkeypatch.setenv("DATA_SOURCE", "mock")
    monkeypatch.setenv("HISTORY_DATA_SOURCE", "mock")
    monkeypatch.setenv("HISTORY_DAYS", "1")
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "0.05")
    monkeypatch.delenv("INFLUX_HOST", raising=False)
    monkeypatch.delenv("INFLUX_DATABASE", raising=False)


def test_environment_file_selects_mock_without_overriding_process_env(
    monkeypatch, tmp_path: Path
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("DATA_SOURCE=mock\n", encoding="utf-8")

    monkeypatch.delenv("DATA_SOURCE", raising=False)
    _load_environment(env_file)
    assert isinstance(_create_data_source(Settings.from_environment()), MockDataSource)

    monkeypatch.setenv("DATA_SOURCE", "wot")
    _load_environment(env_file)
    assert isinstance(_create_data_source(Settings.from_environment()), WotDataSource)


def test_history_data_source_toggles_the_history_backend(monkeypatch) -> None:
    monkeypatch.setenv("INFLUX_HOST", "http://influx:8086")
    monkeypatch.setenv("INFLUX_DATABASE", "chirpstack")

    monkeypatch.setenv("HISTORY_DATA_SOURCE", "influxdb")
    influx_settings = Settings.from_environment()
    assert influx_settings.history_data_source == "influxdb"
    assert influx_settings.influx is not None

    monkeypatch.setenv("HISTORY_DATA_SOURCE", "mock")
    assert Settings.from_environment().history_data_source == "mock"

    # Without connection details the influxdb mode degrades to generated history.
    monkeypatch.setenv("HISTORY_DATA_SOURCE", "influxdb")
    monkeypatch.delenv("INFLUX_DATABASE")
    assert Settings.from_environment().history_data_source == "mock"

    monkeypatch.setenv("HISTORY_DATA_SOURCE", "nowhere")
    with pytest.raises(ValueError):
        Settings.from_environment()


def test_device_inventory_and_history(monkeypatch) -> None:
    configure_mock(monkeypatch)
    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["dataSource"] == "mock"
        assert health.json()["deviceCount"] == 4

        devices = client.get("/api/devices").json()
        assert len(devices) == 4
        device = devices[0]
        numeric_metric = next(
            metric["name"]
            for metric in device["metrics"]
            if metric["value_type"] in {"number", "integer"}
        )

        history = client.get(
            f"/api/devices/{device['id']}/history",
            params={"metrics": numeric_metric},
        )
        assert history.status_code == 200
        assert set(history.json()["series"]) == {numeric_metric}
        assert history.json()["series"][numeric_metric]

        unknown = client.get(
            f"/api/devices/{device['id']}/history",
            params={"metrics": "not-a-metric"},
        )
        assert unknown.status_code == 400


def test_device_websocket_delivers_snapshot_and_telemetry(monkeypatch) -> None:
    configure_mock(monkeypatch)
    with TestClient(app) as client:
        device_id = client.get("/api/devices").json()[0]["id"]
        with client.websocket_connect(f"/api/ws/devices/{device_id}") as websocket:
            assert websocket.receive_json()["type"] == "snapshot"
            telemetry = websocket.receive_json()
            assert telemetry["type"] == "telemetry"
            assert telemetry["data"]["deviceId"] == device_id
            assert telemetry["data"]["source"] == "mock"


def test_device_can_be_detached_and_reconnected(monkeypatch) -> None:
    configure_mock(monkeypatch)
    with TestClient(app) as client:
        device_id = client.get("/api/devices").json()[0]["id"]

        detached = client.post(
            f"/api/devices/{device_id}/connection", json={"connected": False}
        )
        assert detached.status_code == 200
        assert detached.json()["connected"] is False
        assert detached.json()["latest"] == {}

        assert client.get("/api/health").json()["connectedCount"] == 3
        states = {
            device["id"]: device["connected"]
            for device in client.get("/api/devices").json()
        }
        assert states.pop(device_id) is False
        assert all(states.values())

        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/api/ws/devices/{device_id}"):
                pass

        reconnected = client.post(
            f"/api/devices/{device_id}/connection", json={"connected": True}
        )
        assert reconnected.json()["connected"] is True
        assert client.get("/api/health").json()["connectedCount"] == 4

        assert (
            client.post(
                "/api/devices/urn:missing/connection", json={"connected": True}
            ).status_code
            == 404
        )


def test_mock_leakage_toggles_after_five_seconds() -> None:
    devices = load_devices(Path(__file__).resolve().parents[2] / "tds")
    milesight = next(
        device
        for device in devices.values()
        if any(metric.name == "leakage_status" for metric in device.metrics)
    )
    metric = next(metric for metric in milesight.metrics if metric.name == "leakage_status")
    source = MockDataSource()

    source._started_at = datetime.now(timezone.utc)
    assert source._value(milesight, metric, datetime.now(timezone.utc)) == "normal"

    source._started_at = datetime.now(timezone.utc) - timedelta(seconds=6)
    assert source._value(milesight, metric, datetime.now(timezone.utc)) == "leak"


def test_archived_metadata_overlays_proxy_presentation_only() -> None:
    devices = load_devices(Path(__file__).resolve().parents[2] / "tds")
    milesight = next(device for device in devices.values() if device.title == "milesight em300 zld")

    assert milesight.description.startswith("Milesight EM300-ZLD leak detection sensor")
    assert milesight.td["id"] == "urn:zenoh:proxy:milesight-em300-zld"
    assert milesight.td["events"]["temperature"]["forms"][0]["href"].startswith("zenoh+tcp://")


def test_wot_source_reads_device_properties_concurrently() -> None:
    metric_names = ("voltage-l1-n", "voltage-l2-n")
    device = DeviceDefinition(
        id="meter",
        title="Meter",
        description="",
        td={"id": "meter", "properties": {name: {} for name in metric_names}},
        metrics=tuple(
            MetricDefinition(name, name, "property", "number") for name in metric_names
        ),
    )

    class FakeConsumedThing:
        def __init__(self) -> None:
            self.calls: list[str] = []
            self.all_reads_started = asyncio.Event()

        async def read_property(self, name: str) -> float:
            self.calls.append(name)
            if len(self.calls) == len(metric_names):
                self.all_reads_started.set()
            await self.all_reads_started.wait()
            return {"voltage-l1-n": 230.1, "voltage-l2-n": 231.2}[name]

    class FakeWoT:
        def __init__(self, thing: FakeConsumedThing) -> None:
            self.thing = thing

        def consume(self, _td: str) -> Any:
            return self.thing

    source = WotDataSource()
    thing = FakeConsumedThing()
    source._wot = FakeWoT(thing)

    points = asyncio.run(asyncio.wait_for(source.read(device), timeout=0.1))

    assert thing.calls == list(metric_names)
    assert [(point.metric, point.value, point.source) for point in points] == [
        ("voltage-l1-n", 230.1, "wot"),
        ("voltage-l2-n", 231.2, "wot"),
    ]
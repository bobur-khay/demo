from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app
from app.services import MockDataSource, load_devices


def configure_mock(monkeypatch) -> None:
    monkeypatch.setenv("DATA_SOURCE", "mock")
    monkeypatch.setenv("HISTORY_DAYS", "1")
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "0.05")
    monkeypatch.delenv("INFLUX_HOST", raising=False)
    monkeypatch.delenv("INFLUX_TOKEN", raising=False)
    monkeypatch.delenv("INFLUX_DB_TOKEN", raising=False)
    monkeypatch.delenv("INFLUX_DATABASE", raising=False)


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
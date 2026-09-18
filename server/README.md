# WoT Devices Dashboard API

FastAPI service that discovers active `*.td.json` Thing Descriptions, streams live readings from WoTPy over WebSockets, and serves historical trends from an InfluxDB 1.8 database filled by the ChirpStack integration.

## Local setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

The API runs at `http://127.0.0.1:8000`; OpenAPI is at `/docs`. Copy `.env.example` to the project root as `.env` for local configuration. The application loads that file automatically, while values exported by the shell or process manager take precedence.

## Runtime modes

- `DATA_SOURCE=wot` (default) consumes each TD with WoTPy's Zenoh client, reads device properties concurrently every poll interval, and subscribes to events. These readings feed the live metric cards.
- `DATA_SOURCE=mock` generates deterministic two-second telemetry and alternates Milesight `leakage_status` between `normal` and `leak` every five seconds.
- `HISTORY_DATA_SOURCE=influxdb` serves every trend chart straight from InfluxDB 1.8. It requires `INFLUX_HOST` and `INFLUX_DATABASE` (plus optional `INFLUX_USERNAME` / `INFLUX_PASSWORD`) and falls back to generated history when they are missing.
- `HISTORY_DATA_SOURCE=mock` preloads `HISTORY_DAYS` of synthetic half-hour history into the in-memory store instead.
- Metrics are matched to InfluxDB measurements as `INFLUX_MEASUREMENT_PREFIX` + metric name (for example `device_frmpayload_data_temperature`) and filtered by the `dev_eui` tag taken from the TD's `lorav:devEUI`.

WoTPy is pinned to upstream commit `f72b8490d56972e2fcc124f19b1d96c5d85eb074` for reproducible installs.

## API

- `GET /api/health`
- `GET /api/devices`
- `GET /api/devices/{device_id}/history?metrics=temperature,humidity&minutes=1440`
- `GET /api/devices/{device_id}/history-metrics`
- `GET /api/tds/{device_id}`
- `WS /api/ws/devices/{device_id}`

## Test

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

Run one API worker because the bounded history and WebSocket subscriber queues are process-local. Horizontal scaling requires moving ingestion and fan-out to shared infrastructure.

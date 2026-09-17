# WoT Operations API

FastAPI service that discovers active `zenoh-*.td.json` Thing Descriptions, keeps bounded telemetry history in memory, optionally persists it to InfluxDB 3, and streams device-scoped updates over WebSockets.

## Local setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

The API runs at `http://127.0.0.1:8000`; OpenAPI is at `/docs`. Copy `.env.example` to the project root as `.env` for local configuration. The application loads that file automatically, while values exported by the shell or process manager take precedence.

## Runtime modes

- `DATA_SOURCE=wot` (default) consumes each TD with WoTPy's Zenoh client, reads device properties concurrently every poll interval, and subscribes to events.
- `DATA_SOURCE=mock` generates deterministic two-second telemetry, 30 days of half-hour history, and alternates Milesight `leakage_status` between `normal` and `leak` every five seconds.
- InfluxDB is enabled only when `INFLUX_HOST`, `INFLUX_TOKEN`, and `INFLUX_DATABASE` are all present. Existing history is loaded at startup and new points are persisted continuously.

WoTPy is pinned to upstream commit `f72b8490d56972e2fcc124f19b1d96c5d85eb074` for reproducible installs.

## API

- `GET /api/health`
- `GET /api/devices`
- `GET /api/devices/{device_id}/history?metrics=temperature,humidity`
- `GET /api/tds/{device_id}`
- `WS /api/ws/devices/{device_id}`

## Test

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

Run one API worker because the bounded history and WebSocket subscriber queues are process-local. Horizontal scaling requires moving ingestion and fan-out to shared infrastructure.

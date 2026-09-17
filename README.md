# WoT Operations Dashboard

Operations dashboard for four Web of Things devices described by `tds/zenoh-*.td.json`. It provides two-second telemetry, up to 30 days of bounded history, device-scoped WebSockets, three-phase electrical analysis, and a five-second mock Milesight leakage cycle.

## Run locally

Start the API:

```powershell
Set-Location server
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Start the dashboard in another terminal:

```powershell
Set-Location client
npm ci
npm run dev
```

Open `http://localhost:5173`. Mock communication is the default; configure values from `server/.env.example` in the process environment to enable WoTPy or InfluxDB.

## Run with containers

```powershell
docker compose up --build
```

Open `http://localhost:8080`. Nginx proxies REST and WebSocket traffic to the single API worker. Supply Influx settings through a root `.env` file or deployment secret manager; never put tokens in source-controlled files.

## Verify

```powershell
Set-Location server
.\.venv\Scripts\python.exe -m pytest -q
Set-Location ..\client
npm run lint
npm run build
```

See the server and client READMEs for runtime and dependency details.

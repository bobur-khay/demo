# WoT Devices Dashboard

React dashboard for live device metrics, bounded historical charts, three-phase Sentron analysis, and Milesight leakage alerts.

## Local setup

```powershell
npm ci
npm run dev
```

Vite runs at `http://localhost:5173` and uses `http://localhost:8000` for API and WebSocket traffic by default. Set `VITE_API_BASE_URL` before building when the backend uses another origin. Production builds use the page origin when the variable is absent.

```powershell
npm run lint
npm run build
```

## Eclipse Thingweb UI-WoT

`@thingweb/ui-wot-components` is not published in the npm registry. The repository-local package in `vendor/` was built from Eclipse Thingweb UI-WoT commit `163eda2fe46fe98af6cef4fffb8c511b2a0e1c91` and is installed through the lockfile. The dashboard uses `ui-event` for leakage event history and `ui-notification` for leak warnings.

To refresh the artifact, clone that upstream repository at an explicitly reviewed commit, run `npm ci` and `npm run build --workspace packages/components`, then run `npm pack` in `packages/components` and replace the tarball while updating its provenance note.

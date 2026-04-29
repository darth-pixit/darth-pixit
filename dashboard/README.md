# Fleet Safety Dashboard — Demo Unit

Standalone web dashboard that visualizes Darth-Pixit safety data for a fleet
of drivers. Currently runs entirely off seeded demo data, so it can be shown
to a couple of users for a few days without a backend or database.

## Run it

```bash
cd dashboard
node server.js
```

Then open <http://localhost:4000>.

Override the port: `PORT=8080 node server.js`.

Zero npm dependencies — uses Node's built-in `http` module. Works on any
machine with Node ≥ 18.

## What's in here

| File | Purpose |
|------|---------|
| `server.js` | Tiny HTTP server. Serves `/` (SPA) and `/api/*` (JSON). |
| `fleetData.js` | Seeded fleet — 4 drivers covering excellent / average / poor / post-crash. |
| `alerts.js` | JS mirror of `src/safety/alerts.ts`. Maps event severity to red/yellow/green. |
| `public/index.html` | Dashboard shell + tabs. |
| `public/app.js` | Vanilla-JS frontend, polls `/api/*` every 2s. |
| `public/styles.css` | Dark theme styling. |

## Views

- **Overview** — fleet KPIs, top drivers, latest alerts.
- **Drivers** — full roster sorted by worst alert level. Click a row for detail.
- **Alerts feed** — flat severity-sorted feed across all drivers.
- **Live demo driver** — driver `demo-001` mirroring the in-app demo math
  (`throttle = 0.45 + 0.4·sin(t·0.6)`) — open this view while the phone is in
  Demo Mode and they show the same waveform.

## Alert mapping

Same logic as the in-app Driver Score screen:

| Event severity | Level |
|----------------|-------|
| 1, 2 | green |
| 3 | yellow |
| 4, 5 | red |
| crash (any severity) | red |

Auto-triggered: any time a driver's `events[]` or `wearSignals[]` includes a
matching item, the alert appears in `/api/alerts` and on the dashboard.

## Sharing it for a few days

The server has no persistent state and no auth — fine for an internal demo,
not for production. To expose it to a couple of testers without setting up
hosting, pipe it through a tunnel:

```bash
# in one terminal
node dashboard/server.js
# in another
cloudflared tunnel --url http://localhost:4000
# or
ngrok http 4000
```

Either gives you a public URL valid until you stop the tunnel.

## Keeping in sync with the app

The dashboard's alert logic and demo data both mirror modules under
`src/safety/`. If you change:

- `src/safety/alerts.ts` → also update `dashboard/alerts.js`
- `src/safety/demoFixture.ts` → also update `dashboard/fleetData.js`

The two-file mirror is intentional: the dashboard is plain JS so it can run
without the React Native build pipeline.

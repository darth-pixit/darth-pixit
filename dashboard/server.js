/**
 * Fleet dashboard demo server.
 *
 * Zero npm dependencies — uses Node's built-in http + fs so it runs anywhere
 * Node >= 18 is installed. Boot with: `node server.js` from this directory.
 *
 * Endpoints:
 *   GET  /                  → dashboard SPA (public/index.html)
 *   GET  /api/fleet         → array of drivers with rolled-up alerts
 *   GET  /api/driver/:id    → single driver + full alert list
 *   GET  /api/alerts        → flat alert feed across the fleet, newest first
 *
 * Demo-mode sync: driver `demo-001` returns a fresh `liveDemoReadout` on every
 * request matching the in-app demo math (sine-wave throttle).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildFleet, refreshLiveDriver } = require('./fleetData');
const { alertFromEvent, alertFromWear, worstLevel } = require('./alerts');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const fleetState = buildFleet();

function driverAlerts(driver) {
  const eventAlerts = [];
  for (const trip of driver.trips) {
    for (const e of trip.events) eventAlerts.push(alertFromEvent(e));
  }
  const wearAlerts = driver.wearSignals.map(alertFromWear);
  return [...eventAlerts, ...wearAlerts].sort((a, b) => b.at - a.at);
}

function driverSummary(driver) {
  const alerts = driverAlerts(driver);
  return {
    id: driver.id,
    name: driver.name,
    vehicle: driver.vehicle,
    lifetimeScore: driver.lifetimeScore,
    lastTripScore: driver.trips[0]?.score?.composite ?? null,
    alertCount: alerts.length,
    worstLevel: worstLevel(alerts),
    liveDemoReadout: driver.liveDemoReadout,
    eventCounts: countEventsByLevel(alerts),
  };
}

function countEventsByLevel(alerts) {
  const c = { red: 0, yellow: 0, green: 0 };
  for (const a of alerts) c[a.level]++;
  return c;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + urlPath);
  const publicRoot = path.resolve(PUBLIC_DIR);
  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url === '/api/fleet') {
    refreshLiveDriver(fleetState);
    return send(res, 200, fleetState.map(driverSummary));
  }

  if (url.startsWith('/api/driver/')) {
    const id = url.slice('/api/driver/'.length);
    refreshLiveDriver(fleetState);
    const driver = fleetState.find((d) => d.id === id);
    if (!driver) return send(res, 404, { error: 'unknown driver' });
    return send(res, 200, {
      ...driver,
      alerts: driverAlerts(driver),
    });
  }

  if (url === '/api/alerts') {
    const all = [];
    for (const d of fleetState) {
      for (const a of driverAlerts(d)) {
        all.push({ ...a, driverId: d.id, driverName: d.name });
      }
    }
    all.sort((a, b) => b.at - a.at);
    return send(res, 200, all);
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Fleet dashboard demo unit listening on http://localhost:${PORT}`);
  console.log('Routes:');
  console.log('  /              dashboard SPA');
  console.log('  /api/fleet     fleet roster + rolled-up alert counts');
  console.log('  /api/driver/:id  per-driver detail');
  console.log('  /api/alerts    flat alert feed across all drivers');
});

// Fleet dashboard frontend. Vanilla JS — no build step. Polls the demo server
// every 2 seconds so the live driver waveform stays in sync with the app demo.

const root = document.getElementById('root');
const tabs = document.querySelectorAll('.tab');
const lastSync = document.getElementById('lastSync');

const state = {
  view: 'overview',
  selectedDriverId: null,
  fleet: [],
  alerts: [],
  driverDetail: null,
};

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.view = tab.dataset.view;
    state.selectedDriverId = null;
    render();
  });
});

async function refresh() {
  try {
    const [fleetResp, alertsResp] = await Promise.all([
      fetch('/api/fleet'),
      fetch('/api/alerts'),
    ]);
    state.fleet = await fleetResp.json();
    state.alerts = await alertsResp.json();
    if (state.selectedDriverId) {
      const detail = await fetch(`/api/driver/${state.selectedDriverId}`);
      state.driverDetail = await detail.json();
    }
    lastSync.textContent = `synced ${new Date().toLocaleTimeString()}`;
    render();
  } catch (e) {
    lastSync.textContent = 'sync failed: ' + e.message;
  }
}

function scoreClass(s) {
  if (s == null) return '';
  if (s >= 80) return 'green';
  if (s >= 60) return 'yellow';
  return 'red';
}

function fmtAgo(ts) {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return sec + 's ago';
  const min = Math.round(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.round(min / 60);
  if (hr < 48) return hr + 'h ago';
  return Math.round(hr / 24) + 'd ago';
}

function render() {
  if (state.selectedDriverId && state.driverDetail) {
    return renderDriverDetail();
  }
  switch (state.view) {
    case 'overview': return renderOverview();
    case 'drivers':  return renderDrivers();
    case 'alerts':   return renderAlerts();
    case 'live':     return renderLive();
  }
}

function renderOverview() {
  const totalDrivers = state.fleet.length;
  const totalAlerts = state.alerts.length;
  const reds = state.alerts.filter((a) => a.level === 'red').length;
  const yellows = state.alerts.filter((a) => a.level === 'yellow').length;
  const avgLifetime = totalDrivers
    ? Math.round(state.fleet.reduce((s, d) => s + (d.lifetimeScore || 0), 0) / totalDrivers)
    : 0;

  root.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="label">Drivers</div><div class="value">${totalDrivers}</div></div>
      <div class="kpi ${scoreClass(avgLifetime)}"><div class="label">Avg lifetime score</div><div class="value">${avgLifetime}</div></div>
      <div class="kpi red"><div class="label">Red alerts</div><div class="value">${reds}</div></div>
      <div class="kpi yellow"><div class="label">Yellow alerts</div><div class="value">${yellows}</div></div>
    </div>

    <div class="grid-2">
      <section class="card">
        <header class="card-head"><h2>Fleet roster</h2><p>Click a driver to drill down</p></header>
        <div class="card-body">${driverTable(state.fleet.slice(0, 8))}</div>
      </section>
      <section class="card">
        <header class="card-head"><h2>Latest alerts</h2><p>Auto-triggered by event severity</p></header>
        <div class="card-body">${alertList(state.alerts.slice(0, 8))}</div>
      </section>
    </div>
  `;
  wireDriverRows();
}

function renderDrivers() {
  root.innerHTML = `
    <section class="card">
      <header class="card-head"><h2>All drivers</h2><p>Sorted by worst alert level</p></header>
      <div class="card-body">${driverTable(sortDriversBySeverity(state.fleet))}</div>
    </section>
  `;
  wireDriverRows();
}

function renderAlerts() {
  root.innerHTML = `
    <section class="card">
      <header class="card-head"><h2>Alerts feed</h2><p>All drivers · severity-mapped to traffic-light bands</p></header>
      <div class="card-body">${alertList(state.alerts, true)}</div>
    </section>
  `;
}

function renderLive() {
  const driver = state.fleet.find((d) => d.id === 'demo-001');
  if (!driver) {
    root.innerHTML = `<p>Demo driver missing.</p>`;
    return;
  }
  const r = driver.liveDemoReadout || { throttle: 0, speedKmH: 0, fuelRateLPerH: 0 };
  const thumbPct = (r.throttle * 100).toFixed(1);
  root.innerHTML = `
    <section class="card live-card">
      <div>
        <div class="live-stat"><div class="label">Driver</div><div class="value" style="font-size:18px">${driver.name}</div></div>
        <div class="live-stat" style="margin-top:14px"><div class="label">Vehicle</div><div class="value" style="font-size:14px;color:#bbb">${driver.vehicle}</div></div>
        <div class="live-stat" style="margin-top:14px"><div class="label">Speed</div><div class="value">${Math.round(r.speedKmH)} <span style="font-size:14px;color:#888">km/h</span></div></div>
        <div class="live-stat" style="margin-top:14px"><div class="label">Fuel rate</div><div class="value">${r.fuelRateLPerH.toFixed(1)} <span style="font-size:14px;color:#888">L/h</span></div></div>
      </div>
      <div>
        <div class="live-stat"><div class="label">Throttle (eco → push)</div></div>
        <div class="gauge" style="margin-top:8px"><div class="thumb" style="left:${thumbPct}%"></div></div>
        <p style="color:#888;font-size:12px;margin-top:14px">
          Mirrors the in-app demo math: <code style="color:#bbb">throttle = 0.45 + 0.4·sin(t·0.6)</code>,
          speed = 20 + throttle×60, fuel rate = 0.8 + throttle×9. Refreshes every 2s.
        </p>
      </div>
    </section>
  `;
}

function renderDriverDetail() {
  const d = state.driverDetail;
  const trip = d.trips[0];
  const score = trip?.score?.composite ?? d.lifetimeScore;
  root.innerHTML = `
    <button class="back-link" id="back">← Back</button>
    <section class="card">
      <header class="card-head">
        <h2>${d.name}</h2>
        <p>${d.vehicle}</p>
      </header>
      <div class="kpis" style="grid-template-columns:repeat(3,1fr)">
        <div class="kpi ${scoreClass(score)}"><div class="label">Last trip score</div><div class="value">${Math.round(score)}</div></div>
        <div class="kpi ${scoreClass(d.lifetimeScore)}"><div class="label">Lifetime</div><div class="value">${d.lifetimeScore}</div></div>
        <div class="kpi"><div class="label">Total alerts</div><div class="value">${d.alerts.length}</div></div>
      </div>
    </section>
    <div class="grid-2">
      <section class="card">
        <header class="card-head"><h2>Category scores</h2><p>Last trip · 0–100</p></header>
        <div class="card-body">${categoryBars(trip?.score)}</div>
      </section>
      <section class="card">
        <header class="card-head"><h2>Alerts (${d.alerts.length})</h2><p>Newest first</p></header>
        <div class="card-body">${alertList(d.alerts)}</div>
      </section>
    </div>
  `;
  document.getElementById('back').addEventListener('click', () => {
    state.selectedDriverId = null;
    state.driverDetail = null;
    render();
  });
}

function driverTable(drivers) {
  if (drivers.length === 0) return `<p style="color:#888">No drivers.</p>`;
  return `
    <table>
      <thead><tr>
        <th>Driver</th><th>Vehicle</th><th>Last trip</th><th>Lifetime</th><th>Alerts</th><th>Status</th>
      </tr></thead>
      <tbody>
        ${drivers.map((d) => `
          <tr class="driver-row" data-id="${d.id}">
            <td>${d.name}</td>
            <td style="color:#888">${d.vehicle}</td>
            <td><span class="score-pill ${scoreClass(d.lastTripScore)}">${d.lastTripScore == null ? '—' : Math.round(d.lastTripScore)}</span></td>
            <td><span class="score-pill ${scoreClass(d.lifetimeScore)}">${d.lifetimeScore}</span></td>
            <td>
              <span class="badge red">${d.eventCounts.red}</span>
              <span class="badge yellow">${d.eventCounts.yellow}</span>
              <span class="badge green">${d.eventCounts.green}</span>
            </td>
            <td><span class="dot ${d.worstLevel}"></span>${d.worstLevel}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function alertList(alerts, withDriver) {
  if (alerts.length === 0) return `<p style="color:#888">No alerts.</p>`;
  return alerts.map((a) => `
    <div class="alert-row">
      <span class="dot ${a.level}"></span>
      <div class="meta">
        <div class="title">${a.title}${withDriver && a.driverName ? ` <span style="color:#888;font-weight:400">— ${a.driverName}</span>` : ''}</div>
        <div class="detail">${a.detail}</div>
      </div>
      <div class="when">${fmtAgo(a.at)}</div>
      <span class="badge ${a.level}">${a.level.toUpperCase()}</span>
    </div>
  `).join('');
}

function categoryBars(score) {
  if (!score) return `<p style="color:#888">No score yet.</p>`;
  const cats = [
    ['Acceleration', score.acceleration.score],
    ['Braking', score.braking.score],
    ['Cornering', score.cornering.score],
    ['Speeding', score.speeding.score],
    ['Focus', score.distracted.score],
  ];
  return cats.map(([label, val]) => `
    <div style="display:flex;align-items:center;gap:12px;padding:8px 0">
      <div style="width:110px;color:#bbb;font-size:13px">${label}</div>
      <div style="flex:1;height:8px;background:#222;border-radius:4px;overflow:hidden">
        <div style="width:${Math.max(0,Math.min(100,val))}%;height:8px;background:var(--${scoreClass(val) || 'green'})"></div>
      </div>
      <div style="width:34px;text-align:right;color:var(--${scoreClass(val) || 'green'});font-weight:600">${Math.round(val)}</div>
    </div>
  `).join('');
}

function sortDriversBySeverity(drivers) {
  const rank = { red: 0, yellow: 1, green: 2 };
  return [...drivers].sort((a, b) => rank[a.worstLevel] - rank[b.worstLevel]);
}

function wireDriverRows() {
  document.querySelectorAll('.driver-row').forEach((row) => {
    row.addEventListener('click', async () => {
      state.selectedDriverId = row.dataset.id;
      const detail = await fetch(`/api/driver/${state.selectedDriverId}`);
      state.driverDetail = await detail.json();
      render();
    });
  });
}

refresh();
setInterval(refresh, 2000);

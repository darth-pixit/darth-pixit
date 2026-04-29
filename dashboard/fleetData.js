/**
 * Seeded fleet data for the dashboard demo unit.
 *
 * Mirrors src/safety/demoFixture.ts:
 *   - Driver "demo-001" runs the SAME synthetic-vehicle math as the app's demo
 *     mode: throttle = 0.45 + 0.4·sin(t·0.6), speed = 20 + throttle×60,
 *     fuelRate = 0.8 + throttle×9. So opening the dashboard while the phone
 *     has demo mode on shows the matching live waveform.
 *   - Other drivers are static personas covering the score spectrum (excellent,
 *     average, poor, post-crash) so reviewers see all alert levels.
 */

const NOW_BASE = Date.now();
const HOUR = 3_600_000;

function ev(id, type, severity, peak, ago) {
  return {
    id,
    type,
    severity,
    peak,
    startedAt: NOW_BASE - ago,
    endedAt: NOW_BASE - ago + 1500,
    location: { lat: 12.97, lng: 77.59 },
  };
}

function score(composite, parts) {
  const cat = (s) => ({ score: s, penalty: 100 - s, eventCount: 0, recoveredCount: 0 });
  return {
    composite,
    acceleration: cat(parts.acc),
    braking: cat(parts.brk),
    cornering: cat(parts.cor),
    speeding: cat(parts.spd),
    distracted: cat(parts.dis),
    crashed: parts.crashed || false,
    routeGraceFactor: 1.0,
    weatherCondition: 'clear',
  };
}

function appDemoLiveReadout() {
  const t = Date.now() / 1000;
  const throttle = Math.max(0, Math.min(1, 0.45 + 0.4 * Math.sin(t * 0.6)));
  return {
    throttle,
    speedKmH: 20 + throttle * 60,
    fuelRateLPerH: 0.8 + throttle * 9,
  };
}

function buildFleet() {
  return [
    {
      id: 'demo-001',
      name: 'Demo Driver (App Demo Mode)',
      vehicle: 'Maruti Swift · KA01-AB-1234',
      lifetimeScore: 82,
      liveDemoReadout: appDemoLiveReadout(),
      trips: [
        {
          id: 'trip-d1-1',
          startedAt: NOW_BASE - 2 * HOUR,
          endedAt: NOW_BASE - 1 * HOUR,
          distanceM: 18_400,
          activeDurationMs: 52 * 60_000,
          events: [
            ev('e1', 'hard_braking', 3, 3.8, 1.6 * HOUR),
            ev('e2', 'overspeeding', 2, 7, 1.4 * HOUR),
          ],
          score: score(78, { acc: 88, brk: 65, cor: 92, spd: 80, dis: 95 }),
          crash: null,
          wearSignals: [],
        },
      ],
      wearSignals: [],
    },
    {
      id: 'demo-002',
      name: 'Asha Patel',
      vehicle: 'Tata Nexon · KA05-CD-2210',
      lifetimeScore: 91,
      liveDemoReadout: { throttle: 0.22, speedKmH: 38, fuelRateLPerH: 2.8 },
      trips: [
        {
          id: 'trip-d2-1',
          startedAt: NOW_BASE - 4 * HOUR,
          endedAt: NOW_BASE - 3 * HOUR,
          distanceM: 22_100,
          activeDurationMs: 48 * 60_000,
          events: [],
          score: score(94, { acc: 96, brk: 95, cor: 92, spd: 91, dis: 98 }),
          crash: null,
          wearSignals: [],
        },
      ],
      wearSignals: [],
    },
    {
      id: 'demo-003',
      name: 'Ravi Kumar',
      vehicle: 'Hero Splendor · KA02-EF-9988',
      lifetimeScore: 64,
      liveDemoReadout: { throttle: 0.71, speedKmH: 62, fuelRateLPerH: 7.2 },
      trips: [
        {
          id: 'trip-d3-1',
          startedAt: NOW_BASE - 26 * HOUR,
          endedAt: NOW_BASE - 25 * HOUR,
          distanceM: 31_000,
          activeDurationMs: 70 * 60_000,
          events: [
            ev('e3', 'hard_acceleration', 4, 4.6, 25.6 * HOUR),
            ev('e4', 'hard_cornering', 4, 5.1, 25.4 * HOUR),
            ev('e5', 'distracted_driving', 3, 8, 25.2 * HOUR),
            ev('e6', 'overspeeding', 5, 22, 25.1 * HOUR),
          ],
          score: score(58, { acc: 55, brk: 70, cor: 50, spd: 45, dis: 70 }),
          crash: null,
          wearSignals: [],
        },
      ],
      wearSignals: [
        {
          type: 'sustained_high_load',
          value: 88,
          threshold: 80,
          detectedAt: NOW_BASE - 25 * HOUR,
          durationS: 42,
          severity: 3,
          location: null,
        },
      ],
    },
    {
      id: 'demo-004',
      name: 'Nikhil Shah',
      vehicle: 'Honda City · KA03-GH-4477',
      lifetimeScore: 41,
      liveDemoReadout: { throttle: 0.92, speedKmH: 88, fuelRateLPerH: 9.4 },
      trips: [
        {
          id: 'trip-d4-1',
          startedAt: NOW_BASE - 50 * HOUR,
          endedAt: NOW_BASE - 49 * HOUR,
          distanceM: 12_000,
          activeDurationMs: 30 * 60_000,
          events: [
            ev('e7', 'crash', 5, 31.2, 49.5 * HOUR),
            ev('e8', 'hard_braking', 5, 6.0, 49.5 * HOUR),
          ],
          score: score(0, { acc: 30, brk: 0, cor: 40, spd: 30, dis: 50, crashed: true }),
          crash: {
            id: 'crash-1',
            detectedAt: NOW_BASE - 49.5 * HOUR,
            location: { lat: 12.97, lng: 77.59 },
            peakG: 3.2,
            speedAtImpactKmH: 54,
            confirmedStop: true,
          },
          wearSignals: [],
        },
      ],
      wearSignals: [],
    },
  ];
}

/** Refresh the live readout for driver demo-001 so the dashboard waveform tracks. */
function refreshLiveDriver(fleet) {
  const d1 = fleet.find((d) => d.id === 'demo-001');
  if (d1) d1.liveDemoReadout = appDemoLiveReadout();
  return fleet;
}

module.exports = { buildFleet, refreshLiveDriver };

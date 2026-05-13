/**
 * Deterministic demo fixture used in two places:
 *   1. The Driver Score screen, when no real SafetyStore data exists yet
 *   2. The fleet web dashboard's seed data
 *
 * In-app demo mode runs a sine-wave throttle and synthesizes:
 *   fuelRate L/h = 0.8 + throttle × 9
 *   speed km/h   = 20 + throttle × 60
 * Driver #1 in this fixture mirrors that exact pattern so the dashboard view
 * for "Demo Driver" stays in sync with what the phone shows in demo mode.
 */

import { SafetyEvent, SafetyScore, TripRecord, WearSignal } from './types';

export interface DemoDriver {
  id: string;
  name: string;
  vehicle: string;
  lifetimeScore: number;
  trips: TripRecord[];
  wearSignals: WearSignal[];
  /** Live readouts the in-app demo mode is producing right now. */
  liveDemoReadout: {
    throttle: number;
    speedKmH: number;
    fuelRateLPerH: number;
  };
}

// Fixed locations for demo events — deterministic so the screen doesn't flicker
// on re-renders and the map (if ever added) shows consistent pins.
const DEMO_LOCATIONS = [
  { lat: 12.9716, lng: 77.5946 },
  { lat: 12.9732, lng: 77.5961 },
  { lat: 12.9748, lng: 77.5930 },
  { lat: 12.9705, lng: 77.5975 },
  { lat: 12.9760, lng: 77.5918 },
  { lat: 12.9721, lng: 77.5952 },
  { lat: 12.9738, lng: 77.5940 },
  { lat: 12.9712, lng: 77.5964 },
];
let _locationIdx = 0;

function ev(
  id: string,
  type: SafetyEvent['type'],
  severity: 1 | 2 | 3 | 4 | 5,
  peak: number,
  startedAt: number,
): SafetyEvent {
  const location = DEMO_LOCATIONS[_locationIdx % DEMO_LOCATIONS.length];
  _locationIdx++;
  return {
    id,
    type,
    severity,
    peak,
    startedAt,
    endedAt: startedAt + 1500,
    location,
  };
}

function score(
  composite: number,
  parts: { acc: number; brk: number; cor: number; spd: number; dis: number },
): SafetyScore {
  const cat = (s: number) => ({ score: s, penalty: 100 - s, eventCount: 0, recoveredCount: 0 });
  return {
    composite,
    acceleration: cat(parts.acc),
    braking: cat(parts.brk),
    cornering: cat(parts.cor),
    speeding: cat(parts.spd),
    distracted: cat(parts.dis),
    crashed: false,
    routeGraceFactor: 1.0,
    weatherCondition: 'clear',
  };
}

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function mirroredAppDemoReadout(): DemoDriver['liveDemoReadout'] {
  // Match ThrottleView demo: sine wave centered at 0.45 with ±0.4 amplitude.
  // The dashboard sampling once per second is fine for visualization.
  const t = Date.now() / 1000;
  const throttle = Math.max(0, Math.min(1, 0.45 + 0.4 * Math.sin(t * 0.6)));
  return {
    throttle,
    speedKmH: 20 + throttle * 60,
    fuelRateLPerH: 0.8 + throttle * 9,
  };
}

export function buildDemoFleet(): DemoDriver[] {
  return [
    {
      id: 'demo-001',
      name: 'Demo Driver (App Demo Mode)',
      vehicle: 'Maruti Swift · KA01-AB-1234',
      lifetimeScore: 82,
      liveDemoReadout: mirroredAppDemoReadout(),
      trips: [
        {
          id: 'trip-d1-1',
          startedAt: NOW - 2 * HOUR,
          endedAt: NOW - 1 * HOUR,
          distanceM: 18_400,
          activeDurationMs: 52 * 60 * 1000,
          events: [
            ev('e1', 'hard_braking', 3, 3.8, NOW - 1.6 * HOUR),
            ev('e2', 'overspeeding', 2, 7, NOW - 1.4 * HOUR),
          ],
          trail: [],
          score: score(78, { acc: 88, brk: 65, cor: 92, spd: 80, dis: 95 }),
          crash: null,
          wearSignals: [],
          drowsinessEvents: [],
          weatherContext: null,
          routeContext: null,
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
          startedAt: NOW - 4 * HOUR,
          endedAt: NOW - 3 * HOUR,
          distanceM: 22_100,
          activeDurationMs: 48 * 60 * 1000,
          events: [],
          trail: [],
          score: score(94, { acc: 96, brk: 95, cor: 92, spd: 91, dis: 98 }),
          crash: null,
          wearSignals: [],
          drowsinessEvents: [],
          weatherContext: null,
          routeContext: null,
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
          startedAt: NOW - 26 * HOUR,
          endedAt: NOW - 25 * HOUR,
          distanceM: 31_000,
          activeDurationMs: 70 * 60 * 1000,
          events: [
            ev('e3', 'hard_acceleration', 4, 4.6, NOW - 25.6 * HOUR),
            ev('e4', 'hard_cornering', 4, 5.1, NOW - 25.4 * HOUR),
            ev('e5', 'distracted_driving', 3, 8, NOW - 25.2 * HOUR),
            ev('e6', 'overspeeding', 5, 22, NOW - 25.1 * HOUR),
          ],
          trail: [],
          score: score(58, { acc: 55, brk: 70, cor: 50, spd: 45, dis: 70 }),
          crash: null,
          wearSignals: [],
          drowsinessEvents: [],
          weatherContext: null,
          routeContext: null,
        },
      ],
      wearSignals: [
        {
          type: 'sustained_high_load',
          value: 88,
          threshold: 80,
          detectedAt: NOW - 25 * HOUR,
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
          startedAt: NOW - 50 * HOUR,
          endedAt: NOW - 49 * HOUR,
          distanceM: 12_000,
          activeDurationMs: 30 * 60 * 1000,
          events: [
            ev('e7', 'crash', 5, 31.2, NOW - 49.5 * HOUR),
            ev('e8', 'hard_braking', 5, 6.0, NOW - 49.5 * HOUR),
          ],
          trail: [],
          score: score(0, { acc: 30, brk: 0, cor: 40, spd: 30, dis: 50 }),
          crash: {
            id: 'crash-1',
            detectedAt: NOW - 49.5 * HOUR,
            location: { lat: 12.97, lng: 77.59 },
            peakG: 3.2,
            speedAtImpactKmH: 54,
            preImpactTrace: [],
            postImpactTrace: [],
            preImpactTrail: [],
            confirmedStop: true,
            featuresTriggered: 4,
          },
          wearSignals: [],
          drowsinessEvents: [],
          weatherContext: null,
          routeContext: null,
        },
      ],
      wearSignals: [],
    },
  ];
}

/** Single-driver "self" view for the in-app fallback. */
export function selfDemoDriver(): DemoDriver {
  return buildDemoFleet()[0];
}

export const _testing = { DAY, HOUR };

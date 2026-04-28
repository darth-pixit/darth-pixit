/**
 * SafetyController — boots the SafetyEngine singleton and wires it
 * to the live OBD data stream.
 *
 * What this hooks up:
 *   - AsyncStorage-backed persistence (trips survive app restarts).
 *   - AppState binding (background/foreground transitions).
 *   - OBD data binding via the existing Zustand OBDStore — each
 *     state change forwards an OBDSnapshot into TripManager. We do
 *     not call OBDManager.setUpdateHandler because OBDStore already
 *     owns that single-handler slot.
 *   - Trip lifecycle: a trip starts when the OBD adapter reaches
 *     'ready' and ends when it leaves 'ready' (disconnect / error /
 *     user stop). The trip record is then saved by SafetyEngine's
 *     existing tripEndedHandler.
 *
 * What this does NOT hook up (no library installed yet):
 *   - GPS (`bindGPS`)            — needs react-native-geolocation-service or expo-location
 *   - Accelerometer/gyroscope    — needs react-native-sensors or expo-sensors
 *   Without those, trips will record OBD data and speed-derived
 *   harsh-accel/brake events, but no distance, route, or crash
 *   detection. Add bindings here once those libraries land.
 */

import { AppState } from 'react-native';
import { SafetyEngine } from './index';
import { AsyncStorageKV } from './AsyncStorageKV';
import { useOBDStore } from '../obd/OBDStore';
import { OBDSnapshot } from './types';

let enginePromise: Promise<SafetyEngine> | null = null;

export function initSafetyEngine(): Promise<SafetyEngine> {
  if (!enginePromise) {
    enginePromise = SafetyEngine.create(new AsyncStorageKV()).then((engine) => {
      engine.bindAppState(AppState);
      bindOBDStore(engine);
      return engine;
    });
  }
  return enginePromise;
}

export function getSafetyEngine(): Promise<SafetyEngine> {
  return initSafetyEngine();
}

function bindOBDStore(engine: SafetyEngine): void {
  // Lifecycle: start/end trips on OBD ready-state transitions.
  let tripStarted = false;
  useOBDStore.subscribe((next, prev) => {
    const liveNow = next.state === 'ready';
    const liveBefore = prev.state === 'ready';

    if (liveNow && !liveBefore && !tripStarted) {
      engine.startTrip();
      tripStarted = true;
    } else if (!liveNow && liveBefore && tripStarted) {
      engine.endTrip();
      tripStarted = false;
    }
  });

  // Data: forward every OBD update as an OBDSnapshot. TripManager
  // ignores snapshots when no trip is active, so it's safe to fire
  // unconditionally.
  engine.bindOBDSnapshot((cb) =>
    useOBDStore.subscribe((s) => {
      const snap: OBDSnapshot = {
        rpm: s.rpm,
        speedKmH: s.speedKmH,
        engineLoadPct: s.engineLoadPct,
        coolantC: s.coolantC,
        warmupComplete: (s.coolantC ?? 0) > 70,
        t: Date.now(),
      };
      cb(snap);
    }),
  );
}

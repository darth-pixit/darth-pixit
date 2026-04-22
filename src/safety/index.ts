/**
 * Safety package — public API.
 *
 * ============================================================
 *  Quick-start wiring guide
 * ============================================================
 *
 *   import { SafetyEngine, InMemoryKV } from './safety';
 *   // In production swap InMemoryKV for an AsyncStorage-backed impl:
 *   //   import AsyncStorage from '@react-native-async-storage/async-storage';
 *   //   const kv = { getItem: AsyncStorage.getItem, setItem: AsyncStorage.setItem,
 *   //                 removeItem: AsyncStorage.removeItem, getAllKeys: AsyncStorage.getAllKeys };
 *
 *   const engine = await SafetyEngine.create(kv);
 *
 *   engine.bindOBDSpeed((cb) => {
 *     OBDManager.getInstance().setUpdateHandler((data) => {
 *       if (data.speedKmH !== null) cb(data.speedKmH);
 *     });
 *     return () => OBDManager.getInstance().setUpdateHandler(null as any);
 *   });
 *
 *   engine.bindOBDSnapshot((cb) => {
 *     OBDManager.getInstance().setUpdateHandler((data) => {
 *       cb({ rpm: data.rpm, speedKmH: data.speedKmH,
 *            engineLoadPct: data.engineLoadPct, coolantC: data.coolantC,
 *            warmupComplete: (data.coolantC ?? 0) > 70, t: Date.now() });
 *     });
 *     return () => {};
 *   });
 *
 *   // GPS: react-native-geolocation-service or expo-location
 *   engine.bindGPS((cb) => {
 *     const sub = Location.watchPositionAsync({ accuracy: 4, timeInterval: 1000 },
 *       (loc) => cb({ lat: loc.coords.latitude, lng: loc.coords.longitude,
 *                     speedMPS: loc.coords.speed, headingDeg: loc.coords.heading,
 *                     accuracyM: loc.coords.accuracy ?? 999,
 *                     altitudeM: loc.coords.altitude, t: loc.timestamp }));
 *     return () => sub.then((s) => s.remove());
 *   });
 *
 *   // Accelerometer: react-native-sensors or expo-sensors
 *   engine.bindAccelerometer((cb) => {
 *     const { unsubscribe } = accelerometer.subscribe(({ x, y, z, timestamp }) =>
 *       cb({ accel: { x, y, z }, t: timestamp }));
 *     return unsubscribe;
 *   });
 *
 *   // Gyroscope: react-native-sensors or expo-sensors
 *   engine.bindGyroscope((cb) => {
 *     const { unsubscribe } = gyroscope.subscribe(({ x, y, z, timestamp }) =>
 *       cb({ gyro: { x, y, z }, t: timestamp }));
 *     return unsubscribe;
 *   });
 *
 *   engine.bindAppState(AppState);
 *
 *   engine.startTrip();
 *   const trip = engine.endTrip();
 *
 *   // UI (React):
 *   const { liveScore, events, weather, wearSignals } = useSafetyStore();
 */

import {
  TripRecord,
  SafetyConfig,
  CrashReport,
  AccelerometerSample,
  GyroscopeSample,
  GPSPoint,
  OBDSnapshot,
} from './types';
import { TripManager } from './TripManager';
import { SafetyDatabase, KVStore, InMemoryKV } from './SafetyDatabase';
import { SafetyScorer } from './SafetyScorer';
import { useSafetyStore } from './SafetyStore';

export * from './types';
export { SensorFusion } from './SensorFusion';
export { GPSTracker, haversineM } from './GPSTracker';
export { EventDetector } from './EventDetector';
export { CrashReporter } from './CrashReporter';
export { OBDWearMonitor } from './OBDWearMonitor';
export { WeatherContext, conditionToThresholdFactor } from './WeatherContext';
export { RouteTracker } from './RouteTracker';
export { DrowsinessDetector } from './DrowsinessDetector';
export { RecoveryTracker } from './RecoveryTracker';
export { SafetyScorer } from './SafetyScorer';
export type { ScoringContext } from './SafetyScorer';
export { TripManager } from './TripManager';
export type { TripSnapshot } from './TripManager';
export { SafetyDatabase, InMemoryKV } from './SafetyDatabase';
export type { KVStore } from './SafetyDatabase';
export { useSafetyStore } from './SafetyStore';
export type { SafetyState } from './SafetyStore';

export class SafetyEngine {
  private tm: TripManager;
  private db: SafetyDatabase;
  private scorer: SafetyScorer;
  private cfg: SafetyConfig;

  private unsubscribers: Array<() => void> = [];

  private constructor(cfg: SafetyConfig, db: SafetyDatabase, kv: KVStore) {
    this.cfg = cfg;
    this.db = db;
    this.scorer = new SafetyScorer(cfg);
    this.tm = new TripManager(cfg);

    // Load persisted route tiles.
    this.tm.loadPersisted(kv).catch(() => { /* non-fatal */ });

    this.tm.setSnapshotHandler((s) => {
      useSafetyStore.getState()._applyTripSnapshot(s);
    });

    this.tm.setTripEndedHandler(async (trip) => {
      // Persist route tiles for familiarity tracking.
      await this.tm.persistRouteAfterTrip(kv).catch(() => {});
      await this.db.saveTrip(trip);
      useSafetyStore.getState()._onTripEnded(trip);
      if (trip.crash) useSafetyStore.getState()._setCrashReport(trip.crash);
      const trips = await this.db.loadAllTrips(50);
      useSafetyStore.getState()._setRecentTrips(trips);
      useSafetyStore.getState()._setLifetimeScore(this.scorer.lifetimeScore(trips));
    });
  }

  static async create(kv: KVStore = new InMemoryKV()): Promise<SafetyEngine> {
    const db = new SafetyDatabase(kv);
    const cfg = await db.loadConfig();
    const engine = new SafetyEngine(cfg, db, kv);
    const trips = await db.loadAllTrips(50);
    useSafetyStore.getState()._setConfig(cfg);
    useSafetyStore.getState()._setRecentTrips(trips);
    useSafetyStore.getState()._setLifetimeScore(engine.scorer.lifetimeScore(trips));
    return engine;
  }

  // ---------- Trip lifecycle ----------

  startTrip(): string { return this.tm.startTrip(); }
  endTrip(): TripRecord | null { return this.tm.endTrip(); }
  isActive(): boolean { return this.tm.isActive(); }

  // ---------- Config ----------

  async updateConfig(patch: Partial<SafetyConfig>): Promise<void> {
    this.cfg = { ...this.cfg, ...patch };
    this.tm.updateConfig(patch);
    this.scorer.updateConfig(patch);
    await this.db.saveConfig(this.cfg);
    useSafetyStore.getState()._setConfig(this.cfg);
  }

  getConfig(): SafetyConfig { return { ...this.cfg }; }

  // ---------- Sensor bindings ----------

  bindOBDSpeed(subscribe: (cb: (speedKmH: number, t?: number) => void) => () => void): void {
    const unsub = subscribe((kmh, t) => this.tm.ingestOBDSpeed(kmh, t ?? Date.now()));
    this.unsubscribers.push(unsub);
  }

  bindOBDSnapshot(subscribe: (cb: (snap: OBDSnapshot) => void) => () => void): void {
    const unsub = subscribe((snap) => this.tm.ingestOBDSnapshot(snap));
    this.unsubscribers.push(unsub);
  }

  bindGPS(subscribe: (cb: (point: GPSPoint) => void) => () => void): void {
    const unsub = subscribe((p) => this.tm.ingestGPS(p));
    this.unsubscribers.push(unsub);
  }

  bindAccelerometer(subscribe: (cb: (s: AccelerometerSample) => void) => () => void): void {
    const unsub = subscribe((s) => this.tm.ingestAccelerometer(s));
    this.unsubscribers.push(unsub);
  }

  bindGyroscope(subscribe: (cb: (s: GyroscopeSample) => void) => () => void): void {
    const unsub = subscribe((s) => this.tm.ingestGyroscope(s));
    this.unsubscribers.push(unsub);
  }

  bindAppState(appState: {
    addEventListener: (
      event: 'change',
      handler: (s: 'active' | 'background' | 'inactive' | string) => void,
    ) => { remove: () => void };
  }): void {
    const sub = appState.addEventListener('change', (next) => {
      const now = Date.now();
      if (next === 'active') this.tm.onAppForeground(now);
      else if (next === 'background' || next === 'inactive') this.tm.onAppBackground(now);
    });
    this.unsubscribers.push(() => sub.remove());
  }

  dispose(): void {
    for (const u of this.unsubscribers) { try { u(); } catch { /* ignore */ } }
    this.unsubscribers = [];
  }

  // ---------- History ----------

  async loadHistory(limit = 50): Promise<TripRecord[]> { return this.db.loadAllTrips(limit); }
  async loadCrashes(): Promise<CrashReport[]> { return this.db.loadAllCrashes(); }
  async deleteTrip(id: string): Promise<void> {
    await this.db.deleteTrip(id);
    const trips = await this.db.loadAllTrips(50);
    useSafetyStore.getState()._setRecentTrips(trips);
    useSafetyStore.getState()._setLifetimeScore(this.scorer.lifetimeScore(trips));
  }
}

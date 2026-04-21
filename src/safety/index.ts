/**
 * Safety package — public API.
 *
 * ============================================================
 *  Wiring guide
 * ============================================================
 *
 *   import { SafetyEngine } from './safety';
 *
 *   const engine = await SafetyEngine.create(kvStore);
 *   engine.bindOBD((onSpeed) => OBDManager.onSpeed(onSpeed));
 *   engine.bindGPS((onPoint) => Location.watchPositionAsync(onPoint));
 *   engine.bindAccelerometer((onSample) => accel.subscribe(onSample));
 *   engine.bindAppState(AppState);
 *
 *   engine.startTrip();
 *   // ... drive ...
 *   const trip = engine.endTrip();
 *
 *   // UI:
 *   const state = useSafetyStore();
 *
 * The binding is done by the app so the safety package stays
 * independent of any RN sensor library.
 */

import {
  TripRecord,
  SafetyConfig,
  CrashReport,
  AccelerometerSample,
  GPSPoint,
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
export { SafetyScorer } from './SafetyScorer';
export { TripManager } from './TripManager';
export { SafetyDatabase, InMemoryKV } from './SafetyDatabase';
export type { KVStore } from './SafetyDatabase';
export { useSafetyStore } from './SafetyStore';
export type { SafetyState } from './SafetyStore';

/**
 * SafetyEngine — thin facade that wires TripManager + Database + Store
 * and exposes a small binding surface for the app.
 */
export class SafetyEngine {
  private tm: TripManager;
  private db: SafetyDatabase;
  private scorer: SafetyScorer;
  private cfg: SafetyConfig;

  private unsubscribers: Array<() => void> = [];

  private constructor(cfg: SafetyConfig, db: SafetyDatabase) {
    this.cfg = cfg;
    this.db = db;
    this.tm = new TripManager(cfg);
    this.scorer = new SafetyScorer(cfg);

    this.tm.setSnapshotHandler((s) => {
      useSafetyStore.getState()._applyTripSnapshot(s);
    });
    this.tm.setTripEndedHandler(async (trip) => {
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
    const engine = new SafetyEngine(cfg, db);
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
  //
  // Each bindX takes a subscription function returning an unsubscribe.
  // We hold the unsubscribers so engine.dispose() cleans them up.
  //
  // This inversion keeps the package free of direct dependencies on
  // any specific RN sensor library.

  bindOBDSpeed(subscribe: (cb: (speedKmH: number, t?: number) => void) => () => void): void {
    const unsub = subscribe((kmh, t) => this.tm.ingestOBDSpeed(kmh, t ?? Date.now()));
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

  /**
   * Minimal AppState binding: accepts the RN AppState module or an
   * equivalent { addEventListener(event, handler) }.
   */
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

  async loadHistory(limit = 50): Promise<TripRecord[]> {
    return this.db.loadAllTrips(limit);
  }

  async loadCrashes(): Promise<CrashReport[]> {
    return this.db.loadAllCrashes();
  }

  async deleteTrip(id: string): Promise<void> {
    await this.db.deleteTrip(id);
    const trips = await this.db.loadAllTrips(50);
    useSafetyStore.getState()._setRecentTrips(trips);
    useSafetyStore.getState()._setLifetimeScore(this.scorer.lifetimeScore(trips));
  }
}

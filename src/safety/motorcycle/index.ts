/**
 * Motorcycle safety package — public API.
 *
 * Usage:
 *   import { MotoSafetyEngine } from './safety/motorcycle';
 *   const engine = await MotoSafetyEngine.create(kv, { subtype: 'scooter' });
 *   engine.bindGPS(...);
 *   engine.bindAccelerometer(...);
 *   engine.bindGyroscope(...);  // required for crash + wobble + drowsiness
 *   engine.bindAppState(AppState);
 *   engine.startTrip();
 *   const trip = engine.endTrip();
 */

import {
  TripRecord,
  CrashReport,
  AccelerometerSample,
  GyroscopeSample,
  GPSPoint,
  OBDSnapshot,
} from '../types';
import { SafetyDatabase, KVStore, InMemoryKV } from '../SafetyDatabase';
import { useSafetyStore } from '../SafetyStore';
import { MotoConfig, DEFAULT_MOTO_CONFIG, DEFAULT_SCOOTER_CONFIG, MotoSafetyEvent } from './types';
import { MotoTripManager } from './MotoTripManager';
import { MotoScorer } from './MotoScorer';

export * from './types';
export { LeanAngleEstimator } from './LeanAngleEstimator';
export { MotoEventDetector } from './MotoEventDetector';
export { MotoCrashReporter } from './MotoCrashReporter';
export { MotoScorer } from './MotoScorer';
export { MotoTripManager } from './MotoTripManager';
export type { MotoTripSnapshot, MotoTripEndedHandler } from './MotoTripManager';

export class MotoSafetyEngine {
  private tm: MotoTripManager;
  private db: SafetyDatabase;
  private scorer: MotoScorer;
  private cfg: MotoConfig;

  private unsubscribers: Array<() => void> = [];

  private constructor(cfg: MotoConfig, db: SafetyDatabase, kv: KVStore) {
    this.cfg = cfg;
    this.db = db;
    this.scorer = new MotoScorer(cfg);
    this.tm = new MotoTripManager(cfg);

    this.tm.loadPersisted(kv).catch(() => {});

    this.tm.setSnapshotHandler((s) => {
      useSafetyStore.getState()._applyTripSnapshot({
        ...s,
        events: s.events.map(e => ({ ...e, type: e.type as any })),
        drowsinessDetectorCalibrated: s.leanCalibrated,
      });
    });

    this.tm.setTripEndedHandler(async (trip) => {
      await this.tm.persistRouteAfterTrip(kv).catch(() => {});
      // Coerce motoEvents back to SafetyEvent shape for storage.
      const storableTrip: TripRecord = {
        ...trip,
        events: trip.events.map(e => ({ ...e, type: e.type as any })),
      };
      await this.db.saveTrip(storableTrip);
      useSafetyStore.getState()._onTripEnded(storableTrip);
      if (trip.crash) useSafetyStore.getState()._setCrashReport(trip.crash);
      const trips = await this.db.loadAllTrips(50);
      useSafetyStore.getState()._setRecentTrips(trips);
      useSafetyStore.getState()._setLifetimeScore(this.scorer.lifetimeScore(trips));
    });
  }

  static async create(
    kv: KVStore = new InMemoryKV(),
    overrides: Partial<MotoConfig> = {},
  ): Promise<MotoSafetyEngine> {
    const db = new SafetyDatabase(kv);
    const base = await db.loadConfig();
    const defaultCfg = overrides.subtype === 'scooter' ? DEFAULT_SCOOTER_CONFIG : DEFAULT_MOTO_CONFIG;
    const cfg: MotoConfig = { ...defaultCfg, ...base, ...overrides };
    const engine = new MotoSafetyEngine(cfg, db, kv);
    const trips = await db.loadAllTrips(50);
    useSafetyStore.getState()._setConfig(cfg);
    useSafetyStore.getState()._setRecentTrips(trips);
    useSafetyStore.getState()._setLifetimeScore(engine.scorer.lifetimeScore(trips));
    return engine;
  }

  startTrip(): string { return this.tm.startTrip(); }
  endTrip() { return this.tm.endTrip(); }
  isActive(): boolean { return this.tm.isActive(); }

  async updateConfig(patch: Partial<MotoConfig>): Promise<void> {
    this.cfg = { ...this.cfg, ...patch };
    this.tm.updateConfig(patch);
    this.scorer.updateConfig(patch);
    await this.db.saveConfig(this.cfg);
    useSafetyStore.getState()._setConfig(this.cfg);
  }

  getConfig(): MotoConfig { return { ...this.cfg }; }

  bindOBDSpeed(subscribe: (cb: (speedKmH: number, t?: number) => void) => () => void): void {
    this.unsubscribers.push(subscribe((kmh, t) => this.tm.ingestOBDSpeed(kmh, t ?? Date.now())));
  }

  bindOBDSnapshot(subscribe: (cb: (snap: OBDSnapshot) => void) => () => void): void {
    this.unsubscribers.push(subscribe((s) => this.tm.ingestOBDSnapshot(s)));
  }

  bindGPS(subscribe: (cb: (p: GPSPoint) => void) => () => void): void {
    this.unsubscribers.push(subscribe((p) => this.tm.ingestGPS(p)));
  }

  bindAccelerometer(subscribe: (cb: (s: AccelerometerSample) => void) => () => void): void {
    this.unsubscribers.push(subscribe((s) => this.tm.ingestAccelerometer(s)));
  }

  bindGyroscope(subscribe: (cb: (s: GyroscopeSample) => void) => () => void): void {
    this.unsubscribers.push(subscribe((s) => this.tm.ingestGyroscope(s)));
  }

  bindAppState(appState: {
    addEventListener: (event: 'change', handler: (s: string) => void) => { remove: () => void };
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

  async loadHistory(limit = 50): Promise<TripRecord[]> { return this.db.loadAllTrips(limit); }
  async loadCrashes(): Promise<CrashReport[]> { return this.db.loadAllCrashes(); }
}

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
import {
  MotoConfig,
  DEFAULT_MOTO_CONFIG,
  DEFAULT_ELECTRIC_MOTO_CONFIG,
  DEFAULT_SCOOTER_CONFIG,
  DEFAULT_ELECTRIC_SCOOTER_CONFIG,
  MotoSafetyEvent,
} from './types';
import { MotoTripManager } from './MotoTripManager';
import { MotoScorer, RiderBaseline, RiderDeviation } from './MotoScorer';
import { MapplsClient, MapplsClientOptions } from './MapplsClient';
import { OSMOverpassClient, OSMOverpassClientOptions } from './OSMOverpassClient';
import { ContextEnrichmentService, ContextEnrichmentOptions } from './ContextEnrichmentService';
import { SignalProximityGetter } from './RoadObstacleFilter';

export * from './types';
export { LeanAngleEstimator } from './LeanAngleEstimator';
export { MotoEventDetector } from './MotoEventDetector';
export { MotoCrashReporter } from './MotoCrashReporter';
export { MotoScorer } from './MotoScorer';
export type { RiderBaseline, RiderDeviation } from './MotoScorer';
export { MotoTripManager } from './MotoTripManager';
export type { MotoTripSnapshot, MotoTripEndedHandler } from './MotoTripManager';
export { GPSKalmanFilter } from './GPSKalmanFilter';
export type { KalmanGPSState } from './GPSKalmanFilter';
export { PhonePositionClassifier } from './PhonePositionClassifier';
export { RiderContextProvider, bucketTimeOfDay } from './RiderContextProvider';
export { SwerveDetector } from './SwerveDetector';
export type { SwerveEvent } from './SwerveDetector';
export { RoadObstacleFilter } from './RoadObstacleFilter';
export type { ObstacleKind, ObstacleFilterVerdict, SignalProximityGetter } from './RoadObstacleFilter';
export { RiderEventDetector } from './RiderEventDetector';
export type { RiderFeatureAggregates } from './RiderEventDetector';
export { MapplsClient, parseMaxspeed, toRoadClass } from './MapplsClient';
export type { MapplsClientOptions, MapplsTrafficResult, MapplsReverseResult } from './MapplsClient';
export { OSMOverpassClient, haversineM } from './OSMOverpassClient';
export type { OSMOverpassClientOptions, OSMResult, TrafficSignalPoint } from './OSMOverpassClient';
export { ContextEnrichmentService } from './ContextEnrichmentService';
export type {
  EngineContextSink,
  ContextEnrichmentOptions,
} from './ContextEnrichmentService';

export class MotoSafetyEngine {
  private tm: MotoTripManager;
  private db: SafetyDatabase;
  private scorer: MotoScorer;
  private cfg: MotoConfig;

  private unsubscribers: Array<() => void> = [];

  /** Optional Mappls + OSM enrichment pipeline. Wired via `enableContextEnrichment()`. */
  private enrichment: ContextEnrichmentService | null = null;
  private mappls: MapplsClient | null = null;
  private osm: OSMOverpassClient | null = null;

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
      // Drop trips flagged too-short for scoring (spec §2.4) — they're
      // persisted only for completeness so they don't vanish silently,
      // but with score=null they are excluded from rolling aggregates.
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

    // Trip-stitching auto-end watchdog (spec §2.4). When the manager
    // decides the rider has been stopped for > 5 min, it calls this
    // handler and we run the normal endTrip pipeline.
    this.tm.setAutoEndHandler(() => {
      try { this.tm.endTrip(); } catch { /* persistence layer logs its own errors */ }
    });
  }

  static async create(
    kv: KVStore = new InMemoryKV(),
    overrides: Partial<MotoConfig> = {},
  ): Promise<MotoSafetyEngine> {
    const db = new SafetyDatabase(kv);
    const base = await db.loadConfig();
    const isScooter = overrides.subtype === 'scooter';
    const isElectric = overrides.powertrain === 'electric';
    const defaultCfg =
      isScooter && isElectric ? DEFAULT_ELECTRIC_SCOOTER_CONFIG :
      isScooter               ? DEFAULT_SCOOTER_CONFIG          :
      isElectric              ? DEFAULT_ELECTRIC_MOTO_CONFIG    :
                                DEFAULT_MOTO_CONFIG;
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

  // ---------- Delivery-rider context injection ----------

  /** Push the current Mappls 2W ambient-flow speed for the rider's segment. */
  setAmbient2WSpeedKmH(kmH: number): void { this.tm.setAmbient2WSpeedKmH(kmH); }
  /** Push the OSM road class for the current segment. */
  setRoadClass(rc: import('./types').RoadClass): void { this.tm.setRoadClass(rc); }
  /** Push the known speed limit (OSM maxspeed or zone beacon) for the segment. */
  setSpeedLimitKmH(kmH: number): void { this.tm.setSpeedLimitKmH(kmH); }

  /** Report a touch event (if you wire the RN touch layer into the engine). */
  reportTouchEvent(): void { this.tm.reportTouchEvent(); }
  /** Report the device charging state. */
  reportCharging(isCharging: boolean): void { this.tm.reportCharging(isCharging); }
  /** Report voice-call state transitions (iOS CTCallState / Android TelephonyManager). */
  setCallActive(active: boolean, t: number = Date.now()): void { this.tm.setCallActive(active, t); }

  /**
   * Report the currently-foreground app ID (package on Android, bundle
   * on iOS) and whether the screen is on. Enables the distraction
   * detector (spec §4.6 Event 2). Apps listed in `cfg.deliveryAppIds`
   * are whitelisted and never penalised.
   */
  setForegroundApp(appId: string | null, screenOn: boolean, t: number = Date.now()): void {
    this.tm.setForegroundApp(appId, screenOn, t);
  }

  // ---------- Per-rider analytics ----------

  /**
   * Rolling 30-day distance-weighted composite score. Null if no
   * scorable trips in the window.
   */
  async rolling30DayScore(now: number = Date.now()): Promise<number | null> {
    const trips = await this.db.loadAllTrips(500);
    return this.scorer.rolling30DayScore(trips, now);
  }

  /** Rolling 7-day distance-weighted composite score. */
  async rolling7DayScore(now: number = Date.now()): Promise<number | null> {
    const trips = await this.db.loadAllTrips(500);
    return this.scorer.rolling7DayScore(trips, now);
  }

  /**
   * Per-rider 20th-percentile metric baseline (spec §5.4). Returns null
   * until the rider has at least 50 scorable trips.
   */
  async riderBaseline(): Promise<RiderBaseline | null> {
    const trips = await this.db.loadAllTrips(500);
    return this.scorer.riderBaseline(trips);
  }

  /**
   * Flag per-metric deviations where the trip's penalty exceeds the
   * rider's own p20 baseline.
   */
  async deviationFromBaseline(trip: TripRecord): Promise<RiderDeviation | null> {
    const trips = await this.db.loadAllTrips(500);
    return this.scorer.deviationFromBaseline(trip, trips);
  }

  // ---------- Context enrichment (Mappls + OSM) ----------

  /**
   * Enable live context enrichment. Constructs the Mappls + OSM clients
   * from the supplied options and wires the ContextEnrichmentService so
   * every GPS fix triggers a (debounced) lookup that pushes ambient
   * speed, road class, speed limit, and traffic-signal proximity into
   * the trip manager.
   *
   * Either `mappls` or `osm` may be omitted — the engine falls back to
   * the heuristic road-class inference when neither is available.
   */
  enableContextEnrichment(options: {
    mappls?: MapplsClientOptions;
    osm?: OSMOverpassClientOptions;
    service?: Omit<ContextEnrichmentOptions, 'mappls' | 'osm'>;
  }): void {
    if (options.mappls) this.mappls = new MapplsClient(options.mappls);
    if (options.osm !== undefined) this.osm = new OSMOverpassClient(options.osm);

    this.enrichment = new ContextEnrichmentService(
      {
        setAmbient2WSpeedKmH: (k) => this.tm.setAmbient2WSpeedKmH(k),
        setRoadClass: (rc) => this.tm.setRoadClass(rc),
        setSpeedLimitKmH: (k) => this.tm.setSpeedLimitKmH(k),
      },
      {
        mappls: this.mappls ?? undefined,
        osm: this.osm ?? undefined,
        ...options.service,
      },
    );

    // Traffic-signal proximity for the normal-stop obstacle filter.
    // The getter re-evaluates distance to the last-known signals on every
    // brake event using the most recent GPS fix.
    this.tm.setSignalProximityGetter(() => {
      const last = this.tm.getLastGPS();
      if (!last || !this.enrichment) return { near: false, distM: null };
      const distM = this.enrichment.nearestTrafficSignalM(last.lat, last.lng);
      return {
        near: distM !== null && distM <= 30,
        distM,
      };
    });
  }

  /** Disable enrichment and clear cached clients. */
  disableContextEnrichment(): void {
    this.enrichment = null;
    this.mappls = null;
    this.osm = null;
    this.tm.setSignalProximityGetter(null);
  }

  bindOBDSpeed(subscribe: (cb: (speedKmH: number, t?: number) => void) => () => void): void {
    this.unsubscribers.push(subscribe((kmh, t) => this.tm.ingestOBDSpeed(kmh, t ?? Date.now())));
  }

  bindOBDSnapshot(subscribe: (cb: (snap: OBDSnapshot) => void) => () => void): void {
    this.unsubscribers.push(subscribe((s) => this.tm.ingestOBDSnapshot(s)));
  }

  bindGPS(subscribe: (cb: (p: GPSPoint) => void) => () => void): void {
    this.unsubscribers.push(subscribe((p) => {
      this.tm.ingestGPS(p);
      this.enrichment?.onGPS(p);
    }));
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

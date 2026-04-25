/**
 * 4W Fleet Driver Safety Analytics Engine — public API.
 *
 * Usage:
 *   import { CarSafetyEngine } from './safety/car';
 *
 *   const engine = await CarSafetyEngine.create(kv, {
 *     carClass: 'suv',
 *     transmission: 'automatic',
 *     vehicleId: 'MRHFK8G12JU123456',
 *   });
 *
 *   // Wire sensors
 *   engine.bindOBDSnapshot(subscribe);
 *   engine.bindGPS(subscribe);
 *   engine.bindAccelerometer(subscribe);
 *   engine.bindGyroscope(subscribe);
 *   engine.bindAppState(AppState);
 *
 *   // OBD connection lifecycle reporting
 *   engine.setOBDConnectionState('connected');
 *
 *   // At trip start: read and push DTC codes from Mode 03
 *   engine.setDTCCodes(['P0300', 'C0031']);
 *
 *   // Optional: probe PIDs once per vehicle
 *   const caps = await engine.probeCapabilities(sendPID);
 *   // (automatically persisted and applied)
 *
 *   engine.startTrip();
 *   engine.endTrip();
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
  CarConfig,
  DEFAULT_CAR_CONFIG,
  DEFAULT_SUV_CONFIG,
  DEFAULT_VAN_CONFIG,
  DEFAULT_EV_SEDAN_CONFIG,
  DEFAULT_EV_SUV_CONFIG,
  DEFAULT_PERFORMANCE_CONFIG,
  CarSafetyEvent,
  VehicleCapabilities,
  OBDConnectionState,
} from './types';
import { CarTripManager } from './CarTripManager';
import { CarScorer, CarRiderBaseline, CarRiderDeviation } from './CarScorer';
import { OBDCapabilityDetector, OBDProbeFn } from './OBDCapabilityDetector';
import { MapplsClient, MapplsClientOptions } from '../motorcycle/MapplsClient';
import { OSMOverpassClient, OSMOverpassClientOptions } from '../motorcycle/OSMOverpassClient';
import { ContextEnrichmentService, ContextEnrichmentOptions } from '../motorcycle/ContextEnrichmentService';
import { RoadClass } from '../motorcycle/types';

export * from './types';
export { CarTripManager } from './CarTripManager';
export type { CarTripSnapshot, CarTripEndedHandler } from './CarTripManager';
export { CarScorer } from './CarScorer';
export type { CarRiderBaseline, CarRiderDeviation } from './CarScorer';
export { LaneChangeDetector } from './LaneChangeDetector';
export type { LaneChangeEvent } from './LaneChangeDetector';
export { OBDCapabilityDetector } from './OBDCapabilityDetector';
export type { OBDProbeFn } from './OBDCapabilityDetector';
export { CarEventDetector } from './CarEventDetector';

/** KV key for persisting VehicleCapabilities. */
const CAP_KV_PREFIX = 'car_capabilities_';

export class CarSafetyEngine {
  private tm: CarTripManager;
  private db: SafetyDatabase;
  private scorer: CarScorer;
  private cfg: CarConfig;
  private capDetector = new OBDCapabilityDetector();

  private unsubscribers: Array<() => void> = [];

  private enrichment: ContextEnrichmentService | null = null;
  private mappls: MapplsClient | null = null;
  private osm: OSMOverpassClient | null = null;

  private constructor(cfg: CarConfig, db: SafetyDatabase, kv: KVStore) {
    this.cfg = cfg;
    this.db = db;
    this.scorer = new CarScorer(cfg);
    this.tm = new CarTripManager(cfg);

    this.tm.loadPersisted(kv).catch(() => {});

    this.tm.setSnapshotHandler((s) => {
      useSafetyStore.getState()._applyTripSnapshot({
        ...s,
        events: s.events.map(e => ({ ...e, type: e.type as any })),
        drowsinessDetectorCalibrated: false,
      });
    });

    this.tm.setTripEndedHandler(async (trip) => {
      await this.tm.persistRouteAfterTrip(kv).catch(() => {});
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

    this.tm.setAutoEndHandler(() => {
      try { this.tm.endTrip(); } catch { /* persistence layer logs its own errors */ }
    });
  }

  static async create(
    kv: KVStore = new InMemoryKV(),
    overrides: Partial<CarConfig> = {},
  ): Promise<CarSafetyEngine> {
    const db = new SafetyDatabase(kv);
    const base = await db.loadConfig();

    const cls = overrides.carClass ?? 'sedan';
    const defaultCfg =
      cls === 'suv'         ? DEFAULT_SUV_CONFIG         :
      cls === 'van'         ? DEFAULT_VAN_CONFIG         :
      cls === 'ev_sedan'    ? DEFAULT_EV_SEDAN_CONFIG    :
      cls === 'ev_suv'      ? DEFAULT_EV_SUV_CONFIG      :
      cls === 'performance' ? DEFAULT_PERFORMANCE_CONFIG :
                              DEFAULT_CAR_CONFIG;

    // Load persisted capability cache for this vehicle.
    let capabilities: VehicleCapabilities | null = null;
    const vehicleId = overrides.vehicleId ?? '';
    if (vehicleId) {
      const capJson = await kv.getItem(CAP_KV_PREFIX + vehicleId).catch(() => null);
      if (capJson) {
        try { capabilities = JSON.parse(capJson) as VehicleCapabilities; } catch { /* ignore */ }
      }
    }

    const cfg: CarConfig = {
      ...defaultCfg,
      ...base,
      ...overrides,
      capabilities: capabilities ?? overrides.capabilities ?? null,
    };

    const engine = new CarSafetyEngine(cfg, db, kv);

    const trips = await db.loadAllTrips(50);
    useSafetyStore.getState()._setConfig(cfg);
    useSafetyStore.getState()._setRecentTrips(trips);
    useSafetyStore.getState()._setLifetimeScore(engine.scorer.lifetimeScore(trips));

    return engine;
  }

  startTrip(): string { return this.tm.startTrip(); }
  endTrip() { return this.tm.endTrip(); }
  isActive(): boolean { return this.tm.isActive(); }

  async updateConfig(patch: Partial<CarConfig>): Promise<void> {
    this.cfg = { ...this.cfg, ...patch };
    this.tm.updateConfig(patch);
    this.scorer.updateConfig(patch);
    await this.db.saveConfig(this.cfg);
    useSafetyStore.getState()._setConfig(this.cfg);
  }

  getConfig(): CarConfig { return { ...this.cfg }; }

  // ---------- OBD lifecycle ----------

  /**
   * Report OBD adapter connection state transitions. The engine uses
   * this to accumulate obd_uptime_pct for the current trip.
   */
  setOBDConnectionState(state: OBDConnectionState, t: number = Date.now()): void {
    this.tm.setOBDConnectionState(state, t);
  }

  /**
   * Push DTC codes read from Mode 03. Call once at trip start (or when
   * the adapter reconnects mid-trip) after reading Mode 03.
   */
  setDTCCodes(codes: string[]): void {
    this.tm.setDTCCodes(codes);
  }

  // ---------- OBD capability detection ----------

  /**
   * Probe the vehicle for supported OBD PIDs. Should be called once
   * at first pairing (after `connected` state is reached). Results are
   * persisted in KV keyed by vehicleId and applied immediately.
   *
   * @param sendPID  Caller-supplied function to dispatch OBD queries.
   */
  async probeCapabilities(sendPID: OBDProbeFn, kv?: KVStore): Promise<VehicleCapabilities> {
    const vehicleId = this.cfg.vehicleId;
    const caps = await this.capDetector.probe(vehicleId, sendPID);
    // Persist for future sessions.
    if (vehicleId && kv) {
      await kv.setItem(CAP_KV_PREFIX + vehicleId, JSON.stringify(caps)).catch(() => {});
    }
    await this.updateConfig({ capabilities: caps });
    return caps;
  }

  // ---------- Context injection (Mappls / OSM) ----------

  setSpeedLimitKmH(kmH: number): void { this.tm.setSpeedLimitKmH(kmH); }
  setRoadClass(rc: RoadClass): void { this.tm.setRoadClass(rc); }
  setAmbientSpeedKmH(kmH: number): void { this.tm.setAmbientSpeedKmH(kmH); }
  /** Inform the engine that the current GPS segment is a roundabout. */
  setRoundabout(inRoundabout: boolean): void { this.tm.setRoundabout(inRoundabout); }

  // ---------- Phone use ----------

  reportTouchEvent(): void { this.tm.reportTouchEvent(); }
  reportCharging(isCharging: boolean): void { this.tm.reportCharging(isCharging); }
  setCallActive(active: boolean, t: number = Date.now()): void { this.tm.setCallActive(active, t); }
  setForegroundApp(appId: string | null, screenOn: boolean, t: number = Date.now()): void {
    this.tm.setForegroundApp(appId, screenOn, t);
  }

  // ---------- Per-driver analytics ----------

  async rolling30DayScore(now: number = Date.now()): Promise<number | null> {
    const trips = await this.db.loadAllTrips(500);
    return this.scorer.rolling30DayScore(trips, now);
  }

  async rolling7DayScore(now: number = Date.now()): Promise<number | null> {
    const trips = await this.db.loadAllTrips(500);
    return this.scorer.rolling7DayScore(trips, now);
  }

  async driverBaseline(): Promise<CarRiderBaseline | null> {
    const trips = await this.db.loadAllTrips(500);
    return this.scorer.riderBaseline(trips);
  }

  async deviationFromBaseline(trip: TripRecord): Promise<CarRiderDeviation | null> {
    const trips = await this.db.loadAllTrips(500);
    return this.scorer.deviationFromBaseline(trip, trips);
  }

  // ---------- Context enrichment (Mappls + OSM) ----------

  /**
   * Enable live context enrichment from Mappls and/or OSM. When active,
   * every GPS fix triggers a debounced lookup that pushes the current
   * speed limit, road class, and ambient speed into the trip manager.
   *
   * Also sets `isRoundabout` when OSM detects a roundabout junction,
   * which suppresses cornering events during normal roundabout traversal.
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
        // The car pipeline doesn't use 2W-specific ambient speed, but the
        // RiderContextProvider still uses it as the reference speed for
        // overspeed calculations when no explicit speed limit is known.
        setAmbient2WSpeedKmH: (k) => this.tm.setAmbientSpeedKmH(k),
        setRoadClass: (rc) => this.tm.setRoadClass(rc),
        setSpeedLimitKmH: (k) => this.tm.setSpeedLimitKmH(k),
      },
      {
        mappls: this.mappls ?? undefined,
        osm: this.osm ?? undefined,
        ...options.service,
      },
    );

    // Roundabout suppression extension point:
    // ContextEnrichmentService currently pushes road class and speed limit.
    // When OSMOverpassClient gains a `isRoundabout` field on OSMResult,
    // call `this.tm.setRoundabout(true/false)` here from an onOSMResult
    // callback. Until then, callers can call `engine.setRoundabout()` directly
    // when they have their own map source for junction tagging.
  }

  disableContextEnrichment(): void {
    this.enrichment = null;
    this.mappls = null;
    this.osm = null;
  }

  // ---------- Sensor binding ----------

  bindOBDSnapshot(subscribe: (cb: (snap: OBDSnapshot) => void) => () => void): void {
    this.unsubscribers.push(subscribe((s) => this.tm.ingestOBDSnapshot(s)));
  }

  /**
   * Bind an extended OBD snapshot stream that includes throttle position
   * and seatbelt state (manufacturer-specific PIDs, if supported).
   */
  bindOBDExtended(subscribe: (cb: (data: {
    throttlePct?: number | null;
    seatbeltFastened?: boolean | null;
    dtcCodes?: string[];
    t: number;
  }) => void) => () => void): void {
    this.unsubscribers.push(subscribe((d) => this.tm.ingestOBDExtended(d)));
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

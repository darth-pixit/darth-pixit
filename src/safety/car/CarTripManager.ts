/**
 * CarTripManager — orchestrates the 4W fleet safety pipeline.
 *
 * Key responsibilities vs the motorcycle pipeline:
 *
 *   1. OBD IS PRIMARY: speed is sourced from OBD when fresh (< 500ms),
 *      GPS Kalman is the fallback. OBD uptime is tracked per trip.
 *
 *   2. OBD LIFECYCLE: the caller reports state transitions via
 *      setOBDConnectionState(). The manager accumulates connected time
 *      for the obd_uptime_pct feature.
 *
 *   3. DTC READ AT TRIP START: caller pushes DTC codes via setDTCCodes().
 *      Safety-critical codes flag the trip; it will be excluded from
 *      comparative fleet ranking.
 *
 *   4. TRIP STITCHING: 600 s at < 2 km/h auto-ends the trip (vs 300 s
 *      for 2W). Fleet drivers have longer delivery pauses.
 *
 *   5. LANE CHANGE SCORING: wired from the CarEventDetector.
 *
 *   6. PHONE USE: same mechanics as the 2W pipeline (handheld signature,
 *      distraction by foreground app, texting by touch rate, voice call).
 *
 *   7. BATTERY BUDGET: 12h vs 8h for 2W. The engine reduces GPS polling
 *      frequency when battery is critically low (< 10%). Implementation
 *      is advisory — the caller checks shouldReduceGPSRate() and acts.
 */

import {
  AccelerometerSample,
  GyroscopeSample,
  GPSPoint,
  CrashReport,
  TripRecord,
  TripStatus,
  DrowsinessSignal,
  WearSignal,
  WeatherSnapshot,
  RouteContext,
  SafetyScore,
  OBDSnapshot,
} from '../types';
import { SensorFusion } from '../SensorFusion';
import { GPSTracker } from '../GPSTracker';
import { OBDWearMonitor } from '../OBDWearMonitor';
import { DrowsinessDetector } from '../DrowsinessDetector';
import { WeatherContext } from '../WeatherContext';
import { RouteTracker } from '../RouteTracker';
import { RecoveryTracker } from '../RecoveryTracker';
import { KVStore } from '../SafetyDatabase';
import { CrashReporter } from '../CrashReporter';

import { CarConfig, CarSafetyEvent, CarTripFeatures, OBDConnectionState } from './types';
import { CarEventDetector } from './CarEventDetector';
import { CarScorer } from './CarScorer';
import { GPSKalmanFilter } from '../motorcycle/GPSKalmanFilter';
import { PhonePositionClassifier } from '../motorcycle/PhonePositionClassifier';
import { RiderContextProvider, bucketTimeOfDay } from '../motorcycle/RiderContextProvider';
import { RoadClass } from '../motorcycle/types';

export interface CarTripSnapshot {
  status: TripStatus;
  tripId: string | null;
  startedAt: number | null;
  distanceM: number;
  events: CarSafetyEvent[];
  liveScore: SafetyScore | null;
  currentSpeedKmH: number;
  crashSuspected: boolean;
  obdConnectionState: OBDConnectionState;
  obdUptimePct: number;
  wearSignals: WearSignal[];
  drowsinessEvents: DrowsinessSignal[];
  weather: WeatherSnapshot | null;
  routeContext: RouteContext | null;
  carFeatures: CarTripFeatures;
}

export type CarSnapshotHandler = (s: CarTripSnapshot) => void;
export type CarTripEndedHandler = (
  t: TripRecord & {
    carEvents: CarSafetyEvent[];
    carFeatures: CarTripFeatures;
    /** True if trip is too short/brief for scoring (spec §2.4). */
    dropped: boolean;
  },
) => void;

export class CarTripManager {
  private cfg: CarConfig;

  private fusion = new SensorFusion();
  private gps = new GPSTracker();
  private detector: CarEventDetector;
  private wear: OBDWearMonitor;
  private drowsiness: DrowsinessDetector;
  private weather: WeatherContext;
  private route: RouteTracker;
  private recovery: RecoveryTracker;
  private scorer: CarScorer;
  private crash: CrashReporter;

  private kalman: GPSKalmanFilter;
  private phoneClassifier = new PhonePositionClassifier();
  private context: RiderContextProvider;

  // ---- OBD lifecycle tracking ----
  private obdState: OBDConnectionState = 'disconnected';
  private obdConnectedSinceT = 0;
  private obdTotalConnectedMs = 0;
  private tripStartT = 0;

  // ---- DTC ----
  private activeDTCCodes: string[] = [];
  private dtcSafetyCritical = false;

  // ---- Phone-use event tracking ----
  private phoneUseOpenStartT = 0;
  private phoneUseOpenSubtype = '';
  private phoneCallActive = false;
  private callEventStartT = 0;
  private phoneUseSecondsTotal = 0;
  private movingSecondsTotal = 0;

  // ---- Phone-position aggregation ----
  private posCounts = { mounted: 0, held: 0, pocket: 0, bag: 0, unknown: 0 };

  // ---- Distraction / texting tracking ----
  private foregroundAppId: string | null = null;
  private foregroundScreenOn = false;
  private distractionOpenStartT = 0;
  private textingOpenStartT = 0;

  // ---- Trip stitching (600 s for 4W) ----
  private idleSinceT = 0;
  private lastMovingT = 0;
  private onAutoEnd: (() => void) | null = null;

  // ---- Coasting (throttle = 0% while moving) ----
  private coastingSamples = 0;
  private totalOBDSamples = 0;

  // ---- Aggregate counters ----
  private laneChangeCount = 0;
  private engineAbuseCount = 0;
  private seatbeltOffEvents = 0;
  private idlingEvents = 0;
  private idlingTotalS = 0;
  private peakSpeedKmH = 0;
  private peakRPM = 0;

  // ---- Active trip state ----
  private status: TripStatus = 'idle';
  private tripId: string | null = null;
  private startedAt: number | null = null;
  private events: CarSafetyEvent[] = [];
  private crashReport: CrashReport | null = null;
  private crashSuspected = false;
  private wearSignals: WearSignal[] = [];
  private drowsinessEvents: DrowsinessSignal[] = [];
  private activeDurationMs = 0;
  private lastActiveT = 0;
  private weatherSnapshot: WeatherSnapshot | null = null;
  private routeContext: RouteContext | null = null;

  private snapshotHandler: CarSnapshotHandler | null = null;
  private tripEndedHandler: CarTripEndedHandler | null = null;

  private idCounter = 0;
  private lastOBDSpeedT = 0;

  constructor(cfg: CarConfig) {
    this.cfg = cfg;

    const locGetter = () => {
      const last = this.gps.getLast();
      return last ? { lat: last.lat, lng: last.lng } : null;
    };

    this.kalman = new GPSKalmanFilter({
      settlingSeconds: cfg.gpsSettlingSeconds,
      maxAccuracyM: cfg.gpsMaxAccuracyM,
      processNoise: cfg.gpsKalmanProcessNoise,
    });

    this.context = new RiderContextProvider({
      todDayWeight: cfg.todDayWeight,
      todDuskWeight: cfg.todDuskWeight,
      todNightWeight: cfg.todNightWeight,
    });

    this.detector = new CarEventDetector(cfg, locGetter);
    this.detector.setListener((ev) => this.onEvent(ev));

    this.crash = new CrashReporter(cfg, locGetter, () => this.gps.getRecent());
    this.crash.setHandlers(
      ({ t, peakG }) => {
        this.crashSuspected = true;
        this.events.push({
          id: `crash_s_${t}_${++this.idCounter}`,
          type: 'crash', startedAt: t, endedAt: t,
          peak: peakG, severity: 5, location: locGetter(),
          meta: { state: 'suspected' },
        });
        this.pushSnapshot();
      },
      (report) => {
        this.crashReport = report;
        this.crashSuspected = false;
        const existing = this.events.find(e => e.type === 'crash' && e.meta?.state === 'suspected');
        if (existing) {
          existing.meta = {
            state: 'confirmed', peakG: report.peakG,
            featuresTriggered: report.featuresTriggered,
          };
        }
        this.pushSnapshot();
      },
    );

    this.wear = new OBDWearMonitor(locGetter, cfg);
    this.wear.setListener((s) => { this.wearSignals.push(s); this.pushSnapshot(); });

    this.drowsiness = new DrowsinessDetector(cfg);
    this.drowsiness.setListener((signal) => {
      this.drowsinessEvents.push(signal);
      this.events.push({
        id: `drowsy_${signal.detectedAt}_${++this.idCounter}`,
        type: 'drowsy_driving',
        startedAt: signal.detectedAt,
        endedAt: signal.detectedAt + signal.durationMs,
        peak: signal.durationMs / 1000,
        severity: signal.varianceRatio >= 4 ? 4 : signal.varianceRatio >= 3 ? 3 : 2,
        location: locGetter(),
        meta: { varianceRatio: signal.varianceRatio, speedKmH: signal.speedKmH },
      });
      this.pushSnapshot();
    });

    this.weather = new WeatherContext(cfg);
    this.route = new RouteTracker(cfg);
    this.recovery = new RecoveryTracker(cfg);
    this.scorer = new CarScorer(cfg);
  }

  setSnapshotHandler(h: CarSnapshotHandler): void { this.snapshotHandler = h; }
  setTripEndedHandler(h: CarTripEndedHandler): void { this.tripEndedHandler = h; }

  setAutoEndHandler(fn: (() => void) | null): void { this.onAutoEnd = fn; }

  getLastGPS(): { lat: number; lng: number; t: number } | null {
    const last = this.gps.getLast();
    return last ? { lat: last.lat, lng: last.lng, t: last.t } : null;
  }

  updateConfig(patch: Partial<CarConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.detector.updateConfig(patch);
    this.wear.updateConfig(patch);
    this.drowsiness.updateConfig(patch);
    this.weather.updateConfig(patch);
    this.route.updateConfig(patch);
    this.recovery.updateConfig(patch);
    this.scorer.updateConfig(patch);
    this.context.updateOptions({
      todDayWeight: this.cfg.todDayWeight,
      todDuskWeight: this.cfg.todDuskWeight,
      todNightWeight: this.cfg.todNightWeight,
    });
  }

  // ---------- Context injection (Mappls / OSM) ----------

  setSpeedLimitKmH(kmH: number): void {
    this.context.setSpeedLimit(kmH);
    this.detector.setSpeedLimitKmH(kmH);
  }

  setRoadClass(rc: RoadClass): void { this.context.setRoadClass(rc); }
  setAmbientSpeedKmH(kmH: number): void { this.context.setAmbient2WSpeed(kmH); }
  setRoundabout(inRoundabout: boolean): void { this.detector.setRoundabout(inRoundabout); }

  // ---------- OBD lifecycle ----------

  setOBDConnectionState(state: OBDConnectionState, t: number = Date.now()): void {
    const wasConnected =
      this.obdState === 'connected' || this.obdState === 'degraded';
    const isConnected = state === 'connected' || state === 'degraded';

    if (!wasConnected && isConnected) {
      this.obdConnectedSinceT = t;
    } else if (wasConnected && !isConnected && this.obdConnectedSinceT > 0) {
      this.obdTotalConnectedMs += t - this.obdConnectedSinceT;
      this.obdConnectedSinceT = 0;
    }
    this.obdState = state;
  }

  // ---------- DTC ----------

  /**
   * Push DTC codes read from Mode 03 at trip start. The manager flags
   * the trip as safety-critical if any code matches the configured
   * safety-critical prefixes.
   */
  setDTCCodes(codes: string[]): void {
    this.activeDTCCodes = codes;
    this.dtcSafetyCritical = codes.some((c) =>
      this.cfg.dtcSafetyCriticalPrefixes.some((p) => c.toUpperCase().startsWith(p)),
    );
  }

  // ---------- Phone-use injection ----------

  reportTouchEvent(): void { this.phoneClassifier.recordTouch(); }
  reportCharging(isCharging: boolean): void { this.phoneClassifier.setCharging(isCharging); }

  setCallActive(active: boolean, t: number = Date.now()): void {
    if (active && !this.phoneCallActive) {
      this.phoneCallActive = true;
      this.callEventStartT = t;
    } else if (!active && this.phoneCallActive) {
      this.phoneCallActive = false;
      this.maybeEmitCallEvent(t);
    }
  }

  setForegroundApp(appId: string | null, screenOn: boolean, t: number = Date.now()): void {
    this.foregroundAppId = appId;
    this.foregroundScreenOn = screenOn;
    this.updateDistractionState(t);
  }

  // ---------- Route persistence ----------

  async loadPersisted(kv: KVStore): Promise<void> {
    await this.route.load(kv);
  }

  // ---------- Trip lifecycle ----------

  startTrip(t: number = Date.now()): string {
    if (this.status === 'active') return this.tripId!;

    this.fusion.reset();
    this.gps.reset();
    this.detector.reset();
    this.crash.reset();
    this.wear.reset();
    this.drowsiness.reset();
    this.kalman.reset();
    this.phoneClassifier.reset();
    this.context.reset();

    this.events = [];
    this.crashReport = null;
    this.crashSuspected = false;
    this.wearSignals = [];
    this.drowsinessEvents = [];
    this.activeDurationMs = 0;
    this.lastActiveT = 0;
    this.weatherSnapshot = null;
    this.routeContext = null;

    this.obdTotalConnectedMs = 0;
    this.obdConnectedSinceT = 0;
    this.tripStartT = t;
    this.activeDTCCodes = [];
    this.dtcSafetyCritical = false;

    this.phoneUseOpenStartT = 0;
    this.phoneUseOpenSubtype = '';
    this.phoneCallActive = false;
    this.callEventStartT = 0;
    this.phoneUseSecondsTotal = 0;
    this.movingSecondsTotal = 0;
    this.posCounts = { mounted: 0, held: 0, pocket: 0, bag: 0, unknown: 0 };

    this.distractionOpenStartT = 0;
    this.textingOpenStartT = 0;
    this.foregroundAppId = null;
    this.foregroundScreenOn = false;

    this.idleSinceT = 0;
    this.lastMovingT = 0;

    this.coastingSamples = 0;
    this.totalOBDSamples = 0;
    this.laneChangeCount = 0;
    this.engineAbuseCount = 0;
    this.seatbeltOffEvents = 0;
    this.idlingEvents = 0;
    this.idlingTotalS = 0;
    this.peakSpeedKmH = 0;
    this.peakRPM = 0;

    this.tripId = `car_trip_${t}_${++this.idCounter}`;
    this.startedAt = t;
    this.status = 'active';
    this.pushSnapshot();
    return this.tripId;
  }

  endTrip(t: number = Date.now()): (TripRecord & { carEvents: CarSafetyEvent[] }) | null {
    if (this.status !== 'active' || !this.tripId || !this.startedAt) return null;

    this.detector.flush(t);
    this.crash.flush(t);

    // Close any open phone-use events.
    if (this.phoneUseOpenStartT !== 0) {
      const durMs = t - this.phoneUseOpenStartT;
      if (durMs >= this.cfg.phoneUseMinDurationS * 1000) {
        this.emitPhoneUseEvent(this.phoneUseOpenStartT, t, this.phoneUseOpenSubtype,
          this.fusion.getCurrentSpeedMPS() * 3.6);
      }
      this.phoneUseOpenStartT = 0;
    }
    if (this.phoneCallActive) this.maybeEmitCallEvent(t);

    // Close OBD connection tracking.
    if (this.obdConnectedSinceT > 0) {
      this.obdTotalConnectedMs += t - this.obdConnectedSinceT;
      this.obdConnectedSinceT = 0;
    }

    this.status = 'ended';

    const distanceM  = this.gps.getDistanceM();
    const durationS  = (t - this.startedAt) / 1000;
    const trail      = this.gps.getTrail();
    const tripDurMs  = t - this.tripStartT;

    if (this.route.isLoaded()) this.routeContext = this.route.evaluate(trail);

    const droppedTooShort =
      distanceM < this.cfg.tripMinDistanceM ||
      durationS < this.cfg.tripMinDurationS;

    const recoveredIds = this.recovery.computeRecoveredIds(
      this.events.map(e => ({ ...e, type: e.type as any }))
    );

    const score = droppedTooShort
      ? null
      : this.scorer.scoreTrip(this.events, distanceM, this.crashReport !== null, {
          recoveredEventIds: recoveredIds,
          graceFactor: this.routeContext?.graceFactor ?? 1.0,
          weatherCondition: this.weatherSnapshot?.condition ?? null,
        });

    const carFeatures = this.buildCarFeatures(tripDurMs);

    const record = {
      id: this.tripId,
      startedAt: this.startedAt,
      endedAt: t,
      distanceM,
      activeDurationMs: this.activeDurationMs,
      events: this.events.map(e => ({ ...e, type: e.type as any })),
      trail,
      score,
      crash: this.crashReport,
      wearSignals: this.wearSignals.slice(),
      drowsinessEvents: this.drowsinessEvents.slice(),
      weatherContext: this.weatherSnapshot,
      routeContext: this.routeContext,
      carEvents: this.events.slice(),
      carFeatures,
      dropped: droppedTooShort,
    };

    this.tripEndedHandler?.(record);
    this.pushSnapshot();
    return record;
  }

  isActive(): boolean { return this.status === 'active'; }

  // ---------- Sensor ingestion ----------

  ingestOBDSnapshot(snap: OBDSnapshot): void {
    if (this.status !== 'active') return;

    this.wear.ingest({
      rpm: snap.rpm, engineLoadPct: snap.engineLoadPct,
      coolantC: snap.coolantC, t: snap.t,
    });

    if (snap.rpm !== null && snap.rpm > this.peakRPM) this.peakRPM = snap.rpm;

    // Track coasting ratio (throttle = 0% while moving).
    // We use OBD speed here as a proxy; if RPM > idle and speed > 0, we
    // can infer throttle state only if throttle PID is available.
    this.totalOBDSamples++;

    // Push to event detector.
    this.detector.ingestOBD({
      rpm: snap.rpm,
      speedKmH: snap.speedKmH,
      engineLoadPct: snap.engineLoadPct,
      coolantC: snap.coolantC,
      t: snap.t,
    });

    if (snap.speedKmH !== null) {
      this.lastOBDSpeedT = snap.t;
      const longAccel = this.fusion.ingestSpeed(snap.speedKmH / 3.6, snap.t);
      this.crash.ingestSpeed(snap.speedKmH, snap.t);
      this.drowsiness.updateSpeed(snap.speedKmH);
      this.accumulateActive(snap.speedKmH, snap.t);
      this.runDetectorTick(longAccel, snap.speedKmH, null, snap.t);
    }
  }

  /**
   * Inject a parsed extended OBD snapshot when the caller has access to
   * throttle position and seatbelt state (manufacturer PIDs).
   */
  ingestOBDExtended(data: {
    throttlePct?: number | null;
    seatbeltFastened?: boolean | null;
    dtcCodes?: string[];
    t: number;
  }): void {
    if (this.status !== 'active') return;
    if (data.dtcCodes !== undefined) this.setDTCCodes(data.dtcCodes);
    if (data.throttlePct !== undefined && data.throttlePct !== null) {
      this.totalOBDSamples++;
      if (data.throttlePct < 2) this.coastingSamples++;
    }
    this.detector.ingestOBD({
      throttlePct: data.throttlePct ?? null,
      seatbeltFastened: data.seatbeltFastened ?? null,
      t: data.t,
    });
  }

  ingestGPS(point: GPSPoint): void {
    if (this.status !== 'active') return;

    const kal = this.kalman.ingest(point);
    const useKalman = kal.settled && !kal.rejected;
    const headingDeg = useKalman ? kal.headingDeg : point.headingDeg;

    const { accepted } = this.gps.ingest(point);
    if (!accepted) return;

    // Push altitude for engine-braking grade estimation.
    if (point.altitudeM !== null) {
      this.detector.ingestAltitude(point.altitudeM, this.gps.getDistanceM());
    }

    if (!this.weatherSnapshot && this.cfg.enableWeatherAPI) {
      this.weather.fetch(point.lat, point.lng, point.accuracyM).then((snap) => {
        if (snap) {
          this.weatherSnapshot = snap;
          this.applyWeatherToDetector(snap);
          this.pushSnapshot();
        }
      }).catch(() => {});
    }

    if (!this.routeContext && this.route.isLoaded() && this.gps.getDistanceM() >= 2000) {
      this.routeContext = this.route.evaluate(this.gps.getTrail());
    }

    const obdStale = point.t - this.lastOBDSpeedT > this.cfg.obdFreshnessMs;
    if (obdStale && point.speedMPS !== null) {
      const speedMPS = useKalman ? kal.speedMPS : point.speedMPS;
      const speedKmH = speedMPS * 3.6;
      const longAccel = this.fusion.ingestSpeed(speedMPS, point.t);
      this.crash.ingestSpeed(speedKmH, point.t);
      this.drowsiness.updateSpeed(speedKmH);
      this.accumulateActive(speedKmH, point.t);
      this.runDetectorTick(longAccel, speedKmH, headingDeg, point.t);
    }

    if (headingDeg !== null) {
      const lateral = this.fusion.ingestHeading(headingDeg, point.t);
      // Lane change detector needs the heading for S-shape net-heading check.
      // The tick() call inside runDetectorTick already handles it via lateral.
    }

    if (useKalman) {
      const speedKmH = kal.speedMPS * 3.6;
      if (speedKmH > this.peakSpeedKmH) this.peakSpeedKmH = speedKmH;
      this.context.recordSpeed(speedKmH);
    }
  }

  ingestAccelerometer(sample: AccelerometerSample): void {
    if (this.status !== 'active') return;
    const linearMag = this.fusion.ingestAccelerometer(sample);
    this.crash.ingestAccel(sample, linearMag);
    const gravity = this.fusion.getGravity();
    const snap = this.phoneClassifier.ingest(sample, gravity, this.fusion.getLongitudinalAccel());
    this.accumulatePhonePos(snap.state);
    this.updatePhoneUseMotionSignature(linearMag, sample.t);
  }

  ingestGyroscope(sample: GyroscopeSample): void {
    if (this.status !== 'active') return;
    this.drowsiness.ingest(sample);
    // Base CrashReporter does not have a gyroscope path (car crash detection
    // relies on linear accel + speed drop, not gyro like 2W).
  }

  onAppBackground(t: number = Date.now()): void { void t; /* no moto lean/crash equivalent */ }
  onAppForeground(t: number = Date.now()): void { void t; }

  async persistRouteAfterTrip(kv: KVStore): Promise<void> {
    const trail = this.gps.getTrail();
    if (trail.length > 0) { this.route.recordTrail(trail); await this.route.persist(kv); }
  }

  // ---------- internals ----------

  private runDetectorTick(longAccel: number, speedKmH: number, headingDeg: number | null, t: number): void {
    const lateral = this.fusion.getLateralAccel();
    this.detector.tick(longAccel, lateral, speedKmH, headingDeg, t);
    this.updateTripStitching(speedKmH, t);
    this.updateTextingState(speedKmH, t);
    this.updateDistractionState(t);
    this.pushSnapshot();
  }

  private updateTripStitching(speedKmH: number, t: number): void {
    const idleMs = this.cfg.tripIdleEndSeconds * 1000;
    if (speedKmH >= this.cfg.tripIdleSpeedKmH) {
      this.idleSinceT = 0;
      this.lastMovingT = t;
      return;
    }
    if (this.idleSinceT === 0) { this.idleSinceT = t; return; }
    if (t - this.idleSinceT >= idleMs && this.onAutoEnd) {
      const handler = this.onAutoEnd;
      this.onAutoEnd = null;
      try { handler(); } catch { /* ignore */ }
    }
  }

  private accumulateActive(speedKmH: number, t: number): void {
    if (this.lastActiveT > 0 && speedKmH > 1) {
      const dt = t - this.lastActiveT;
      if (dt > 0 && dt < 5000) {
        this.activeDurationMs += dt;
        this.movingSecondsTotal += dt / 1000;
      }
    }
    this.lastActiveT = t;
  }

  private accumulatePhonePos(state: 'mounted' | 'held' | 'pocket' | 'bag' | 'unknown'): void {
    this.posCounts[state]++;
  }

  private updatePhoneUseMotionSignature(linearMag: number, t: number): void {
    const speedKmH = this.fusion.getCurrentSpeedMPS() * 3.6;
    const pos = this.phoneClassifier.get();
    const handheld =
      (pos.state === 'held' && pos.confidence >= this.cfg.phonePositionMinConfidence) ||
      (linearMag > 0.7 && speedKmH >= this.cfg.phoneUseMinSpeedKmH);

    if (handheld) {
      if (this.phoneUseOpenStartT === 0) {
        this.phoneUseOpenStartT = t;
        this.phoneUseOpenSubtype = pos.state === 'held' ? 'handheld' : 'distraction';
      }
    } else if (this.phoneUseOpenStartT !== 0) {
      const durMs = t - this.phoneUseOpenStartT;
      if (durMs >= this.cfg.phoneUseMinDurationS * 1000) {
        this.emitPhoneUseEvent(this.phoneUseOpenStartT, t, this.phoneUseOpenSubtype, speedKmH);
      }
      this.phoneUseOpenStartT = 0;
      this.phoneUseOpenSubtype = '';
    }
  }

  private maybeEmitCallEvent(t: number): void {
    const durMs = t - this.callEventStartT;
    const speedKmH = this.fusion.getCurrentSpeedMPS() * 3.6;
    if (speedKmH >= this.cfg.phoneUseCallMinSpeedKmH &&
        durMs >= this.cfg.phoneUseCallMinDurationS * 1000) {
      this.emitPhoneUseEvent(this.callEventStartT, t, 'call', speedKmH);
    }
    this.callEventStartT = 0;
  }

  private emitPhoneUseEvent(
    startedAt: number,
    endedAt: number,
    subtype: string,
    speedKmH: number,
    extra: Record<string, number | string | boolean> = {},
  ): void {
    const ctx = this.context.getContext();
    const dur = (endedAt - startedAt) / 1000;
    this.phoneUseSecondsTotal += dur;
    const pos = this.phoneClassifier.get();
    const severity: 1|2|3|4|5 =
      subtype === 'texting' ? 4 :
      dur >= 30 ? 4 : dur >= 15 ? 3 : dur >= 5 ? 2 : 1;
    this.events.push({
      id: `phone_${endedAt}_${++this.idCounter}`,
      type: 'phone_use',
      startedAt,
      endedAt,
      peak: dur,
      severity,
      location: (() => { const l = this.gps.getLast(); return l ? { lat: l.lat, lng: l.lng } : null; })(),
      meta: {
        subtype,
        speedKmH: round2(speedKmH),
        durationS: round2(dur),
        phonePositionState: pos.state,
        phonePositionConf: pos.confidence,
        timeOfDay: ctx.timeOfDay,
        timeOfDayWeight: ctx.timeOfDayWeight,
        ...extra,
      },
    });
    this.pushSnapshot();
  }

  private updateDistractionState(t: number): void {
    if (this.status !== 'active') return;
    const speedKmH = this.fusion.getCurrentSpeedMPS() * 3.6;
    const appId = this.foregroundAppId;
    const whitelisted = appId !== null && this.cfg.deliveryAppIds.includes(appId);
    const isDistraction =
      this.foregroundScreenOn && appId !== null && !whitelisted &&
      speedKmH >= this.cfg.phoneUseMinSpeedKmH;

    if (isDistraction) {
      if (this.distractionOpenStartT === 0) this.distractionOpenStartT = t;
    } else if (this.distractionOpenStartT !== 0) {
      const durMs = t - this.distractionOpenStartT;
      if (durMs >= this.cfg.phoneUseMinDurationS * 1000) {
        this.emitPhoneUseEvent(this.distractionOpenStartT, t, 'distraction', speedKmH,
          { app: appId ?? 'unknown' });
      }
      this.distractionOpenStartT = 0;
    }
  }

  private updateTextingState(speedKmH: number, t: number): void {
    const rate = this.phoneClassifier.getTouchRatePerSec();
    const isTexting = speedKmH >= this.cfg.phoneUseMinSpeedKmH &&
      rate >= this.cfg.phoneUseTouchesPerSec;

    if (isTexting) {
      if (this.textingOpenStartT === 0) this.textingOpenStartT = t;
    } else if (this.textingOpenStartT !== 0) {
      const durMs = t - this.textingOpenStartT;
      if (durMs >= this.cfg.phoneUseMinDurationS * 1000) {
        this.emitPhoneUseEvent(this.textingOpenStartT, t, 'texting', speedKmH,
          { touchesPerSec: round2(rate) });
      }
      this.textingOpenStartT = 0;
    }
  }

  private onEvent(ev: CarSafetyEvent): void {
    if (ev.type === 'lane_change') this.laneChangeCount++;
    if (ev.type === 'engine_abuse') this.engineAbuseCount++;
    if (ev.type === 'seatbelt_off') this.seatbeltOffEvents++;
    if (ev.type === 'idling') {
      this.idlingEvents++;
      this.idlingTotalS += (ev.endedAt - ev.startedAt) / 1000;
    }
    this.events.push(ev);
    this.pushSnapshot();
  }

  private buildCarFeatures(tripDurMs: number): CarTripFeatures {
    const connectedMs =
      this.obdTotalConnectedMs +
      (this.obdConnectedSinceT > 0 ? Date.now() - this.obdConnectedSinceT : 0);
    const obdUptimePct = tripDurMs > 0 ? Math.min(1, connectedMs / tripDurMs) : 0;

    const totalPos = Math.max(1,
      this.posCounts.mounted + this.posCounts.held + this.posCounts.pocket +
      this.posCounts.bag + this.posCounts.unknown,
    );
    const phoneRatio = this.movingSecondsTotal > 0
      ? this.phoneUseSecondsTotal / this.movingSecondsTotal : 0;
    const coastRatio = this.totalOBDSamples > 0
      ? this.coastingSamples / this.totalOBDSamples : 0;

    return {
      obdUptimePct: round2(obdUptimePct),
      obdDegraded: obdUptimePct < this.cfg.obdDegradedUptimeThreshold,
      dtcSafetyCritical: this.dtcSafetyCritical,
      dtcCodes: this.activeDTCCodes.slice(),
      idlingEvents: this.idlingEvents,
      idlingTotalS: round2(this.idlingTotalS),
      laneChangeCount: this.laneChangeCount,
      engineAbuseCount: this.engineAbuseCount,
      peakSpeedKmH: round2(this.peakSpeedKmH),
      seatbeltOffEvents: this.seatbeltOffEvents,
      movingSeconds: round2(this.movingSecondsTotal),
      phoneUsageRatio: round2(phoneRatio),
      peakRPM: this.peakRPM,
      coastRatio: round2(coastRatio),
    };
  }

  private applyWeatherToDetector(snap: WeatherSnapshot): void {
    const factor = snap.thresholdFactor;
    this.detector.updateConfig({
      hardBrakeThreshold:  this.cfg.hardBrakeThreshold  * factor,
      hardCornerThreshold: this.cfg.hardCornerThreshold * factor,
      combinedGEventMs2:   this.cfg.combinedGEventMs2   * factor,
    });
  }

  private currentOBDUptimePct(): number {
    const tripMs = this.startedAt ? Date.now() - this.startedAt : 1;
    const connected = this.obdTotalConnectedMs +
      (this.obdConnectedSinceT > 0 ? Date.now() - this.obdConnectedSinceT : 0);
    return Math.min(1, connected / tripMs);
  }

  private pushSnapshot(): void {
    if (!this.snapshotHandler) return;
    const distanceM = this.gps.getDistanceM();
    const tripDurMs = this.startedAt ? Date.now() - this.startedAt : 0;
    this.snapshotHandler({
      status: this.status,
      tripId: this.tripId,
      startedAt: this.startedAt,
      distanceM,
      events: this.events.slice(),
      liveScore: this.status === 'active'
        ? this.scorer.scoreTrip(this.events, distanceM, this.crashReport !== null)
        : null,
      currentSpeedKmH: this.fusion.getCurrentSpeedMPS() * 3.6,
      crashSuspected: this.crashSuspected,
      obdConnectionState: this.obdState,
      obdUptimePct: this.currentOBDUptimePct(),
      wearSignals: this.wearSignals.slice(),
      drowsinessEvents: this.drowsinessEvents.slice(),
      weather: this.weatherSnapshot,
      routeContext: this.routeContext,
      carFeatures: this.buildCarFeatures(tripDurMs),
    });
  }
}

function round2(x: number): number { return Math.round(x * 100) / 100; }

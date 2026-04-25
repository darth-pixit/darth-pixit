/**
 * MotoTripManager — orchestrates the motorcycle safety pipeline.
 *
 * Mirrors TripManager in structure but:
 *   1. Routes gyroscope to BOTH the DrowsinessDetector AND the
 *      MotoCrashReporter AND the MotoEventDetector.
 *   2. Keeps a LeanAngleEstimator live and feeds lean state to the
 *      MotoEventDetector.
 *   3. Uses MotoScorer instead of SafetyScorer.
 *   4. Applies motorcycle weather threshold factors (0.70 rain vs 0.88).
 *
 * NOTE on OBD: treated as fully optional. Speed falls back to GPS
 * gracefully. If OBD is available it also feeds OBDWearMonitor.
 */

import {
  AccelerometerSample,
  GyroscopeSample,
  GPSPoint,
  OBDSnapshot,
  CrashReport,
  TripRecord,
  TripStatus,
  DrowsinessSignal,
  WearSignal,
  WeatherSnapshot,
  RouteContext,
  SafetyScore,
} from '../types';
import { SensorFusion } from '../SensorFusion';
import { GPSTracker } from '../GPSTracker';
import { OBDWearMonitor } from '../OBDWearMonitor';
import { DrowsinessDetector } from '../DrowsinessDetector';
import { WeatherContext } from '../WeatherContext';
import { RouteTracker } from '../RouteTracker';
import { RecoveryTracker } from '../RecoveryTracker';
import { KVStore } from '../SafetyDatabase';
import {
  MotoConfig,
  MotoSafetyEvent,
  LeanState,
  PhonePositionSnapshot,
  RiderContext,
  RiderTripFeatures,
  RoadClass,
} from './types';
import { LeanAngleEstimator } from './LeanAngleEstimator';
import { MotoEventDetector } from './MotoEventDetector';
import { MotoCrashReporter } from './MotoCrashReporter';
import { MotoScorer } from './MotoScorer';
import { GPSKalmanFilter } from './GPSKalmanFilter';
import { PhonePositionClassifier } from './PhonePositionClassifier';
import { RiderContextProvider } from './RiderContextProvider';
import { SwerveDetector } from './SwerveDetector';
import { SignalProximityGetter } from './RoadObstacleFilter';

export interface MotoTripSnapshot {
  status: TripStatus;
  tripId: string | null;
  startedAt: number | null;
  distanceM: number;
  events: MotoSafetyEvent[];
  liveScore: SafetyScore | null;
  currentSpeedKmH: number;
  crashSuspected: boolean;
  lean: LeanState;
  leanCalibrated: boolean;
  wearSignals: WearSignal[];
  drowsinessEvents: DrowsinessSignal[];
  weather: WeatherSnapshot | null;
  routeContext: RouteContext | null;
  /** Phone-position classifier state (delivery-rider pipeline). */
  phonePosition: PhonePositionSnapshot;
  /** Current per-segment rider context (ambient speed, road class, ToD). */
  riderContext: RiderContext;
  /** Live aggregate safety features for coaching overlays. */
  riderFeatures: RiderTripFeatures;
}

export type MotoSnapshotHandler = (s: MotoTripSnapshot) => void;
export type MotoTripEndedHandler = (
  t: TripRecord & {
    motoEvents: MotoSafetyEvent[];
    riderFeatures: RiderTripFeatures;
    /** True if the trip failed the min-distance/duration gates (spec §2.4). */
    dropped: boolean;
  },
) => void;

export class MotoTripManager {
  private cfg: MotoConfig;

  private fusion = new SensorFusion();
  private gps = new GPSTracker();
  private lean = new LeanAngleEstimator();
  private detector: MotoEventDetector;
  private crash: MotoCrashReporter;
  private wear: OBDWearMonitor;
  private drowsiness: DrowsinessDetector;
  private weather: WeatherContext;
  private route: RouteTracker;
  private recovery: RecoveryTracker;
  private scorer: MotoScorer;

  // Delivery-rider pipeline.
  private kalman: GPSKalmanFilter;
  private phoneClassifier = new PhonePositionClassifier();
  private context: RiderContextProvider;
  private swerves: SwerveDetector;

  // Phone-usage event tracking (handheld / texting / distraction / call).
  private phoneUseOpenStartT = 0;
  private phoneUseOpenSubtype: string = '';
  private phoneCallActive = false;
  private callEventStartT = 0;
  private phoneUseSecondsTotal = 0;
  private movingSecondsTotal = 0;

  // Phone-position aggregation for the data contract.
  private posCounts = { mounted: 0, held: 0, pocket: 0, bag: 0, unknown: 0 };
  private swerveCount = 0;

  // Trip-stitching state (spec §2.4).
  private idleSinceT = 0;          // when speed first dropped below tripIdleSpeedKmH
  private lastMovingT = 0;         // last sample with speed ≥ idle threshold
  private onAutoEnd: (() => void) | null = null;

  // U-turn suppression (spec §4.4).
  private headingSamples: Array<{ t: number; deg: number }> = [];
  /** When > 0, suppress cornering events until this timestamp. */
  private suppressCorneringUntilT = 0;

  // Phone-mount shift tracking (spec §4.4, confidence reduction).
  private mountShiftSince = 0;

  // Foreground-app state for distraction detection (spec §4.6).
  private foregroundAppId: string | null = null;
  private foregroundScreenOn = false;
  private distractionOpenStartT = 0;

  // Texting-signature tracking (spec §4.6): sustained touch rate while moving.
  private textingOpenStartT = 0;

  /** Traffic-signal proximity getter wired from ContextEnrichmentService. */
  private signalProximityGetter: SignalProximityGetter | null = null;

  private status: TripStatus = 'idle';
  private tripId: string | null = null;
  private startedAt: number | null = null;
  private events: MotoSafetyEvent[] = [];
  private crashReport: CrashReport | null = null;
  private crashSuspected = false;
  private wearSignals: WearSignal[] = [];
  private drowsinessEvents: DrowsinessSignal[] = [];
  private activeDurationMs = 0;
  private lastActiveT = 0;
  private weatherSnapshot: WeatherSnapshot | null = null;
  private routeContext: RouteContext | null = null;

  private snapshotHandler: MotoSnapshotHandler | null = null;
  private tripEndedHandler: MotoTripEndedHandler | null = null;

  private idCounter = 0;
  private lastOBDSpeedT = 0;
  private readonly OBD_STALE_MS = 2000;

  constructor(cfg: MotoConfig) {
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

    const phonePosGetter = () => this.phoneClassifier.get();
    const contextGetter = () => this.context.getContext();
    // Traffic-signal proximity defers to whatever ContextEnrichmentService
    // has cached for the most recent segment. Swapped in at runtime so the
    // engine can run without enrichment.
    const signalGetter: SignalProximityGetter = () => {
      const g = this.signalProximityGetter;
      return g ? g() : { near: false, distM: null };
    };

    this.detector = new MotoEventDetector(locGetter, cfg, phonePosGetter, contextGetter, signalGetter);
    this.detector.setListener((ev) => this.onEvent(ev));

    this.swerves = new SwerveDetector(cfg, phonePosGetter);
    this.swerves.setListener((sw) => {
      this.swerveCount++;
      const durMs = sw.endedAt - sw.startedAt;
      const ctx = this.context.getContext();
      const severity: 1|2|3|4|5 =
        sw.peakLatMs2 >= 5.88 ? 4 :
        sw.peakLatMs2 >= 4.90 ? 3 : 2;
      this.events.push({
        id: `swerve_${sw.endedAt}_${++this.idCounter}`,
        type: 'swerving',
        startedAt: sw.startedAt,
        endedAt: sw.endedAt,
        peak: sw.peakLatMs2,
        severity,
        location: locGetter(),
        meta: {
          peakLatMs2: round2(sw.peakLatMs2),
          headingChangeDeg: round2(sw.headingChangeDeg),
          yawReversals: sw.yawReversals,
          durationMs: durMs,
          phonePositionState: sw.phonePosition.state,
          phonePositionConf: sw.phonePosition.confidence,
          timeOfDay: ctx.timeOfDay,
          timeOfDayWeight: ctx.timeOfDayWeight,
        },
      });
      this.pushSnapshot();
    });

    this.crash = new MotoCrashReporter(cfg, locGetter, () => this.gps.getRecent());
    this.crash.setHandlers(
      ({ t, peakG, trigger }) => {
        this.crashSuspected = true;
        this.events.push({
          id: `crash_s_${t}_${++this.idCounter}`,
          type: 'crash', startedAt: t, endedAt: t,
          peak: peakG, severity: 5, location: locGetter(),
          meta: { state: 'suspected', trigger },
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
            trigger: report.trigger,
            peakGyroRadS: report.peakGyroRadS,
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
    this.scorer = new MotoScorer(cfg);
  }

  setSnapshotHandler(h: MotoSnapshotHandler): void { this.snapshotHandler = h; }
  setTripEndedHandler(h: MotoTripEndedHandler): void { this.tripEndedHandler = h; }

  updateConfig(patch: Partial<MotoConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.detector.updateConfig(patch);
    this.crash.updateConfig(patch);
    this.wear.updateConfig(patch);
    this.drowsiness.updateConfig(patch);
    this.weather.updateConfig(patch);
    this.route.updateConfig(patch);
    this.recovery.updateConfig(patch);
    this.scorer.updateConfig(patch);
    this.swerves.updateConfig(patch);
    this.context.updateOptions({
      todDayWeight: this.cfg.todDayWeight,
      todDuskWeight: this.cfg.todDuskWeight,
      todNightWeight: this.cfg.todNightWeight,
    });
  }

  // ---------- External context overrides (Mappls / OSM integrations) ----------

  /**
   * Call this when a Mappls 2W-flow lookup succeeds for the current area.
   * Producers can call it as often as every 15 min per road segment.
   */
  setAmbient2WSpeedKmH(kmH: number): void { this.context.setAmbient2WSpeed(kmH); }
  /** Call this with the OSM highway tag for the current segment. */
  setRoadClass(rc: RoadClass): void { this.context.setRoadClass(rc); }
  /** Call this with the maxspeed from OSM, or a zone beacon, etc. */
  setSpeedLimitKmH(kmH: number): void { this.context.setSpeedLimit(kmH); }

  /** Phone-position hints (optional; improves classifier output). */
  reportTouchEvent(): void { this.phoneClassifier.recordTouch(); }
  reportCharging(isCharging: boolean): void { this.phoneClassifier.setCharging(isCharging); }

  /** Mark an active voice call so the phone-use detector can flag it. */
  setCallActive(active: boolean, t: number = Date.now()): void {
    if (active && !this.phoneCallActive) {
      this.phoneCallActive = true;
      this.callEventStartT = t;
    } else if (!active && this.phoneCallActive) {
      this.phoneCallActive = false;
      this.maybeEmitCallEvent(t);
    }
  }

  /**
   * Push the currently-foreground app / screen state so the distraction
   * detector (spec §4.6 Event 2) can emit when a non-whitelisted app is
   * visible while the rider is moving.
   */
  setForegroundApp(appId: string | null, screenOn: boolean, t: number = Date.now()): void {
    this.foregroundAppId = appId;
    this.foregroundScreenOn = screenOn;
    this.updateDistractionState(t);
  }

  /**
   * Wire a traffic-signal proximity getter (typically provided by
   * ContextEnrichmentService). Passed down to the obstacle filter so the
   * normal-stop branch can use OSM-tagged signals as ground truth.
   */
  setSignalProximityGetter(g: SignalProximityGetter | null): void {
    this.signalProximityGetter = g;
  }

  /**
   * Register a callback the engine should invoke when the trip-stitching
   * watchdog decides to auto-end the trip (5 min at < 2 km/h). The engine
   * uses this to persist the trip via its tripEnded pipeline.
   */
  setAutoEndHandler(fn: (() => void) | null): void {
    this.onAutoEnd = fn;
  }

  async loadPersisted(kv: KVStore): Promise<void> {
    await this.route.load(kv);
  }

  // ---------- Trip lifecycle ----------

  startTrip(t: number = Date.now()): string {
    if (this.status === 'active') return this.tripId!;
    this.fusion.reset();
    this.gps.reset();
    this.lean.reset();
    this.lean.requestCalibration();
    this.detector.reset();
    this.crash.reset();
    this.wear.reset();
    this.drowsiness.reset();
    this.kalman.reset();
    this.phoneClassifier.reset();
    this.context.reset();
    this.swerves.reset();
    this.events = [];
    this.crashReport = null;
    this.crashSuspected = false;
    this.wearSignals = [];
    this.drowsinessEvents = [];
    this.activeDurationMs = 0;
    this.lastActiveT = 0;
    this.weatherSnapshot = null;
    this.routeContext = null;
    this.phoneUseOpenStartT = 0;
    this.phoneUseOpenSubtype = '';
    this.phoneCallActive = false;
    this.callEventStartT = 0;
    this.phoneUseSecondsTotal = 0;
    this.movingSecondsTotal = 0;
    this.posCounts = { mounted: 0, held: 0, pocket: 0, bag: 0, unknown: 0 };
    this.swerveCount = 0;
    this.idleSinceT = 0;
    this.lastMovingT = 0;
    this.headingSamples = [];
    this.suppressCorneringUntilT = 0;
    this.mountShiftSince = 0;
    this.distractionOpenStartT = 0;
    this.textingOpenStartT = 0;

    this.tripId = `moto_trip_${t}_${++this.idCounter}`;
    this.startedAt = t;
    this.status = 'active';
    this.pushSnapshot();
    return this.tripId;
  }

  endTrip(t: number = Date.now()): (TripRecord & { motoEvents: MotoSafetyEvent[] }) | null {
    if (this.status !== 'active' || !this.tripId || !this.startedAt) return null;
    this.detector.flush(t);
    this.crash.flush(t);
    // Finalise open phone-use / call events.
    if (this.phoneUseOpenStartT !== 0) {
      const durMs = t - this.phoneUseOpenStartT;
      if (durMs >= this.cfg.phoneUseMinDurationS * 1000) {
        const speedKmH = this.fusion.getCurrentSpeedMPS() * 3.6;
        this.emitPhoneUseEvent(this.phoneUseOpenStartT, t, this.phoneUseOpenSubtype, speedKmH);
      }
      this.phoneUseOpenStartT = 0;
    }
    if (this.phoneCallActive) this.maybeEmitCallEvent(t);
    this.status = 'ended';

    const distanceM = this.gps.getDistanceM();
    const durationS = (t - this.startedAt) / 1000;
    const trail = this.gps.getTrail();

    if (this.route.isLoaded()) this.routeContext = this.route.evaluate(trail);

    // Trip-stitching drop flag (spec §2.4).
    const droppedTooShort =
      distanceM < this.cfg.tripMinDistanceM ||
      durationS < this.cfg.tripMinDurationS;

    const recoveredIds = this.recovery.computeRecoveredIds(
      this.events.map(e => ({ ...e, type: e.type as any }))
    );

    // A dropped trip is returned intact but with a zero score so it
    // doesn't pollute per-rider aggregates. The engine can choose to
    // discard it or store it as "low-signal".
    const score = droppedTooShort
      ? null
      : this.scorer.scoreTrip(this.events, distanceM, this.crashReport !== null, {
          recoveredEventIds: recoveredIds,
          graceFactor: this.routeContext?.graceFactor ?? 1.0,
          weatherCondition: this.weatherSnapshot?.condition ?? null,
        });

    const riderFeatures = this.buildRiderFeatures();

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
      motoEvents: this.events.slice(),
      riderFeatures,
      dropped: droppedTooShort,
    };

    this.tripEndedHandler?.(record);
    this.pushSnapshot();
    return record;
  }

  isActive(): boolean { return this.status === 'active'; }

  /** Most recently accepted GPS fix, or null. */
  getLastGPS(): { lat: number; lng: number; t: number } | null {
    const last = this.gps.getLast();
    return last ? { lat: last.lat, lng: last.lng, t: last.t } : null;
  }

  // ---------- Sensor ingestion ----------

  ingestOBDSpeed(speedKmH: number, t: number = Date.now()): void {
    if (this.status !== 'active') return;
    this.lastOBDSpeedT = t;
    const speedMPS = speedKmH / 3.6;
    const longAccel = this.fusion.ingestSpeed(speedMPS, t);
    this.crash.ingestSpeed(speedKmH, t);
    this.drowsiness.updateSpeed(speedKmH);
    this.accumulateActive(speedKmH, t);
    this.runDetectorTick(longAccel, speedKmH, t);
  }

  ingestOBDSnapshot(snap: OBDSnapshot): void {
    if (this.status !== 'active') return;
    this.wear.ingest({ rpm: snap.rpm, engineLoadPct: snap.engineLoadPct, coolantC: snap.coolantC, t: snap.t });
    if (snap.speedKmH !== null) this.ingestOBDSpeed(snap.speedKmH, snap.t);
  }

  ingestGPS(point: GPSPoint): void {
    if (this.status !== 'active') return;

    // Kalman-filter the raw GPS sample. Use its output for speed/heading;
    // fall back to the raw sample when the filter is still settling.
    const kal = this.kalman.ingest(point);
    const useKalman = kal.settled && !kal.rejected;
    const kmH = useKalman ? kal.speedMPS * 3.6 : (point.speedMPS !== null ? point.speedMPS * 3.6 : 0);
    const headingDeg = useKalman ? kal.headingDeg : point.headingDeg;

    const { accepted } = this.gps.ingest(point);
    if (!accepted) return;

    if (!this.weatherSnapshot && this.cfg.enableWeatherAPI) {
      this.weather.fetch(point.lat, point.lng, point.accuracyM).then((snap) => {
        if (snap) {
          this.weatherSnapshot = snap;
          // Motorcycle uses more aggressive weather factors
          this.applyWeatherToDetector(snap);
          this.pushSnapshot();
        }
      }).catch(() => {});
    }

    if (!this.routeContext && this.route.isLoaded() && this.gps.getDistanceM() >= 2000) {
      this.routeContext = this.route.evaluate(this.gps.getTrail());
    }

    // Record filtered speed into the context provider's rolling window
    // regardless of whether OBD is fresh — road-class inference uses it.
    if (kmH >= 0) this.context.recordSpeed(kmH);

    const obdStale = point.t - this.lastOBDSpeedT > this.OBD_STALE_MS;
    if (obdStale && point.speedMPS !== null && point.speedMPS >= 0) {
      const speedMPS = useKalman ? kal.speedMPS : point.speedMPS;
      const speedKmH = speedMPS * 3.6;
      const longAccel = this.fusion.ingestSpeed(speedMPS, point.t);
      this.crash.ingestSpeed(speedKmH, point.t);
      this.drowsiness.updateSpeed(speedKmH);
      this.accumulateActive(speedKmH, point.t);
      this.runDetectorTick(longAccel, speedKmH, point.t);
    }

    if (headingDeg !== null) {
      const lateral = this.fusion.ingestHeading(headingDeg, point.t);
      // Feed centripetal into lean estimator.
      this.lean.updateGPS(Math.abs(lateral), point.t, lateral < 0);
      const leanState: LeanState = {
        angleDeg: this.lean.getLeanDeg(),
        centripetal: Math.abs(lateral),
        source: this.lean.getSource(),
      };
      this.detector.updateLeanState(leanState);

      // Feed swerve detector (lateral accel + yaw + heading, gyro fed separately).
      this.swerves.ingest({
        t: point.t,
        latAccelMs2: lateral,
        yawRadS: 0, // gyro path handles this below
        headingDeg,
      });

      // Heading sample for U-turn suppression.
      this.headingSamples.push({ t: point.t, deg: headingDeg });
      const hcut = point.t - 3000;
      while (this.headingSamples.length > 1 && this.headingSamples[0].t < hcut) {
        this.headingSamples.shift();
      }
      this.updateUTurnState(kmH, point.t);

      // Phone-mount shift: compare IMU lean vs GPS-derived expected lean.
      this.updateMountShift(leanState.angleDeg, kmH, headingDeg, point.t);
    }
  }

  ingestAccelerometer(sample: AccelerometerSample): void {
    if (this.status !== 'active') return;
    const linearMag = this.fusion.ingestAccelerometer(sample);
    this.crash.ingestAccel(sample, linearMag);
    const gravity = this.fusion.getGravity();
    // Feed gravity to lean estimator (needs current speed for calibration gate).
    const speedKmH = this.fusion.getCurrentSpeedMPS() * 3.6;
    this.lean.ingestGravity(gravity, speedKmH);

    // Phone-position classification.
    const snap = this.phoneClassifier.ingest(sample, gravity, this.fusion.getLongitudinalAccel());
    this.accumulatePhonePos(snap.state);

    // Vertical/lateral components for the obstacle filter.
    // Project the linear-accel onto gravity ("vertical") and onto the horizontal.
    const gmag = Math.sqrt(gravity.x * gravity.x + gravity.y * gravity.y + gravity.z * gravity.z) || 1e-9;
    const gUx = gravity.x / gmag, gUy = gravity.y / gmag, gUz = gravity.z / gmag;
    const lx = sample.accel.x - gravity.x;
    const ly = sample.accel.y - gravity.y;
    const lz = sample.accel.z - gravity.z;
    const vertical = lx * gUx + ly * gUy + lz * gUz;
    const lateralMag = Math.sqrt(Math.max(0, linearMag * linearMag - vertical * vertical));
    this.detector.ingestAxisAccels(sample.t, vertical, lateralMag);

    // Phone-use handheld signature (fallback when no screen/touch wiring).
    this.updatePhoneUseMotionSignature(linearMag, sample.t);
  }

  ingestGyroscope(sample: GyroscopeSample): void {
    if (this.status !== 'active') return;
    this.drowsiness.ingest(sample);
    this.crash.ingestGyro(sample, this.fusion.getLinearMag());
    this.detector.ingestGyro(sample);

    // Feed gyro to swerve detector (yaw axis). Heading null until GPS ticks.
    this.swerves.ingest({
      t: sample.t,
      latAccelMs2: this.fusion.getLateralAccel(),
      yawRadS: sample.gyro.z,
      headingDeg: null,
    });
  }

  onAppBackground(t: number = Date.now()): void {
    if (this.status !== 'active') return;
    this.detector.onAppBackground(t);
  }

  onAppForeground(t: number = Date.now()): void {
    if (this.status !== 'active') return;
    this.detector.onAppForeground(t);
  }

  async persistRouteAfterTrip(kv: KVStore): Promise<void> {
    const trail = this.gps.getTrail();
    if (trail.length > 0) { this.route.recordTrail(trail); await this.route.persist(kv); }
  }

  // ---------- internals ----------

  private runDetectorTick(longAccel: number, speedKmH: number, t: number): void {
    const lateral = this.fusion.getLateralAccel();
    const linearMag = this.fusion.getLinearMag();
    this.detector.tick({ longitudinal: longAccel, lateral, speedKmH, linearMag, t });
    this.detector.ingestGPSSpeed(speedKmH, t);
    this.updateTripStitching(speedKmH, t);
    this.updateTextingState(speedKmH, t);
    this.updateDistractionState(t);
    this.pushSnapshot();
  }

  /**
   * Trip-stitching watchdog (spec §2.4). The engine does not auto-end on
   * brief pauses (pickup/drop). It auto-ends when the rider has been below
   * the idle speed for a continuous `tripIdleEndSeconds` window. The final
   * decision is delegated to the engine via `onAutoEnd` — the manager does
   * not call endTrip() directly so the engine can run its full persistence
   * pipeline.
   */
  private updateTripStitching(speedKmH: number, t: number): void {
    const idleThreshold = this.cfg.tripIdleSpeedKmH;
    const idleMs = this.cfg.tripIdleEndSeconds * 1000;
    if (speedKmH >= idleThreshold) {
      this.idleSinceT = 0;
      this.lastMovingT = t;
      return;
    }
    if (this.idleSinceT === 0) {
      this.idleSinceT = t;
      return;
    }
    if (t - this.idleSinceT >= idleMs && this.onAutoEnd) {
      // Fire once; the engine is responsible for calling endTrip().
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

  /**
   * Weak phone-use signature derived purely from the accel stream — no
   * screen/touch APIs required. When a rider picks up the phone and
   * interacts with it, linearMag sustains 0.7+ m/s² for seconds and is
   * uncorrelated with the vehicle motion. We don't upgrade the result
   * to a "held" confidence by itself — that's the classifier's job — but
   * we do emit a phone_use event when the signature persists.
   */
  private updatePhoneUseMotionSignature(linearMag: number, t: number): void {
    const speedKmH = this.fusion.getCurrentSpeedMPS() * 3.6;
    const pos = this.phoneClassifier.get();
    const sustained = linearMag > 0.7 && speedKmH >= this.cfg.phoneUseMinSpeedKmH;

    // Combined signal: held phone OR sustained motion signature.
    const handheld =
      (pos.state === 'held' && pos.confidence >= this.cfg.phonePositionMinConfidence) ||
      sustained;

    if (handheld) {
      if (this.phoneUseOpenStartT === 0) {
        this.phoneUseOpenStartT = t;
        this.phoneUseOpenSubtype = pos.state === 'held' ? 'handheld' : 'distraction';
      }
      const durMs = t - this.phoneUseOpenStartT;
      if (durMs >= this.cfg.phoneUseMinDurationS * 1000 &&
          !this.events.find(e => e.type === 'phone_use' && e.endedAt === 0)) {
        // Nothing to do here for open — we finalise on release.
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
    if (
      speedKmH >= this.cfg.phoneUseCallMinSpeedKmH &&
      durMs >= this.cfg.phoneUseCallMinDurationS * 1000
    ) {
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
      dur >= 30 ? 4 :
      dur >= 15 ? 3 :
      dur >= 5  ? 2 : 1;
    const loc = (() => {
      const last = this.gps.getLast();
      return last ? { lat: last.lat, lng: last.lng } : null;
    })();
    this.events.push({
      id: `phone_${endedAt}_${++this.idCounter}`,
      type: 'phone_use',
      startedAt,
      endedAt,
      peak: dur,
      severity,
      location: loc,
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

  private buildRiderFeatures(): RiderTripFeatures {
    const detectorFeatures = this.detector.getRiderFeatures();
    const totalPos = Math.max(1,
      this.posCounts.mounted + this.posCounts.held + this.posCounts.pocket +
      this.posCounts.bag     + this.posCounts.unknown,
    );
    const phoneRatio = this.movingSecondsTotal > 0
      ? this.phoneUseSecondsTotal / this.movingSecondsTotal : 0;
    return {
      jerkSpikeCount: detectorFeatures?.jerkSpikeCount ?? 0,
      accelReversalsPerMinute: detectorFeatures?.accelReversalsPerMinute ?? 0,
      coastRatio: detectorFeatures?.coastRatio ?? 0,
      phoneUsageRatio: round2(phoneRatio),
      mountedPct: round2(this.posCounts.mounted / totalPos),
      heldPct:    round2(this.posCounts.held    / totalPos),
      pocketPct:  round2(this.posCounts.pocket  / totalPos),
      bagPct:     round2(this.posCounts.bag     / totalPos),
      unknownPct: round2(this.posCounts.unknown / totalPos),
      speedBreakersDetected: detectorFeatures?.speedBreakersDetected ?? 0,
      potholesDetected:      detectorFeatures?.potholesDetected      ?? 0,
      normalStopsDetected:   detectorFeatures?.normalStopsDetected   ?? 0,
      panicStopCount:        detectorFeatures?.panicStopCount        ?? 0,
      swerveCount: this.swerveCount,
      peakSpeedKmH: detectorFeatures?.peakSpeedKmH ?? 0,
      zeroTo30TimeS:         detectorFeatures?.zeroTo30TimeS         ?? null,
      energyGainRate:        detectorFeatures?.energyGainRate        ?? 0,
      aggressivePatternScore: detectorFeatures?.aggressivePatternScore ?? 0,
      preBrakeSpeedMeanKmH:  detectorFeatures?.preBrakeSpeedMeanKmH  ?? 0,
      preBrakeSpeedP95KmH:   detectorFeatures?.preBrakeSpeedP95KmH   ?? 0,
      brakeDuringLeanCount:  detectorFeatures?.brakeDuringLeanCount  ?? 0,
      movingSeconds: round2(this.movingSecondsTotal),
    };
  }

  /**
   * U-turn suppression (spec §4.4). At low speed with a large total
   * heading change over ~3 s, we suppress cornering events for a short
   * window so a legitimate tight turn doesn't fire hard_cornering.
   *
   * The suppression is advisory — the base detector still records the
   * event but the listener filter drops it. We implement it by exposing
   * a time-bounded mute flag used in onEvent().
   */
  private updateUTurnState(speedKmH: number, t: number): void {
    if (speedKmH > this.cfg.uTurnMaxSpeedKmH) return;
    if (this.headingSamples.length < 2) return;
    // Total unsigned delta across the sliding window.
    let total = 0;
    for (let i = 1; i < this.headingSamples.length; i++) {
      total += shortestHeadingDelta(this.headingSamples[i - 1].deg, this.headingSamples[i].deg);
    }
    if (total >= this.cfg.uTurnMinHeadingChangeDeg) {
      // Suppress any cornering events emitted in the next 2 s; that's the
      // typical length of a completed U-turn.
      this.suppressCorneringUntilT = t + 2000;
    }
  }

  /**
   * Phone-mount shift detection (spec §4.4). Compare the IMU-inferred
   * lean angle against the GPS-derived expected lean (from centripetal
   * requirement): expected_lean_rad = atan(v * |ω_heading| / g). If the
   * two disagree by more than `mountShiftMaxDiffDeg` for
   * `mountShiftMinDurationS` seconds, flag the mount as potentially
   * shifted and cap the phone-position confidence at 0.5.
   */
  private updateMountShift(imuLeanDeg: number, speedKmH: number, headingDeg: number, t: number): void {
    if (speedKmH < 10) { this.mountShiftSince = 0; return; }
    // Compute recent heading rate (deg/s) from the sliding window.
    if (this.headingSamples.length < 3) return;
    const last = this.headingSamples[this.headingSamples.length - 1];
    const first = this.headingSamples[0];
    const dtS = (last.t - first.t) / 1000;
    if (dtS < 0.8) return;
    let sumDelta = 0;
    for (let i = 1; i < this.headingSamples.length; i++) {
      sumDelta += shortestHeadingDelta(this.headingSamples[i - 1].deg, this.headingSamples[i].deg);
    }
    const headingRateRadS = (sumDelta / dtS) * Math.PI / 180;
    const vMPS = speedKmH / 3.6;
    const expectedLeanRad = Math.atan((vMPS * Math.abs(headingRateRadS)) / 9.81);
    const expectedLeanDeg = expectedLeanRad * 180 / Math.PI;
    const diff = Math.abs(Math.abs(imuLeanDeg) - expectedLeanDeg);

    if (diff > this.cfg.mountShiftMaxDiffDeg) {
      if (this.mountShiftSince === 0) this.mountShiftSince = t;
      if ((t - this.mountShiftSince) / 1000 >= this.cfg.mountShiftMinDurationS) {
        this.phoneClassifier.suspectMountShift(0.5);
      }
    } else {
      this.mountShiftSince = 0;
    }
  }

  /**
   * Emit distraction phone_use events (spec §4.6 Event 2) when the
   * foreground app is not in the delivery whitelist and the rider is
   * moving above the speed threshold.
   */
  private updateDistractionState(t: number): void {
    if (this.status !== 'active') return;
    const speedKmH = this.fusion.getCurrentSpeedMPS() * 3.6;
    const appId = this.foregroundAppId;
    const whitelisted = appId !== null && this.cfg.deliveryAppIds.includes(appId);
    const isDistraction =
      this.foregroundScreenOn &&
      appId !== null &&
      !whitelisted &&
      speedKmH >= this.cfg.phoneUseMinSpeedKmH;

    if (isDistraction) {
      if (this.distractionOpenStartT === 0) this.distractionOpenStartT = t;
    } else if (this.distractionOpenStartT !== 0) {
      const durMs = t - this.distractionOpenStartT;
      if (durMs >= this.cfg.phoneUseMinDurationS * 1000) {
        this.emitPhoneUseEvent(this.distractionOpenStartT, t, 'distraction', speedKmH, { app: appId ?? 'unknown' });
      }
      this.distractionOpenStartT = 0;
    }
  }

  /**
   * Emit texting phone_use events (spec §4.6 Event 4). Touch rate is
   * maintained by the phone-position classifier; when sustained above
   * 1.5 touches/s while moving, we emit.
   */
  private updateTextingState(speedKmH: number, t: number): void {
    const rate = this.phoneClassifier.getTouchRatePerSec();
    const isTexting =
      speedKmH >= this.cfg.phoneUseMinSpeedKmH &&
      rate >= this.cfg.phoneUseTouchesPerSec;

    if (isTexting) {
      if (this.textingOpenStartT === 0) this.textingOpenStartT = t;
    } else if (this.textingOpenStartT !== 0) {
      const durMs = t - this.textingOpenStartT;
      if (durMs >= this.cfg.phoneUseMinDurationS * 1000) {
        this.emitPhoneUseEvent(this.textingOpenStartT, t, 'texting', speedKmH, { touchesPerSec: round2(rate) });
      }
      this.textingOpenStartT = 0;
    }
  }

  private applyWeatherToDetector(snap: WeatherSnapshot): void {
    // Moto uses its own rain/snow factors from MotoConfig.
    let factor: number;
    switch (snap.condition) {
      case 'light_rain': case 'heavy_rain': factor = this.cfg.rainThresholdFactor; break;
      case 'snow':                          factor = this.cfg.snowThresholdFactor; break;
      default:                              factor = snap.thresholdFactor; break;
    }
    this.detector.updateConfig({
      hardBrakeThreshold:  this.cfg.hardBrakeThreshold  * factor,
      hardCornerThreshold: this.cfg.hardCornerThreshold * factor,
    });
  }

  private onEvent(ev: MotoSafetyEvent): void {
    // U-turn suppression: drop cornering events fired while the U-turn
    // watchdog is active. Keeps sharp controlled turns from registering
    // as hard_cornering (spec §4.4).
    const corneringTypes = new Set<string>(['hard_cornering', 'extreme_lean', 'corner_acceleration']);
    if (corneringTypes.has(ev.type) && ev.startedAt < this.suppressCorneringUntilT) {
      return;
    }
    this.events.push(ev);
    this.pushSnapshot();
  }

  private pushSnapshot(): void {
    if (!this.snapshotHandler) return;
    const distanceM = this.gps.getDistanceM();
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
      lean: {
        angleDeg: this.lean.getLeanDeg(),
        centripetal: this.fusion.getLateralAccel(),
        source: this.lean.getSource(),
      },
      leanCalibrated: this.lean.isCalibrated(),
      wearSignals: this.wearSignals.slice(),
      drowsinessEvents: this.drowsinessEvents.slice(),
      weather: this.weatherSnapshot,
      routeContext: this.routeContext,
      phonePosition: this.phoneClassifier.get(),
      riderContext: this.context.getContext(),
      riderFeatures: this.buildRiderFeatures(),
    });
  }
}

function round2(x: number): number { return Math.round(x * 100) / 100; }

/** Shortest angular delta (unsigned, degrees) between two heading samples. */
function shortestHeadingDelta(a: number, b: number): number {
  const d = Math.abs(b - a) % 360;
  return d > 180 ? 360 - d : d;
}

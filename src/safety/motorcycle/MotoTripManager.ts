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
import { MotoConfig, MotoSafetyEvent, LeanState } from './types';
import { LeanAngleEstimator } from './LeanAngleEstimator';
import { MotoEventDetector } from './MotoEventDetector';
import { MotoCrashReporter } from './MotoCrashReporter';
import { MotoScorer } from './MotoScorer';

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
}

export type MotoSnapshotHandler = (s: MotoTripSnapshot) => void;
export type MotoTripEndedHandler = (t: TripRecord & { motoEvents: MotoSafetyEvent[] }) => void;

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

    this.detector = new MotoEventDetector(locGetter, cfg);
    this.detector.setListener((ev) => this.onEvent(ev));

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
    this.events = [];
    this.crashReport = null;
    this.crashSuspected = false;
    this.wearSignals = [];
    this.drowsinessEvents = [];
    this.activeDurationMs = 0;
    this.lastActiveT = 0;
    this.weatherSnapshot = null;
    this.routeContext = null;

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
    this.status = 'ended';

    const distanceM = this.gps.getDistanceM();
    const trail = this.gps.getTrail();

    if (this.route.isLoaded()) this.routeContext = this.route.evaluate(trail);

    const recoveredIds = this.recovery.computeRecoveredIds(
      this.events.map(e => ({ ...e, type: e.type as any }))
    );

    const score = this.scorer.scoreTrip(this.events, distanceM, this.crashReport !== null, {
      recoveredEventIds: recoveredIds,
      graceFactor: this.routeContext?.graceFactor ?? 1.0,
      weatherCondition: this.weatherSnapshot?.condition ?? null,
    });

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
    };

    this.tripEndedHandler?.(record);
    this.pushSnapshot();
    return record;
  }

  isActive(): boolean { return this.status === 'active'; }

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

    const obdStale = point.t - this.lastOBDSpeedT > this.OBD_STALE_MS;
    if (obdStale && point.speedMPS !== null && point.speedMPS >= 0) {
      const speedKmH = point.speedMPS * 3.6;
      const longAccel = this.fusion.ingestSpeed(point.speedMPS, point.t);
      this.crash.ingestSpeed(speedKmH, point.t);
      this.drowsiness.updateSpeed(speedKmH);
      this.accumulateActive(speedKmH, point.t);
      this.runDetectorTick(longAccel, speedKmH, point.t);
    }

    if (point.headingDeg !== null) {
      const lateral = this.fusion.ingestHeading(point.headingDeg, point.t);
      // Feed centripetal into lean estimator.
      this.lean.updateGPS(Math.abs(lateral), point.t, lateral < 0);
      const leanState: LeanState = {
        angleDeg: this.lean.getLeanDeg(),
        centripetal: Math.abs(lateral),
        source: this.lean.getSource(),
      };
      this.detector.updateLeanState(leanState);
    }
  }

  ingestAccelerometer(sample: AccelerometerSample): void {
    if (this.status !== 'active') return;
    const linearMag = this.fusion.ingestAccelerometer(sample);
    this.crash.ingestAccel(sample, linearMag);
    // Feed gravity to lean estimator (needs current speed for calibration gate).
    const speedKmH = this.fusion.getCurrentSpeedMPS() * 3.6;
    this.lean.ingestGravity(this.fusion.getGravity(), speedKmH);
  }

  ingestGyroscope(sample: GyroscopeSample): void {
    if (this.status !== 'active') return;
    this.drowsiness.ingest(sample);
    this.crash.ingestGyro(sample, this.fusion.getLinearMag());
    this.detector.ingestGyro(sample);
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
    this.pushSnapshot();
  }

  private accumulateActive(speedKmH: number, t: number): void {
    if (this.lastActiveT > 0 && speedKmH > 1) {
      const dt = t - this.lastActiveT;
      if (dt > 0 && dt < 5000) this.activeDurationMs += dt;
    }
    this.lastActiveT = t;
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
    });
  }
}

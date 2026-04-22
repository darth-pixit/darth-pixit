/**
 * TripManager — orchestration layer.
 *
 * Wires together:
 *   OBD/GPS/accelerometer/gyroscope/AppState
 *     → SensorFusion + GPSTracker
 *     → EventDetector + CrashReporter
 *     → OBDWearMonitor + DrowsinessDetector
 *     → WeatherContext + RouteTracker
 *     → RecoveryTracker + SafetyScorer
 *     → TripRecord
 *
 * All sensor ingestion is "push": external bindings call the ingest*
 * methods. The engine is independent of any specific sensor library.
 */

import {
  AccelerometerSample,
  GyroscopeSample,
  GPSPoint,
  OBDSnapshot,
  SafetyEvent,
  CrashReport,
  TripRecord,
  TripStatus,
  DrowsinessSignal,
  WearSignal,
  WeatherSnapshot,
  RouteContext,
  SafetyConfig,
  DEFAULT_SAFETY_CONFIG,
  SafetyScore,
} from './types';
import { SensorFusion } from './SensorFusion';
import { GPSTracker } from './GPSTracker';
import { EventDetector } from './EventDetector';
import { CrashReporter } from './CrashReporter';
import { OBDWearMonitor } from './OBDWearMonitor';
import { DrowsinessDetector } from './DrowsinessDetector';
import { WeatherContext } from './WeatherContext';
import { RouteTracker } from './RouteTracker';
import { RecoveryTracker } from './RecoveryTracker';
import { SafetyScorer, ScoringContext } from './SafetyScorer';
import { KVStore } from './SafetyDatabase';

export interface TripSnapshot {
  status: TripStatus;
  tripId: string | null;
  startedAt: number | null;
  distanceM: number;
  events: SafetyEvent[];
  liveScore: SafetyScore | null;
  currentSpeedKmH: number;
  crashSuspected: boolean;
  wearSignals: WearSignal[];
  drowsinessEvents: DrowsinessSignal[];
  weather: WeatherSnapshot | null;
  routeContext: RouteContext | null;
  drowsinessDetectorCalibrated: boolean;
}

export type SnapshotHandler = (s: TripSnapshot) => void;
export type TripEndedHandler = (t: TripRecord) => void;

export class TripManager {
  private cfg: SafetyConfig;

  private fusion = new SensorFusion();
  private gps = new GPSTracker();
  private detector: EventDetector;
  private crash: CrashReporter;
  private wearMonitor: OBDWearMonitor;
  private drowsiness: DrowsinessDetector;
  private weather: WeatherContext;
  private route: RouteTracker;
  private recovery: RecoveryTracker;
  private scorer: SafetyScorer;

  private status: TripStatus = 'idle';
  private tripId: string | null = null;
  private startedAt: number | null = null;
  private events: SafetyEvent[] = [];
  private crashReport: CrashReport | null = null;
  private crashSuspected = false;
  private wearSignals: WearSignal[] = [];
  private drowsinessEvents: DrowsinessSignal[] = [];
  private activeDurationMs = 0;
  private lastActiveT = 0;
  private weatherSnapshot: WeatherSnapshot | null = null;
  private routeContext: RouteContext | null = null;

  private snapshotHandler: SnapshotHandler | null = null;
  private tripEndedHandler: TripEndedHandler | null = null;

  private idCounter = 0;
  private lastOBDSpeedT = 0;
  private readonly OBD_STALE_MS = 2000;

  constructor(cfg: SafetyConfig = DEFAULT_SAFETY_CONFIG) {
    this.cfg = cfg;

    const locGetter = () => {
      const last = this.gps.getLast();
      return last ? { lat: last.lat, lng: last.lng } : null;
    };

    this.detector = new EventDetector(locGetter, cfg);
    this.detector.setListener((ev) => this.onEvent(ev));

    this.crash = new CrashReporter(cfg, locGetter, () => this.gps.getRecent());
    this.crash.setHandlers(
      ({ t, peakG }) => {
        this.crashSuspected = true;
        this.events.push({
          id: `crash_suspect_${t}_${++this.idCounter}`,
          type: 'crash', startedAt: t, endedAt: t,
          peak: peakG, severity: 5,
          location: locGetter(),
          meta: { state: 'suspected' },
        });
        this.pushSnapshot();
      },
      (report) => {
        this.crashReport = report;
        this.crashSuspected = false;
        const existing = this.events.find((e) => e.type === 'crash' && e.meta?.state === 'suspected');
        if (existing) {
          existing.meta = { state: 'confirmed', peakG: report.peakG, featuresTriggered: report.featuresTriggered };
        } else {
          this.events.push({
            id: report.id, type: 'crash',
            startedAt: report.detectedAt, endedAt: report.detectedAt,
            peak: report.peakG, severity: 5, location: report.location,
            meta: { state: 'confirmed', featuresTriggered: report.featuresTriggered },
          });
        }
        this.pushSnapshot();
      },
    );

    this.wearMonitor = new OBDWearMonitor(locGetter, cfg);
    this.wearMonitor.setListener((signal) => {
      this.wearSignals.push(signal);
      this.pushSnapshot();
    });

    this.drowsiness = new DrowsinessDetector(cfg);
    this.drowsiness.setListener((signal) => {
      this.drowsinessEvents.push(signal);
      // Also emit a scored event so the event list shows it.
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
    this.scorer = new SafetyScorer(cfg);
  }

  setSnapshotHandler(h: SnapshotHandler): void { this.snapshotHandler = h; }
  setTripEndedHandler(h: TripEndedHandler): void { this.tripEndedHandler = h; }

  updateConfig(patch: Partial<SafetyConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.detector.updateConfig(patch);
    this.crash.updateConfig(patch);
    this.wearMonitor.updateConfig(patch);
    this.drowsiness.updateConfig(patch);
    this.weather.updateConfig(patch);
    this.route.updateConfig(patch);
    this.recovery.updateConfig(patch);
    this.scorer.updateConfig(patch);
  }

  /** Must be called before startTrip so route tiles are available. */
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
    this.wearMonitor.reset();
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

    this.tripId = `trip_${t}_${++this.idCounter}`;
    this.startedAt = t;
    this.status = 'active';
    this.pushSnapshot();
    return this.tripId;
  }

  endTrip(t: number = Date.now()): TripRecord | null {
    if (this.status !== 'active' || !this.tripId || !this.startedAt) return null;
    this.detector.flush(t);
    this.crash.flush(t);
    this.status = 'ended';

    const distanceM = this.gps.getDistanceM();
    const trail = this.gps.getTrail();

    // Evaluate route familiarity with the completed trail.
    if (this.route.isLoaded()) {
      this.routeContext = this.route.evaluate(trail);
    }

    // Compute recovery bonuses.
    const recoveredIds = this.recovery.computeRecoveredIds(this.events);

    const scoringCtx: ScoringContext = {
      recoveredEventIds: recoveredIds,
      graceFactor: this.routeContext?.graceFactor ?? 1.0,
      weatherCondition: this.weatherSnapshot?.condition ?? null,
    };

    const record: TripRecord = {
      id: this.tripId,
      startedAt: this.startedAt,
      endedAt: t,
      distanceM,
      activeDurationMs: this.activeDurationMs,
      events: this.events.slice(),
      trail,
      score: this.scorer.scoreTrip(this.events, distanceM, this.crashReport !== null, scoringCtx),
      crash: this.crashReport,
      wearSignals: this.wearSignals.slice(),
      drowsinessEvents: this.drowsinessEvents.slice(),
      weatherContext: this.weatherSnapshot,
      routeContext: this.routeContext,
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
    const speedMPS = (speedKmH * 1000) / 3600;
    const longAccel = this.fusion.ingestSpeed(speedMPS, t);
    this.crash.ingestSpeed(speedKmH, t);
    this.drowsiness.updateSpeed(speedKmH);
    this.accumulateActive(speedKmH, t);
    this.runDetectorTick(longAccel, speedKmH, t);
  }

  ingestOBDSnapshot(snap: OBDSnapshot): void {
    if (this.status !== 'active') return;
    this.wearMonitor.ingest({
      rpm: snap.rpm,
      engineLoadPct: snap.engineLoadPct,
      coolantC: snap.coolantC,
      t: snap.t,
    });
    // Forward speed if OBD snapshot includes it.
    if (snap.speedKmH !== null) {
      this.ingestOBDSpeed(snap.speedKmH, snap.t);
    }
  }

  ingestGPS(point: GPSPoint): void {
    if (this.status !== 'active') return;
    const { accepted } = this.gps.ingest(point);
    if (!accepted) return;

    // Trigger weather fetch at trip start (first clean GPS fix).
    if (!this.weatherSnapshot && this.cfg.enableWeatherAPI) {
      this.weather.fetch(point.lat, point.lng, point.accuracyM)
        .then((snap) => {
          if (snap) {
            this.weatherSnapshot = snap;
            // Apply threshold factors to the detector immediately.
            this.applyWeatherToDetector(snap);
            this.pushSnapshot();
          }
        })
        .catch(() => { /* weather is advisory — ignore errors */ });
    }

    // Route context: evaluate familiarity after the first 2 km.
    if (
      !this.routeContext &&
      this.route.isLoaded() &&
      this.gps.getDistanceM() >= 2000 &&
      this.gps.getTrail().length >= 5
    ) {
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
      this.fusion.ingestHeading(point.headingDeg, point.t);
    }
  }

  ingestAccelerometer(sample: AccelerometerSample): void {
    if (this.status !== 'active') return;
    const linearMag = this.fusion.ingestAccelerometer(sample);
    this.crash.ingestAccel(sample, linearMag);
  }

  ingestGyroscope(sample: GyroscopeSample): void {
    if (this.status !== 'active') return;
    this.drowsiness.ingest(sample);
  }

  onAppBackground(t: number = Date.now()): void {
    if (this.status !== 'active') return;
    this.detector.onAppBackground(t);
  }

  onAppForeground(t: number = Date.now()): void {
    if (this.status !== 'active') return;
    this.detector.onAppForeground(t);
  }

  // ---------- Post-trip persistence helper ----------

  async persistRouteAfterTrip(kv: KVStore): Promise<void> {
    const trail = this.gps.getTrail();
    if (trail.length > 0) {
      this.route.recordTrail(trail);
      await this.route.persist(kv);
    }
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
    const f = snap.thresholdFactor;
    this.detector.updateConfig({
      hardBrakeThreshold:  this.cfg.hardBrakeThreshold  * f,
      hardCornerThreshold: this.cfg.hardCornerThreshold * f,
    });
  }

  private onEvent(ev: SafetyEvent): void {
    this.events.push(ev);
    this.pushSnapshot();
  }

  private pushSnapshot(): void {
    if (!this.snapshotHandler) return;
    const distanceM = this.gps.getDistanceM();
    const liveScore = this.status === 'active'
      ? this.scorer.scoreTrip(this.events, distanceM, this.crashReport !== null)
      : null;
    this.snapshotHandler({
      status: this.status,
      tripId: this.tripId,
      startedAt: this.startedAt,
      distanceM,
      events: this.events.slice(),
      liveScore,
      currentSpeedKmH: this.fusion.getCurrentSpeedMPS() * 3.6,
      crashSuspected: this.crashSuspected,
      wearSignals: this.wearSignals.slice(),
      drowsinessEvents: this.drowsinessEvents.slice(),
      weather: this.weatherSnapshot,
      routeContext: this.routeContext,
      drowsinessDetectorCalibrated: this.drowsiness.isCalibrated(),
    });
  }
}

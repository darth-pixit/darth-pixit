/**
 * TripManager — the orchestration layer. Wires together:
 *   OBD/GPS/accelerometer/gyroscope/AppState  →  SensorFusion + GPSTracker
 *     → EventDetector + CrashReporter  →  SafetyScorer  →  TripRecord
 *
 * All sensor ingestion is "push": external bindings call the ingest*
 * methods. This keeps the engine independent of any specific library
 * (react-native-sensors, react-native-geolocation-service, expo-*, etc.)
 * and makes the whole thing unit-testable by replaying fixtures.
 *
 * Auto-trip detection:
 *   We don't auto-start trips here — the app should start/stop
 *   explicitly or wire a simple "OBD ready + speed > 5 km/h for 10 s"
 *   heuristic. Auto-detection without OBD is hard (walking, cycling,
 *   bus rides all look like slow driving) and we'd rather be explicit
 *   than wrong.
 */

import {
  AccelerometerSample,
  GPSPoint,
  SafetyEvent,
  CrashReport,
  TripRecord,
  TripStatus,
  SafetyConfig,
  DEFAULT_SAFETY_CONFIG,
  SafetyScore,
} from './types';
import { SensorFusion } from './SensorFusion';
import { GPSTracker } from './GPSTracker';
import { EventDetector } from './EventDetector';
import { CrashReporter } from './CrashReporter';
import { SafetyScorer } from './SafetyScorer';

export interface TripSnapshot {
  status: TripStatus;
  tripId: string | null;
  startedAt: number | null;
  distanceM: number;
  events: SafetyEvent[];
  liveScore: SafetyScore | null;
  currentSpeedKmH: number;
  crashSuspected: boolean;
}

export type SnapshotHandler = (s: TripSnapshot) => void;
export type TripEndedHandler = (t: TripRecord) => void;

export class TripManager {
  private cfg: SafetyConfig;

  private fusion = new SensorFusion();
  private gps = new GPSTracker();
  private detector: EventDetector;
  private crash: CrashReporter;
  private scorer: SafetyScorer;

  private status: TripStatus = 'idle';
  private tripId: string | null = null;
  private startedAt: number | null = null;
  private events: SafetyEvent[] = [];
  private crashReport: CrashReport | null = null;
  private crashSuspected = false;
  private activeDurationMs = 0;
  private lastActiveT = 0;

  private snapshotHandler: SnapshotHandler | null = null;
  private tripEndedHandler: TripEndedHandler | null = null;

  private idCounter = 0;

  /** Speed source preference — OBD is preferred (higher rate, lower latency). */
  private lastOBDSpeedT = 0;
  /** If OBD hasn't updated in this window, we fall back to GPS speed. */
  private readonly OBD_STALE_MS = 2000;

  constructor(cfg: SafetyConfig = DEFAULT_SAFETY_CONFIG) {
    this.cfg = cfg;
    this.detector = new EventDetector(() => {
      const last = this.gps.getLast();
      return last ? { lat: last.lat, lng: last.lng } : null;
    }, cfg);
    this.detector.setListener((ev) => this.onEvent(ev));

    this.crash = new CrashReporter(
      cfg,
      () => {
        const last = this.gps.getLast();
        return last ? { lat: last.lat, lng: last.lng } : null;
      },
      () => this.gps.getRecent(),
    );
    this.crash.setHandlers(
      ({ t, peakG }) => {
        this.crashSuspected = true;
        this.pushSnapshot();
        // Record a crash-suspected event for the trip log; it will be
        // upgraded to a full CrashReport if confirmed.
        this.events.push({
          id: `crash_suspect_${t}_${++this.idCounter}`,
          type: 'crash',
          startedAt: t,
          endedAt: t,
          peak: peakG,
          severity: 5,
          location: this.gps.getLast()
            ? { lat: this.gps.getLast()!.lat, lng: this.gps.getLast()!.lng }
            : null,
          meta: { state: 'suspected' },
        });
      },
      (report) => {
        this.crashReport = report;
        this.crashSuspected = false;
        // Upgrade the previous crash event or add a new one.
        const existing = this.events.find(
          (e) => e.type === 'crash' && e.meta?.state === 'suspected',
        );
        if (existing) {
          existing.meta = { state: 'confirmed', peakG: report.peakG, featuresTriggered: report.featuresTriggered };
        } else {
          this.events.push({
            id: report.id,
            type: 'crash',
            startedAt: report.detectedAt,
            endedAt: report.detectedAt,
            peak: report.peakG,
            severity: 5,
            location: report.location,
            meta: { state: 'confirmed', featuresTriggered: report.featuresTriggered },
          });
        }
        this.pushSnapshot();
      },
    );

    this.scorer = new SafetyScorer(cfg);
  }

  setSnapshotHandler(h: SnapshotHandler): void {
    this.snapshotHandler = h;
  }

  setTripEndedHandler(h: TripEndedHandler): void {
    this.tripEndedHandler = h;
  }

  updateConfig(patch: Partial<SafetyConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.detector.updateConfig(patch);
    this.crash.updateConfig(patch);
    this.scorer.updateConfig(patch);
  }

  // ---------- Trip lifecycle ----------

  startTrip(t: number = Date.now()): string {
    if (this.status === 'active') return this.tripId!;
    this.fusion.reset();
    this.gps.reset();
    this.detector.reset();
    this.crash.reset();
    this.events = [];
    this.crashReport = null;
    this.crashSuspected = false;
    this.activeDurationMs = 0;
    this.lastActiveT = 0;

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
    const record: TripRecord = {
      id: this.tripId,
      startedAt: this.startedAt,
      endedAt: t,
      distanceM,
      activeDurationMs: this.activeDurationMs,
      events: this.events.slice(),
      trail: this.gps.getTrail().slice(),
      score: this.scorer.scoreTrip(this.events, distanceM, this.crashReport !== null),
      crash: this.crashReport,
    };

    this.tripEndedHandler?.(record);
    this.pushSnapshot();
    return record;
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  // ---------- Sensor ingestion ----------

  ingestOBDSpeed(speedKmH: number, t: number = Date.now()): void {
    if (this.status !== 'active') return;
    this.lastOBDSpeedT = t;
    const speedMPS = (speedKmH * 1000) / 3600;
    const longAccel = this.fusion.ingestSpeed(speedMPS, t);
    this.crash.ingestSpeed(speedKmH, t);
    this.accumulateActive(speedKmH, t);
    this.runDetectorTick(longAccel, speedKmH, t);
  }

  ingestGPS(point: GPSPoint): void {
    if (this.status !== 'active') return;
    const { accepted } = this.gps.ingest(point);
    if (!accepted) return;

    // If OBD is stale, use GPS speed as the speed source.
    const obdStale = point.t - this.lastOBDSpeedT > this.OBD_STALE_MS;
    if (obdStale && point.speedMPS !== null && point.speedMPS >= 0) {
      const speedKmH = point.speedMPS * 3.6;
      const longAccel = this.fusion.ingestSpeed(point.speedMPS, point.t);
      this.crash.ingestSpeed(speedKmH, point.t);
      this.accumulateActive(speedKmH, point.t);
      this.runDetectorTick(longAccel, speedKmH, point.t);
    }

    // Heading update feeds the centripetal-accel calculation for cornering.
    if (point.headingDeg !== null) {
      this.fusion.ingestHeading(point.headingDeg, point.t);
    }
  }

  ingestAccelerometer(sample: AccelerometerSample): void {
    if (this.status !== 'active') return;
    const linearMag = this.fusion.ingestAccelerometer(sample);
    this.crash.ingestAccel(sample, linearMag);
    // We don't call detector.tick() here — the detector is driven by
    // speed updates (OBD/GPS) which arrive at a slower rate. The
    // accelerometer only feeds the crash detector and the distraction
    // motion-signature check (handled via the next speed tick).
  }

  onAppBackground(t: number = Date.now()): void {
    if (this.status !== 'active') return;
    this.detector.onAppBackground(t);
  }

  onAppForeground(t: number = Date.now()): void {
    if (this.status !== 'active') return;
    this.detector.onAppForeground(t);
  }

  // ---------- internals ----------

  private runDetectorTick(longAccel: number, speedKmH: number, t: number): void {
    const lateral = this.fusion.getLateralAccel();
    const linearMag = this.fusion.getLinearMag();
    this.detector.tick({
      longitudinal: longAccel,
      lateral,
      speedKmH,
      linearMag,
      t,
    });
    this.pushSnapshot();
  }

  private accumulateActive(speedKmH: number, t: number): void {
    if (this.lastActiveT > 0 && speedKmH > 1) {
      const dt = t - this.lastActiveT;
      if (dt > 0 && dt < 5000) this.activeDurationMs += dt;
    }
    this.lastActiveT = t;
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
    });
  }
}

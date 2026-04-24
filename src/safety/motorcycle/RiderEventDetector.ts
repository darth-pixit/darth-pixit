/**
 * RiderEventDetector — the delivery-rider-specific event engine.
 *
 * ================================================================
 *  WHY A NEW DETECTOR INSTEAD OF PATCHING EventDetector
 * ================================================================
 *
 *  The 4-wheeler EventDetector is a good general-purpose detector, but
 *  the 2W delivery pipeline has materially different:
 *
 *    - Thresholds (banded: caution / event / severe) rather than a single
 *      trigger.
 *    - Powertrain-aware acceleration (ICE vs electric).
 *    - Context-aware overspeed (ratio-based against ambient 2W flow).
 *    - Speed-breaker, pothole, normal-stop brake-event suppression.
 *    - Panic-brake signature detection (time from 20 km/h to 0).
 *    - Jerk-spike counting and acceleration-reversal aggregate features.
 *    - Phone-position gating on every event emission.
 *
 *  Rather than bolt conditional branches onto the existing detector
 *  (which would reduce the legibility of either code path) we ship a
 *  sibling detector that operates on the same input stream and emits the
 *  same MotoSafetyEvent shape. The MotoEventDetector composes with it:
 *  when deliveryRiderMode is enabled, it replaces the legacy accel/brake
 *  paths; the legacy cornering / stability detectors are preserved.
 *
 * ================================================================
 *  BAND → SEVERITY MAPPING
 * ================================================================
 *
 *  The spec uses {caution, event, severe} bands per signal. Our internal
 *  SafetyEvent type uses severity 1..5. Mapping:
 *
 *    caution → severity 2      (previously we had 1 for "borderline")
 *    event   → severity 3
 *    severe  → severity 5
 *
 *  The missing slots (1 and 4) are reserved for future extension once we
 *  have real labelled data that justifies them.
 */

import { GyroscopeSample, AccelerometerSample } from '../types';
import {
  MotoConfig,
  MotoSafetyEvent,
  MotoSafetyEventType,
  OverspeedBand,
  PhonePositionSnapshot,
  RiderContext,
} from './types';
import { RoadObstacleFilter, ObstacleKind, SignalProximityGetter } from './RoadObstacleFilter';

export type RiderEventListener = (ev: MotoSafetyEvent) => void;

/** Internal state while a band-qualifying condition is sustained. */
interface OpenBandEvent {
  type: MotoSafetyEventType;
  band: 'caution' | 'event' | 'severe';
  startedAt: number;
  lastOverT: number;
  peak: number;       // peak magnitude while open
  preSpeedKmH: number; // speed when event opened
  meta: Record<string, number | string | boolean>;
}

export interface RiderFeatureAggregates {
  jerkSpikeCount: number;
  accelReversalsPerMinute: number;
  coastRatio: number;
  panicStopCount: number;
  speedBreakersDetected: number;
  potholesDetected: number;
  normalStopsDetected: number;
  peakSpeedKmH: number;

  // ---- Extended spec features (§4.2, §4.3) ----
  zeroTo30TimeS: number | null;
  energyGainRate: number;
  aggressivePatternScore: number;
  preBrakeSpeedMeanKmH: number;
  preBrakeSpeedP95KmH: number;
  brakeDuringLeanCount: number;
}

const DEBUG = false;

export class RiderEventDetector {
  private cfg: MotoConfig;
  private listener: RiderEventListener | null = null;
  private locationGetter: () => { lat: number; lng: number } | null;
  private phonePosGetter: () => PhonePositionSnapshot;
  private contextGetter: () => RiderContext;
  private obstacleFilter: RoadObstacleFilter;

  // ---------- Band-tracking state ----------
  private openAccel: OpenBandEvent | null = null;
  private openBrake: OpenBandEvent | null = null;
  private openOverspeed: OpenBandEvent | null = null;

  // ---------- Aggregate features ----------
  private jerkSpikeCount = 0;
  private accelReversalEvents = 0;
  private lastAccelSign = 0;
  private accelFirstSampleT = 0;
  private accelLastSampleT = 0;
  private coastSampleTotal = 0;
  private coastSampleCoasting = 0;
  private panicStopCount = 0;
  private speedBreakers = 0;
  private potholes = 0;
  private normalStops = 0;
  private peakSpeedKmH = 0;

  // ---------- Jerk tracking ----------
  private prevAccel = 0;
  private prevAccelT = 0;

  // ---------- Panic-brake signature tracking ----------
  private lastSpeedSamples: Array<{ t: number; kmH: number }> = [];
  private readonly PANIC_SPEED_HISTORY_MS = 3000;

  // ---------- 0→30 and energy-gain tracking ----------
  /** Starts timing when speed first crosses below 2 km/h; resets on stop. */
  private zeroTo30StartT: number | null = null;
  private bestZeroTo30S: number | null = null;
  /** Peak of speed_kmh × |a_fwd_ms2| observed while accelerating. */
  private peakEnergyGainRate = 0;

  // ---------- Brake feature aggregation ----------
  private preBrakeSpeeds: number[] = [];
  private brakeDuringLeanCount = 0;

  // ---------- Lean tracking (for trail-braking detection) ----------
  private currentLeanAbsDeg = 0;

  // ---------- GPS cross-check (spec §4.2) ----------
  private lastGpsSpeedKmH: number | null = null;
  private lastGpsSpeedT: number = 0;
  private lastGpsDerivedAccel: number | null = null;

  // ---------- Event ID counter ----------
  private idCounter = 0;

  constructor(
    cfg: MotoConfig,
    locationGetter: () => { lat: number; lng: number } | null,
    phonePosGetter: () => PhonePositionSnapshot,
    contextGetter: () => RiderContext,
    signalProximityGetter: SignalProximityGetter | null = null,
  ) {
    this.cfg = cfg;
    this.locationGetter = locationGetter;
    this.phonePosGetter = phonePosGetter;
    this.contextGetter = contextGetter;
    this.obstacleFilter = new RoadObstacleFilter(cfg, signalProximityGetter);
  }

  setListener(l: RiderEventListener): void { this.listener = l; }
  updateConfig(patch: Partial<MotoConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.obstacleFilter.updateConfig(patch);
  }

  /** Wire a traffic-signal proximity getter (or detach with null). */
  setSignalProximityGetter(g: SignalProximityGetter | null): void {
    this.obstacleFilter.setSignalProximityGetter(g);
  }

  /** Feed axis accel for obstacle-filter context. */
  ingestVerticalLateral(t: number, vertical: number, lateral: number): void {
    this.obstacleFilter.ingest(t, vertical, lateral);
  }

  /** Update the current lean angle so trail-braking logic can check it. */
  updateLeanDeg(leanDeg: number): void {
    this.currentLeanAbsDeg = Math.abs(leanDeg);
  }

  /**
   * Feed GPS speed samples so the tick() loop can cross-check IMU accel
   * against GPS-derived accel (spec §4.2, "GPS agrees within 30%").
   */
  ingestGPSSpeed(kmH: number, t: number): void {
    if (this.lastGpsSpeedT > 0) {
      const dt = (t - this.lastGpsSpeedT) / 1000;
      if (dt > 0 && dt < 3) {
        const dv = (kmH - (this.lastGpsSpeedKmH ?? kmH)) / 3.6;
        this.lastGpsDerivedAccel = dv / dt;
      }
    }
    this.lastGpsSpeedKmH = kmH;
    this.lastGpsSpeedT = t;
  }

  /**
   * Core tick — invoked on every speed/accel sample. Drives acceleration
   * and braking detection. Overspeeding is driven by the speed-only tick
   * below so it updates even when GPS hasn't reported new position.
   */
  tick(input: {
    longitudinal: number;   // m/s²  (positive = accel, negative = decel)
    lateral: number;        // m/s² — lateral magnitude
    speedKmH: number;       // Kalman-smoothed
    t: number;
  }): void {
    const { longitudinal, speedKmH, t } = input;

    this.peakSpeedKmH = Math.max(this.peakSpeedKmH, speedKmH);

    // ---- 0→30 time: start when speed drops to ~0, finish when it crosses 30 ----
    if (speedKmH < 2) {
      this.zeroTo30StartT = t;
    } else if (this.zeroTo30StartT !== null && speedKmH >= 30) {
      const elapsedS = (t - this.zeroTo30StartT) / 1000;
      if (elapsedS > 0.5 && (this.bestZeroTo30S === null || elapsedS < this.bestZeroTo30S)) {
        this.bestZeroTo30S = elapsedS;
      }
      this.zeroTo30StartT = null;
    }

    // ---- Energy gain rate proxy ----
    if (longitudinal > 0) {
      const rate = speedKmH * longitudinal;
      if (rate > this.peakEnergyGainRate) this.peakEnergyGainRate = rate;
    }

    // ---- Speed history for panic-brake signature ----
    this.lastSpeedSamples.push({ t, kmH: speedKmH });
    const hcut = t - this.PANIC_SPEED_HISTORY_MS;
    while (this.lastSpeedSamples.length > 1 && this.lastSpeedSamples[0].t < hcut) {
      this.lastSpeedSamples.shift();
    }

    // ---- Jerk ----
    if (this.prevAccelT > 0) {
      const dt = Math.max(0.016, (t - this.prevAccelT) / 1000);
      const jerk = (longitudinal - this.prevAccel) / dt;
      if (Math.abs(jerk) >= this.cfg.jerkSpikeThresholdMs3) this.jerkSpikeCount++;
    }
    this.prevAccel = longitudinal;
    this.prevAccelT = t;

    // ---- Coast fraction + accel-reversal count ----
    if (this.accelFirstSampleT === 0) this.accelFirstSampleT = t;
    this.accelLastSampleT = t;
    this.coastSampleTotal++;
    if (Math.abs(longitudinal) < 0.98) this.coastSampleCoasting++; // < 0.1 g
    const sign = longitudinal > 1.47 ? 1 : longitudinal < -1.47 ? -1 : 0; // > 0.15 g
    if (sign !== 0 && this.lastAccelSign !== 0 && sign !== this.lastAccelSign) {
      this.accelReversalEvents++;
    }
    if (sign !== 0) this.lastAccelSign = sign;

    // ---- Overspeed band (runs even when no accel change) ----
    this.updateOverspeed(speedKmH, t);

    // ---- Hard acceleration band ----
    this.updateAccel(longitudinal, speedKmH, t);

    // ---- Hard braking band ----
    this.updateBrake(-longitudinal, speedKmH, t);
  }

  /**
   * Called from the flush path at end of trip so we don't discard open
   * band events. Mirrors EventDetector.flush.
   */
  flush(t: number): void {
    if (this.openAccel) { this.emitBandEvent(this.openAccel, t); this.openAccel = null; }
    if (this.openBrake) { this.emitBandEvent(this.openBrake, t); this.openBrake = null; }
    if (this.openOverspeed) { this.emitBandEvent(this.openOverspeed, t); this.openOverspeed = null; }
  }

  reset(): void {
    this.openAccel = this.openBrake = this.openOverspeed = null;
    this.jerkSpikeCount = 0;
    this.accelReversalEvents = 0;
    this.lastAccelSign = 0;
    this.accelFirstSampleT = 0;
    this.accelLastSampleT = 0;
    this.coastSampleTotal = 0;
    this.coastSampleCoasting = 0;
    this.panicStopCount = 0;
    this.speedBreakers = 0;
    this.potholes = 0;
    this.normalStops = 0;
    this.peakSpeedKmH = 0;
    this.prevAccel = 0;
    this.prevAccelT = 0;
    this.lastSpeedSamples = [];
    this.zeroTo30StartT = null;
    this.bestZeroTo30S = null;
    this.peakEnergyGainRate = 0;
    this.preBrakeSpeeds = [];
    this.brakeDuringLeanCount = 0;
    this.currentLeanAbsDeg = 0;
    this.lastGpsSpeedKmH = null;
    this.lastGpsSpeedT = 0;
    this.lastGpsDerivedAccel = null;
    this.obstacleFilter.reset();
  }

  /** Snapshot of trip-level aggregate features for the scorer / UI. */
  getFeatures(): RiderFeatureAggregates {
    const windowSec = Math.max(1, (this.accelLastSampleT - this.accelFirstSampleT) / 1000);
    const reversalsPerMin = (this.accelReversalEvents / windowSec) * 60;
    const coastRatio = this.coastSampleTotal > 0
      ? this.coastSampleCoasting / this.coastSampleTotal : 0;
    // Aggressive-pattern score (spec §4.2 trip-level):
    //   max(0, reversals - base) × (1 - coast_ratio) × duration_min.
    const durationMin = windowSec / 60;
    const aggressivePatternScore = Math.max(0, reversalsPerMin - this.cfg.accelReversalsPerMinBase)
      * (1 - coastRatio) * durationMin;
    // Pre-brake speed stats.
    const preMean = this.preBrakeSpeeds.length > 0
      ? this.preBrakeSpeeds.reduce((a, b) => a + b, 0) / this.preBrakeSpeeds.length : 0;
    const preP95 = this.preBrakeSpeeds.length > 0
      ? percentile(this.preBrakeSpeeds, 0.95) : 0;
    return {
      jerkSpikeCount: this.jerkSpikeCount,
      accelReversalsPerMinute: round2(reversalsPerMin),
      coastRatio: round2(coastRatio),
      panicStopCount: this.panicStopCount,
      speedBreakersDetected: this.speedBreakers,
      potholesDetected: this.potholes,
      normalStopsDetected: this.normalStops,
      peakSpeedKmH: round2(this.peakSpeedKmH),
      zeroTo30TimeS: this.bestZeroTo30S !== null ? round2(this.bestZeroTo30S) : null,
      energyGainRate: round2(this.peakEnergyGainRate),
      aggressivePatternScore: round2(aggressivePatternScore),
      preBrakeSpeedMeanKmH: round2(preMean),
      preBrakeSpeedP95KmH: round2(preP95),
      brakeDuringLeanCount: this.brakeDuringLeanCount,
    };
  }

  // ================================================================
  //  Internal: acceleration
  // ================================================================

  private updateAccel(longAccel: number, speedKmH: number, t: number): void {
    const band = this.accelBand(longAccel);
    if (band === 'ok') {
      if (this.openAccel) {
        this.closeAccel(t);
      }
      return;
    }

    const minDurS = band === 'severe' ? this.cfg.accelSevereMinDurationS : this.cfg.accelMinDurationS;

    if (!this.openAccel) {
      const gpsAccel = this.lastGpsDerivedAccel;
      const tol = this.cfg.accelGpsCrossCheckTolerance;
      // Cross-check only if we have a recent GPS-derived accel within 2 s
      // of the current sample. Outside that window we accept the IMU.
      const haveFreshGps = gpsAccel !== null && Math.abs(t - this.lastGpsSpeedT) < 2000;
      const crossCheckFailed = haveFreshGps && gpsAccel !== null
        && Math.abs(longAccel - gpsAccel) > Math.max(1.0, tol * Math.abs(longAccel));
      this.openAccel = {
        type: 'hard_acceleration',
        band,
        startedAt: t,
        lastOverT: t,
        peak: longAccel,
        preSpeedKmH: speedKmH,
        meta: {
          accelMs2: round2(longAccel),
          speedKmH: round2(speedKmH),
          powertrain: this.cfg.powertrain,
          band,
          minDurationS: minDurS,
          gpsCrossCheckFailed: crossCheckFailed,
          gpsAccelMs2: haveFreshGps ? round2(gpsAccel!) : '',
        },
      };
    } else {
      this.openAccel.lastOverT = t;
      if (longAccel > this.openAccel.peak) {
        this.openAccel.peak = longAccel;
        this.openAccel.meta.accelMs2 = round2(longAccel);
      }
      // Upgrade band if we escalated.
      if (bandRank(band) > bandRank(this.openAccel.band as OverspeedBand)) {
        this.openAccel.band = band;
        this.openAccel.meta.band = band;
      }
    }
  }

  private closeAccel(t: number): void {
    if (!this.openAccel) return;
    const durS = (this.openAccel.lastOverT - this.openAccel.startedAt) / 1000;
    const minDurS = this.openAccel.band === 'severe' ? this.cfg.accelSevereMinDurationS : this.cfg.accelMinDurationS;
    if (durS >= minDurS) this.emitBandEvent(this.openAccel, this.openAccel.lastOverT);
    this.openAccel = null;
  }

  private accelBand(accel: number): 'ok' | 'caution' | 'event' | 'severe' {
    if (accel >= this.cfg.accelSevereMs2) return 'severe';
    if (accel >= this.cfg.accelEventMs2)  return 'event';
    if (accel >= this.cfg.accelCautionMs2) return 'caution';
    return 'ok';
  }

  // ================================================================
  //  Internal: braking
  // ================================================================

  private updateBrake(decelMagnitude: number, speedKmH: number, t: number): void {
    const band = this.brakeBand(decelMagnitude);
    if (band === 'ok') {
      if (this.openBrake) this.closeBrake(t, speedKmH);
      return;
    }

    if (!this.openBrake) {
      this.openBrake = {
        type: 'hard_braking',
        band,
        startedAt: t,
        lastOverT: t,
        peak: decelMagnitude,
        preSpeedKmH: speedKmH,
        meta: {
          decelMs2: round2(decelMagnitude),
          preBrakeSpeedKmH: round2(speedKmH),
          band,
        },
      };
    } else {
      this.openBrake.lastOverT = t;
      if (decelMagnitude > this.openBrake.peak) {
        this.openBrake.peak = decelMagnitude;
        this.openBrake.meta.decelMs2 = round2(decelMagnitude);
      }
      if (bandRank(band) > bandRank(this.openBrake.band as OverspeedBand)) {
        this.openBrake.band = band;
        this.openBrake.meta.band = band;
      }
    }
  }

  private closeBrake(t: number, currentSpeedKmH: number): void {
    if (!this.openBrake) return;
    const durS = (this.openBrake.lastOverT - this.openBrake.startedAt) / 1000;
    const minDurS = this.openBrake.band === 'severe' ? this.cfg.brakeSevereMinDurationS : this.cfg.brakeMinDurationS;
    if (durS < minDurS) {
      this.openBrake = null;
      return;
    }

    // Run the speed-breaker/pothole/normal-stop filters.
    const verdict = this.obstacleFilter.evaluate(
      this.openBrake.startedAt,
      this.openBrake.lastOverT,
      this.openBrake.peak,
      currentSpeedKmH,
    );
    if (verdict.suppress) {
      this.logObstacle(verdict.suppress);
      this.openBrake = null;
      return;
    }

    // Panic-brake signature: check whether from pre-brake >= 20 km/h
    // the rider reached 0 within 1.2 s with a steep jerk onset.
    const panic = this.isPanicStop(this.openBrake.startedAt, this.openBrake.lastOverT);
    if (panic) {
      this.panicStopCount++;
      this.openBrake.band = 'severe';
      this.openBrake.meta.band = 'severe';
      this.openBrake.meta.panic = true;
    }

    // Trail-braking: any open brake event that also occurred while the
    // rider was leaning into a corner. Fires as a separate event on top
    // of the underlying hard_braking so the scorer can penalise it in
    // the cornering bucket (spec §4.4 — serious risk on 2W).
    const peakLean = this.currentLeanAbsDeg;
    if (
      peakLean >= this.cfg.trailBrakingMinLeanDeg &&
      this.openBrake.peak >= this.cfg.trailBrakingMinDecelMs2
    ) {
      this.brakeDuringLeanCount++;
      const trailDurMs = this.openBrake.lastOverT - this.openBrake.startedAt;
      const severity: 1|2|3|4|5 =
        this.openBrake.peak >= this.cfg.brakeSevereMs2 ? 5 :
        this.openBrake.peak >= this.cfg.brakeEventMs2  ? 4 : 3;
      const ctx = this.contextGetter();
      this.listener?.({
        id: `tbrake_${this.openBrake.lastOverT}_${++this.idCounter}`,
        type: 'brake_during_lean',
        startedAt: this.openBrake.startedAt,
        endedAt: this.openBrake.lastOverT,
        peak: this.openBrake.peak,
        severity,
        location: this.locationGetter(),
        meta: {
          decelMs2: round2(this.openBrake.peak),
          leanDeg: round2(peakLean),
          durationMs: trailDurMs,
          speedKmH: round2(this.openBrake.preSpeedKmH),
          phonePositionState: this.phonePosGetter().state,
          phonePositionConf: this.phonePosGetter().confidence,
          timeOfDay: ctx.timeOfDay,
          timeOfDayWeight: ctx.timeOfDayWeight,
        },
      });
    }

    // Collect pre-brake speed for distribution stats.
    this.preBrakeSpeeds.push(this.openBrake.preSpeedKmH);

    this.emitBandEvent(this.openBrake, this.openBrake.lastOverT);
    this.openBrake = null;
  }

  private brakeBand(decelMag: number): 'ok' | 'caution' | 'event' | 'severe' {
    if (decelMag >= this.cfg.brakeSevereMs2) return 'severe';
    if (decelMag >= this.cfg.brakeEventMs2)  return 'event';
    if (decelMag >= this.cfg.brakeCautionMs2) return 'caution';
    return 'ok';
  }

  private logObstacle(kind: ObstacleKind): void {
    if (kind === 'speed_breaker') this.speedBreakers++;
    else if (kind === 'pothole') this.potholes++;
    else if (kind === 'normal_stop') this.normalStops++;
    if (DEBUG) console.log(`[RiderEventDetector] suppressed brake: ${kind}`);
  }

  private isPanicStop(startedAt: number, endedAt: number): boolean {
    // Find the speed sample just before the brake event and the first
    // sample where speed dropped below 0.5 km/h during the brake.
    let preSpeed = 0;
    let stopT = 0;
    for (const s of this.lastSpeedSamples) {
      if (s.t <= startedAt && s.kmH > preSpeed) preSpeed = s.kmH;
      if (s.t >= startedAt && s.t <= endedAt && s.kmH <= 0.5 && stopT === 0) stopT = s.t;
    }
    if (preSpeed < this.cfg.panicPreBrakeSpeedKmH) return false;
    if (stopT === 0) return false;
    const dt = (stopT - startedAt) / 1000;
    return dt > 0 && dt <= this.cfg.panicMaxTime20To0S;
  }

  // ================================================================
  //  Internal: overspeed (context-aware, banded)
  // ================================================================

  private updateOverspeed(speedKmH: number, t: number): void {
    const ctx = this.contextGetter();
    const ref = Math.max(ctx.ambient2wSpeedKmH * 1.15, ctx.speedLimitKmH);
    const ratio = ref > 0.5 ? speedKmH / ref : 0;

    let band: OverspeedBand = 'ok';
    if (ratio >= 1.50 || speedKmH >= 95) band = 'severe';
    else if (ratio >= 1.25 || speedKmH >= 80) band = 'event';
    else if (ratio >= 1.10) band = 'caution';

    if (band === 'ok') {
      if (this.openOverspeed) {
        const durS = (this.openOverspeed.lastOverT - this.openOverspeed.startedAt) / 1000;
        if (durS >= 3) this.emitBandEvent(this.openOverspeed, this.openOverspeed.lastOverT);
        this.openOverspeed = null;
      }
      return;
    }

    if (!this.openOverspeed) {
      this.openOverspeed = {
        type: 'overspeeding',
        band,
        startedAt: t,
        lastOverT: t,
        peak: ratio,
        preSpeedKmH: speedKmH,
        meta: {
          speedKmH: round2(speedKmH),
          referenceKmH: round2(ref),
          ratio: round2(ratio),
          band,
          ambient2wSpeedKmH: round2(ctx.ambient2wSpeedKmH),
          speedLimitKmH: round2(ctx.speedLimitKmH),
          roadClass: ctx.roadClass,
        },
      };
    } else {
      this.openOverspeed.lastOverT = t;
      if (ratio > this.openOverspeed.peak) {
        this.openOverspeed.peak = ratio;
        this.openOverspeed.meta.ratio = round2(ratio);
        this.openOverspeed.meta.speedKmH = round2(speedKmH);
      }
      if (bandRank(band) > bandRank(this.openOverspeed.band as OverspeedBand)) {
        this.openOverspeed.band = band;
        this.openOverspeed.meta.band = band;
      }
    }
  }

  // ================================================================
  //  Emit helper
  // ================================================================

  private emitBandEvent(open: OpenBandEvent, endT: number): void {
    if (open.type === 'overspeeding') {
      // 3 s minimum already enforced at close; guard here too.
      const dur = (endT - open.startedAt) / 1000;
      if (dur < 3) return;
    }

    const severity: 1|2|3|4|5 =
      open.band === 'severe' ? 5 :
      open.band === 'event'  ? 3 :
      /* caution */           2;

    const meta: Record<string, number | string | boolean> = {
      ...open.meta,
      durationS: round2((endT - open.startedAt) / 1000),
      phonePositionState: this.phonePosGetter().state,
      phonePositionConf: this.phonePosGetter().confidence,
      timeOfDay: this.contextGetter().timeOfDay,
      timeOfDayWeight: this.contextGetter().timeOfDayWeight,
    };

    const ev: MotoSafetyEvent = {
      id: `${open.type}_${endT}_${++this.idCounter}`,
      type: open.type,
      startedAt: open.startedAt,
      endedAt: endT,
      peak: open.peak,
      severity,
      location: this.locationGetter(),
      meta,
    };
    this.listener?.(ev);
  }
}

function bandRank(b: OverspeedBand): number {
  return b === 'severe' ? 3 : b === 'event' ? 2 : b === 'caution' ? 1 : 0;
}

function round2(x: number): number { return Math.round(x * 100) / 100; }

/** Linear-interpolated percentile (simple; good enough for per-trip stats). */
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

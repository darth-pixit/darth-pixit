/**
 * CarEventDetector — event detection for 4W fleet vehicles.
 *
 * Detects:
 *   hard_acceleration   — forward accel above per-class thresholds
 *   hard_braking        — deceleration above thresholds (with ABS compaction
 *                         and engine-braking false-positive filter)
 *   hard_cornering      — combined g-g circle sqrt(a_fwd² + a_lat²)
 *   lane_change         — S-shape two-phase lateral profile (via LaneChangeDetector)
 *   overspeeding        — speed above limit + buffer for > minDuration
 *   seatbelt_off        — OBD seatbelt PID reports unfastened while moving
 *   engine_abuse        — over-rev, lugging, sustained high load, overheating
 *   idling              — RPM > 600 AND speed = 0 for ≥ 60 s
 *
 * Does NOT detect phone_use (handled in CarTripManager), crash (separate
 * crash reporter), or drowsy_driving (DrowsinessDetector).
 *
 * ================================================================
 *  ABS PULSING COMPACTION
 * ================================================================
 *
 *  ABS modulates brake pressure at 5–15 Hz, creating rapid sign-
 *  oscillations in forward acceleration during maximum stops. Without
 *  compaction, the banded brake detector would fire multiple caution/
 *  event bursts on the same real deceleration.
 *
 *  Implementation:
 *    During an open brake event, we count zero-crossings of a_fwd within
 *    each 200ms window. If the crossing rate falls in [5, 15] Hz AND we
 *    see at least 3 cycles, we mark the brake event as ABS-pulsed and:
 *      1. Suppress individual sub-events.
 *      2. On brake-end, emit a single compacted hard_braking event with
 *         the peak amplitude seen across the entire ABS episode.
 *
 * ================================================================
 *  ENGINE-BRAKING FILTER
 * ================================================================
 *
 *  On a downhill with closed throttle, forward decel can reach 0.2–0.3g
 *  purely from engine braking — no driver input. We suppress brake events
 *  when:
 *    throttle ≈ 0%   (OBD, < 2% threshold)
 *    |a_fwd| < engineBrakeMaxDecelMs2  (default 0.25g)
 *    estimated road grade > engineBrakeMinGradePct (default 3%)
 *
 *  Grade is estimated from GPS altitude derivative:
 *    grade% = (dAlt_m / dDist_m) × 100
 *  When GPS altitude is unavailable, the grade is assumed 0 and the filter
 *  does not suppress (conservative — better a false positive than a miss).
 *
 * ================================================================
 *  ROUNDABOUT SUPPRESSION
 * ================================================================
 *
 *  Roundabout cornering is by definition controlled circular motion.
 *  OSM tags it as junction:roundabout. When the ContextEnrichmentService
 *  flags `isRoundabout=true` AND combined_g < roundaboutMaxCombinedGMs2,
 *  we suppress hard_cornering events.
 */

import { CarConfig, CarSafetyEvent, CarSafetyEventType, EngineAbuseSubtype } from './types';
import { LaneChangeDetector, LaneChangeListener } from './LaneChangeDetector';

export type CarEventListener = (ev: CarSafetyEvent) => void;

interface OBDLive {
  throttlePct: number | null;
  rpm: number | null;
  speedKmH: number | null;
  engineLoadPct: number | null;
  coolantC: number | null;
  seatbeltFastened: boolean | null;
  t: number;
}

/** Internal open-event state while a condition is sustained. */
interface OpenEvent {
  type: CarSafetyEventType;
  startedAt: number;
  lastT: number;
  peak: number;
  preSpeedKmH: number;
  absPulsed: boolean;
  meta: Record<string, number | string | boolean>;
}

/** Altitude + distance pair for grade estimation. */
interface AltitudeSample {
  altM: number;
  distM: number;
}

export class CarEventDetector {
  private cfg: CarConfig;
  private listener: CarEventListener | null = null;
  private locationGetter: () => { lat: number; lng: number } | null;
  private idCounter = 0;

  // ---- Motion state ----
  private currentSpeedKmH = 0;
  private speedLimitKmH: number;

  // ---- Open events ----
  private openAccel: OpenEvent | null = null;
  private openBrake: OpenEvent | null = null;
  private openCorner: OpenEvent | null = null;
  private openOverspeed: OpenEvent | null = null;
  private openSeatbelt: OpenEvent | null = null;
  private openIdling: OpenEvent | null = null;
  private openEngineAbuse: OpenEvent | null = null;

  // ---- ABS compaction ----
  /** Sign of a_fwd on the previous tick (for zero-crossing counting). */
  private prevAccelSign = 0;
  private absZeroCrossingsInWindow = 0;
  private absWindowStartT = 0;
  private absPulseCyclesTotal = 0;

  // ---- Engine-braking filter ----
  private altitudeSamples: AltitudeSample[] = [];
  private tripDistanceM = 0;
  private currentGradePct = 0;

  // ---- OBD live data ----
  private lastOBD: OBDLive = {
    throttlePct: null, rpm: null, speedKmH: null,
    engineLoadPct: null, coolantC: null, seatbeltFastened: null, t: 0,
  };

  // ---- Roundabout ----
  private isRoundabout = false;

  // ---- Lane change detector ----
  private laneChange: LaneChangeDetector;

  // ---- Overspeed ----
  private activeSpeedLimitKmH: number;

  constructor(
    cfg: CarConfig,
    locationGetter: () => { lat: number; lng: number } | null,
  ) {
    this.cfg = cfg;
    this.locationGetter = locationGetter;
    this.speedLimitKmH = cfg.absoluteSpeedLimitKmH;
    this.activeSpeedLimitKmH = cfg.absoluteSpeedLimitKmH;

    this.laneChange = new LaneChangeDetector(cfg);
  }

  setListener(l: CarEventListener): void {
    this.listener = l;
    this.laneChange.setListener((ev) => {
      if (!this.listener) return;
      const severity = ev.severity;
      this.emit({
        id: `lc_${ev.endedAt}_${++this.idCounter}`,
        type: 'lane_change',
        startedAt: ev.startedAt,
        endedAt: ev.endedAt,
        peak: ev.peakLatMs2,
        severity,
        location: this.locationGetter(),
        meta: {
          ...ev.meta,
          netHeadingChangeDeg: round2(ev.netHeadingChangeDeg),
          speedKmH: round2(this.currentSpeedKmH),
        },
      });
    });
  }

  updateConfig(patch: Partial<CarConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.laneChange.updateConfig(patch);
    this.speedLimitKmH = this.cfg.absoluteSpeedLimitKmH;
    this.activeSpeedLimitKmH = this.speedLimitKmH;
  }

  /** Called by ContextEnrichmentService when the segment speed limit updates. */
  setSpeedLimitKmH(kmH: number): void {
    this.activeSpeedLimitKmH = kmH;
  }

  /** Called when OSM reports a roundabout junction for the current segment. */
  setRoundabout(inRoundabout: boolean): void {
    this.isRoundabout = inRoundabout;
  }

  /** Receive fresh OBD telemetry. */
  ingestOBD(data: Partial<OBDLive>): void {
    this.lastOBD = { ...this.lastOBD, ...data, t: data.t ?? Date.now() };
    this.checkIdling(data.t ?? Date.now());
    this.checkEngineAbuse(data.t ?? Date.now());
    this.checkSeatbelt(data.t ?? Date.now());
  }

  /** Push a GPS altitude + cumulative trip distance for grade estimation. */
  ingestAltitude(altM: number, distM: number): void {
    this.tripDistanceM = distM;
    this.altitudeSamples.push({ altM, distM });
    if (this.altitudeSamples.length > 20) this.altitudeSamples.shift();
    this.updateGrade();
  }

  /**
   * Main motion tick. Call on every speed/accel update.
   *
   * @param longitudinal  Forward accel m/s² (positive = accel, negative = brake)
   * @param lateral       Lateral accel m/s² (positive = right turn)
   * @param speedKmH      Current speed km/h
   * @param headingDeg    Current heading degrees (for lane-change detection)
   * @param t             Timestamp ms
   */
  tick(longitudinal: number, lateral: number, speedKmH: number, headingDeg: number | null, t: number): void {
    this.currentSpeedKmH = speedKmH;
    const combinedG = Math.sqrt(longitudinal * longitudinal + lateral * lateral);

    this.checkAccel(longitudinal, speedKmH, t);
    this.checkBrake(longitudinal, speedKmH, t);
    this.checkCornering(combinedG, lateral, speedKmH, t);
    this.checkOverspeed(speedKmH, t);
    this.laneChange.ingest(t, lateral, headingDeg);

    this.updateABSWindow(longitudinal, t);
  }

  flush(t: number): void {
    if (this.openAccel) this.closeAccel(t);
    if (this.openBrake) this.closeBrake(t);
    if (this.openCorner) this.closeCorner(t);
    if (this.openOverspeed) this.closeOverspeed(t);
    if (this.openSeatbelt) this.closeSeatbelt(t);
    if (this.openIdling) this.closeIdling(t);
    if (this.openEngineAbuse) this.closeEngineAbuse(t);
  }

  reset(): void {
    this.openAccel = null;
    this.openBrake = null;
    this.openCorner = null;
    this.openOverspeed = null;
    this.openSeatbelt = null;
    this.openIdling = null;
    this.openEngineAbuse = null;
    this.prevAccelSign = 0;
    this.absZeroCrossingsInWindow = 0;
    this.absWindowStartT = 0;
    this.absPulseCyclesTotal = 0;
    this.altitudeSamples = [];
    this.tripDistanceM = 0;
    this.currentGradePct = 0;
    this.currentSpeedKmH = 0;
    this.isRoundabout = false;
    this.lastOBD = { throttlePct: null, rpm: null, speedKmH: null,
      engineLoadPct: null, coolantC: null, seatbeltFastened: null, t: 0 };
    this.laneChange.reset();
  }

  // ──────────────────────────────────────────────────────
  // Hard acceleration
  // ──────────────────────────────────────────────────────

  private checkAccel(a: number, speedKmH: number, t: number): void {
    const { accelCautionMs2, accelEventMs2, accelSevereMs2, accelMinDurationS } = this.cfg;

    if (a >= accelCautionMs2) {
      if (!this.openAccel) {
        this.openAccel = {
          type: 'hard_acceleration', startedAt: t, lastT: t,
          peak: a, preSpeedKmH: speedKmH, absPulsed: false, meta: {},
        };
      } else {
        this.openAccel.lastT = t;
        if (a > this.openAccel.peak) this.openAccel.peak = a;
      }
    } else if (this.openAccel) {
      const gap = t - this.openAccel.lastT;
      if (gap > this.cfg.maxEventGapS * 1000) {
        this.closeAccel(t);
      }
    }

    void accelEventMs2; void accelSevereMs2; void accelMinDurationS;
  }

  private closeAccel(t: number): void {
    const ev = this.openAccel;
    this.openAccel = null;
    if (!ev) return;
    const durS = (ev.lastT - ev.startedAt) / 1000;
    if (durS < this.cfg.accelMinDurationS) return;
    const { accelCautionMs2, accelEventMs2, accelSevereMs2 } = this.cfg;
    const band: 1|2|3 = ev.peak >= accelSevereMs2 ? 3 : ev.peak >= accelEventMs2 ? 2 : 1;
    const severity: 1|2|3|4|5 = band === 3 ? 5 : band === 2 ? 3 : 2;
    void accelCautionMs2;
    this.emit({
      id: `accel_${ev.lastT}_${++this.idCounter}`,
      type: 'hard_acceleration',
      startedAt: ev.startedAt,
      endedAt: ev.lastT,
      peak: ev.peak,
      severity,
      location: this.locationGetter(),
      meta: { peakMs2: round2(ev.peak), speedKmH: round2(ev.preSpeedKmH), durationS: round2(durS) },
    });
  }

  // ──────────────────────────────────────────────────────
  // Hard braking — with ABS compaction + engine-brake filter
  // ──────────────────────────────────────────────────────

  private checkBrake(a: number, speedKmH: number, t: number): void {
    const decel = -a; // positive = braking
    const { brakeCautionMs2, brakeEventMs2, brakeSevereMs2, brakeMinDurationS } = this.cfg;
    void brakeEventMs2; void brakeSevereMs2; void brakeMinDurationS;

    if (decel >= brakeCautionMs2) {
      // Engine-braking filter: suppress if throttle ≈ 0% and grade > threshold.
      if (this.isEngineBraking(decel)) return;

      // Normal-stop gate: gentle stop to zero is not flagged.
      if (speedKmH <= this.cfg.normalStopEndSpeedKmH &&
          decel < this.cfg.normalStopPeakMs2) {
        if (this.openBrake) this.openBrake = null;
        return;
      }

      if (!this.openBrake) {
        this.openBrake = {
          type: 'hard_braking', startedAt: t, lastT: t,
          peak: decel, preSpeedKmH: speedKmH, absPulsed: false, meta: {},
        };
      } else {
        this.openBrake.lastT = t;
        if (decel > this.openBrake.peak) this.openBrake.peak = decel;
        if (this.isABSPulsing()) this.openBrake.absPulsed = true;
      }
    } else if (this.openBrake) {
      const gap = t - this.openBrake.lastT;
      if (gap > this.cfg.maxEventGapS * 1000) {
        this.closeBrake(t);
      }
    }
  }

  private closeBrake(t: number): void {
    const ev = this.openBrake;
    this.openBrake = null;
    if (!ev) return;
    const durS = (ev.lastT - ev.startedAt) / 1000;
    if (durS < this.cfg.brakeMinDurationS) return;
    const { brakeCautionMs2, brakeEventMs2, brakeSevereMs2 } = this.cfg;
    void brakeCautionMs2;
    const band: 1|2|3 = ev.peak >= brakeSevereMs2 ? 3 : ev.peak >= brakeEventMs2 ? 2 : 1;
    const severity: 1|2|3|4|5 = band === 3 ? 5 : band === 2 ? 3 : 2;
    this.emit({
      id: `brake_${ev.lastT}_${++this.idCounter}`,
      type: 'hard_braking',
      startedAt: ev.startedAt,
      endedAt: ev.lastT,
      peak: ev.peak,
      severity,
      location: this.locationGetter(),
      meta: {
        peakMs2: round2(ev.peak),
        preSpeedKmH: round2(ev.preSpeedKmH),
        durationS: round2(durS),
        absPulsed: ev.absPulsed,
      },
    });
  }

  // ──────────────────────────────────────────────────────
  // Hard cornering — g-g circle
  // ──────────────────────────────────────────────────────

  private checkCornering(combinedG: number, lateral: number, speedKmH: number, t: number): void {
    const { combinedGCautionMs2, combinedGEventMs2, combinedGSevereMs2, combinedGMinDurationS } = this.cfg;
    void combinedGEventMs2; void combinedGSevereMs2; void combinedGMinDurationS;

    // Roundabout suppression: calm roundabout traversal is not flagged.
    if (this.isRoundabout && combinedG < this.cfg.roundaboutMaxCombinedGMs2) return;

    if (combinedG >= combinedGCautionMs2 && speedKmH > 10) {
      if (!this.openCorner) {
        this.openCorner = {
          type: 'hard_cornering', startedAt: t, lastT: t,
          peak: combinedG, preSpeedKmH: speedKmH, absPulsed: false,
          meta: { firstLateralMs2: round2(lateral) },
        };
      } else {
        this.openCorner.lastT = t;
        if (combinedG > this.openCorner.peak) this.openCorner.peak = combinedG;
      }
    } else if (this.openCorner) {
      const gap = t - this.openCorner.lastT;
      if (gap > this.cfg.maxEventGapS * 1000) {
        this.closeCorner(t);
      }
    }
  }

  private closeCorner(t: number): void {
    const ev = this.openCorner;
    this.openCorner = null;
    if (!ev) return;
    const durS = (ev.lastT - ev.startedAt) / 1000;
    if (durS < this.cfg.combinedGMinDurationS) return;
    const { combinedGCautionMs2, combinedGEventMs2, combinedGSevereMs2 } = this.cfg;
    void combinedGCautionMs2;
    const severity: 1|2|3|4|5 =
      ev.peak >= combinedGSevereMs2 ? 5 :
      ev.peak >= combinedGEventMs2  ? 3 : 2;
    this.emit({
      id: `corner_${ev.lastT}_${++this.idCounter}`,
      type: 'hard_cornering',
      startedAt: ev.startedAt,
      endedAt: ev.lastT,
      peak: ev.peak,
      severity,
      location: this.locationGetter(),
      meta: {
        combinedGMs2: round2(ev.peak),
        speedKmH: round2(ev.preSpeedKmH),
        durationS: round2(durS),
        inRoundabout: this.isRoundabout,
      },
    });
  }

  // ──────────────────────────────────────────────────────
  // Overspeeding
  // ──────────────────────────────────────────────────────

  private checkOverspeed(speedKmH: number, t: number): void {
    const limit = this.activeSpeedLimitKmH;
    const over = speedKmH - limit - this.cfg.overspeedBufferKmH;

    if (over > 0) {
      if (!this.openOverspeed) {
        this.openOverspeed = {
          type: 'overspeeding', startedAt: t, lastT: t,
          peak: speedKmH, preSpeedKmH: speedKmH, absPulsed: false,
          meta: { limitKmH: limit },
        };
      } else {
        this.openOverspeed.lastT = t;
        if (speedKmH > this.openOverspeed.peak) this.openOverspeed.peak = speedKmH;
      }
    } else if (this.openOverspeed) {
      this.closeOverspeed(t);
    }
  }

  private closeOverspeed(t: number): void {
    const ev = this.openOverspeed;
    this.openOverspeed = null;
    if (!ev) return;
    const durS = (ev.lastT - ev.startedAt) / 1000;
    if (durS < this.cfg.minOverspeedDurationS) return;
    const limitKmH = ev.meta.limitKmH as number;
    const excess = ev.peak - limitKmH;
    const severity: 1|2|3|4|5 =
      excess >= 40 ? 5 : excess >= 25 ? 4 : excess >= 15 ? 3 : excess >= 8 ? 2 : 1;
    this.emit({
      id: `overspeed_${ev.lastT}_${++this.idCounter}`,
      type: 'overspeeding',
      startedAt: ev.startedAt,
      endedAt: ev.lastT,
      peak: ev.peak,
      severity,
      location: this.locationGetter(),
      meta: { peakKmH: round2(ev.peak), limitKmH, excessKmH: round2(excess), durationS: round2(durS) },
    });
  }

  // ──────────────────────────────────────────────────────
  // Idling (OBD-driven)
  // ──────────────────────────────────────────────────────

  private checkIdling(t: number): void {
    const { rpm, speedKmH } = this.lastOBD;
    if (rpm === null || speedKmH === null) return;

    const isIdle = rpm > this.cfg.idleRPMMin && speedKmH <= this.cfg.idleSpeedMaxKmH;

    if (isIdle) {
      if (!this.openIdling) {
        this.openIdling = {
          type: 'idling', startedAt: t, lastT: t,
          peak: rpm, preSpeedKmH: speedKmH, absPulsed: false, meta: {},
        };
      } else {
        this.openIdling.lastT = t;
        if (rpm > this.openIdling.peak) this.openIdling.peak = rpm;
      }
    } else if (this.openIdling) {
      this.closeIdling(t);
    }
  }

  private closeIdling(t: number): void {
    const ev = this.openIdling;
    this.openIdling = null;
    if (!ev) return;
    const durS = (ev.lastT - ev.startedAt) / 1000;
    if (durS < this.cfg.idleMinDurationS) return;
    const severity: 1|2|3|4|5 =
      durS >= 600 ? 5 : durS >= 300 ? 4 : durS >= 180 ? 3 : durS >= 90 ? 2 : 1;
    this.emit({
      id: `idle_${ev.lastT}_${++this.idCounter}`,
      type: 'idling',
      startedAt: ev.startedAt,
      endedAt: ev.lastT,
      peak: ev.peak,
      severity,
      location: this.locationGetter(),
      meta: { durationS: round2(durS), peakRPM: ev.peak },
    });
  }

  // ──────────────────────────────────────────────────────
  // Engine abuse
  // ──────────────────────────────────────────────────────

  private checkEngineAbuse(t: number): void {
    const { rpm, engineLoadPct, coolantC, throttlePct, speedKmH } = this.lastOBD;
    const subtype = this.currentAbuseSubtype(rpm, engineLoadPct, coolantC, throttlePct, speedKmH);

    if (subtype) {
      if (!this.openEngineAbuse) {
        const peakVal =
          subtype === 'over_rev'    ? (rpm ?? 0) :
          subtype === 'overheating' ? (coolantC ?? 0) :
          subtype === 'high_load'   ? (engineLoadPct ?? 0) :
          (throttlePct ?? 0);
        this.openEngineAbuse = {
          type: 'engine_abuse', startedAt: t, lastT: t,
          peak: peakVal, preSpeedKmH: speedKmH ?? 0, absPulsed: false,
          meta: { subtype },
        };
      } else {
        this.openEngineAbuse.lastT = t;
      }
    } else if (this.openEngineAbuse) {
      this.closeEngineAbuse(t);
    }
  }

  private currentAbuseSubtype(
    rpm: number | null,
    loadPct: number | null,
    coolantC: number | null,
    throttlePct: number | null,
    speedKmH: number | null,
  ): EngineAbuseSubtype | null {
    if (coolantC !== null && coolantC >= this.cfg.overheatCoolantC) return 'overheating';
    if (rpm !== null && rpm >= this.cfg.vehicleRedlineRPM * this.cfg.overRevThresholdPct) return 'over_rev';
    if (
      this.cfg.transmission === 'manual' &&
      rpm !== null && rpm < this.cfg.luggingMaxRPM &&
      throttlePct !== null && throttlePct > this.cfg.luggingMinThrottlePct
    ) return 'lugging';
    if (
      loadPct !== null && loadPct > this.cfg.highLoadThresholdPct &&
      (speedKmH ?? 0) < this.cfg.highLoadAboveSpeedKmH
    ) return 'high_load';
    return null;
  }

  private closeEngineAbuse(t: number): void {
    const ev = this.openEngineAbuse;
    this.openEngineAbuse = null;
    if (!ev) return;
    const durS = (ev.lastT - ev.startedAt) / 1000;
    const subtype = ev.meta.subtype as EngineAbuseSubtype;
    const minDur = subtype === 'over_rev' ? this.cfg.overRevMinDurationS
      : subtype === 'overheating' ? 5
      : this.cfg.highLoadMinDurationS;
    if (durS < minDur) return;
    const severity: 1|2|3|4|5 =
      subtype === 'overheating' ? 5 :
      subtype === 'over_rev'    ? 4 :
      durS >= 60                ? 4 : durS >= 30 ? 3 : 2;
    this.emit({
      id: `abuse_${ev.lastT}_${++this.idCounter}`,
      type: 'engine_abuse',
      startedAt: ev.startedAt,
      endedAt: ev.lastT,
      peak: ev.peak,
      severity,
      location: this.locationGetter(),
      meta: { subtype, durationS: round2(durS), speedKmH: round2(ev.preSpeedKmH) },
    });
  }

  // ──────────────────────────────────────────────────────
  // Seatbelt
  // ──────────────────────────────────────────────────────

  private checkSeatbelt(t: number): void {
    const caps = this.cfg.capabilities;
    if (!caps?.seatbeltPidSupported) return;

    const { seatbeltFastened, speedKmH } = this.lastOBD;
    if (seatbeltFastened === null || speedKmH === null) return;

    const isUnfastened = !seatbeltFastened && speedKmH >= this.cfg.seatbeltMinSpeedKmH;

    if (isUnfastened) {
      if (!this.openSeatbelt) {
        this.openSeatbelt = {
          type: 'seatbelt_off', startedAt: t, lastT: t,
          peak: speedKmH, preSpeedKmH: speedKmH, absPulsed: false, meta: {},
        };
      } else {
        this.openSeatbelt.lastT = t;
        if (speedKmH > this.openSeatbelt.peak) this.openSeatbelt.peak = speedKmH;
      }
    } else if (this.openSeatbelt) {
      this.closeSeatbelt(t);
    }
  }

  private closeSeatbelt(t: number): void {
    const ev = this.openSeatbelt;
    this.openSeatbelt = null;
    if (!ev) return;
    const durS = (ev.lastT - ev.startedAt) / 1000;
    if (durS < this.cfg.seatbeltMinDurationS) return;
    const severity: 1|2|3|4|5 =
      durS >= 120 ? 5 : durS >= 60 ? 4 : durS >= 30 ? 3 : durS >= 15 ? 2 : 1;
    this.emit({
      id: `sbelt_${ev.lastT}_${++this.idCounter}`,
      type: 'seatbelt_off',
      startedAt: ev.startedAt,
      endedAt: ev.lastT,
      peak: ev.peak,
      severity,
      location: this.locationGetter(),
      meta: { durationS: round2(durS), maxSpeedKmH: round2(ev.peak) },
    });
  }

  // ──────────────────────────────────────────────────────
  // ABS pulsing compaction helpers
  // ──────────────────────────────────────────────────────

  private updateABSWindow(a: number, t: number): void {
    const sign = a >= 0 ? 1 : -1;
    if (this.prevAccelSign !== 0 && sign !== this.prevAccelSign) {
      // Zero crossing
      this.absZeroCrossingsInWindow++;
    }
    this.prevAccelSign = sign;

    const windowMs = 200;
    if (t - this.absWindowStartT >= windowMs) {
      // crossings / windowSec → Hz
      const freqHz = (this.absZeroCrossingsInWindow / 2) / (windowMs / 1000);
      if (freqHz >= this.cfg.absPulseMinFreqHz && freqHz <= this.cfg.absPulseMaxFreqHz) {
        this.absPulseCyclesTotal += Math.floor(this.absZeroCrossingsInWindow / 2);
      }
      this.absZeroCrossingsInWindow = 0;
      this.absWindowStartT = t;
    }
  }

  private isABSPulsing(): boolean {
    return this.absPulseCyclesTotal >= this.cfg.absPulseMinCycles;
  }

  // ──────────────────────────────────────────────────────
  // Engine-braking filter helpers
  // ──────────────────────────────────────────────────────

  private updateGrade(): void {
    if (this.altitudeSamples.length < 3) return;
    const first = this.altitudeSamples[0];
    const last  = this.altitudeSamples[this.altitudeSamples.length - 1];
    const dDist = last.distM - first.distM;
    if (dDist < 20) return;
    this.currentGradePct = ((last.altM - first.altM) / dDist) * 100;
  }

  private isEngineBraking(decelMs2: number): boolean {
    const { throttlePct } = this.lastOBD;
    if (throttlePct === null) return false;
    return (
      throttlePct < 2 &&
      decelMs2 < this.cfg.engineBrakeMaxDecelMs2 &&
      this.currentGradePct > this.cfg.engineBrakeMinGradePct
    );
  }

  // ──────────────────────────────────────────────────────
  // Emit helper
  // ──────────────────────────────────────────────────────

  private emit(ev: CarSafetyEvent): void {
    this.listener?.(ev);
  }
}

function round2(x: number): number { return Math.round(x * 100) / 100; }

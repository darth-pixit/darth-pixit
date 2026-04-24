/**
 * MotoScorer — safety scoring calibrated for motorcycle accident data.
 *
 * ================================================================
 *  WHY THE WEIGHTS DIFFER FROM THE CAR SCORER
 * ================================================================
 *
 *  Weights are proportional to the fraction of fatal crashes each
 *  behaviour contributes, based on MAIDS (Motorcycle Accident In-Depth
 *  Study), EU COST 327, and NHTSA motorcycle fatality reports.
 *
 *    SPEEDING        30% (car: 25%)
 *      Speed is the #1 modifiable factor in motorcycle fatalities.
 *      At 100 km/h a motorcyclist has 7× the injury risk of a car
 *      occupant at the same speed. Speed also amplifies every other
 *      risk: lean limits are velocity-dependent, stopping distances
 *      grow quadratically.
 *
 *    CORNERING       25% (car: 20%)
 *      "Rider error in bend" is the #1 cause of single-vehicle moto
 *      crashes. Includes approaching bend too fast, running wide,
 *      and accelerating mid-corner. The car category is less dominant
 *      because 4-wheelers can physically sustain more lateral force
 *      before traction loss.
 *
 *    BRAKING         20% (car: 25%)
 *      Hard braking is important but slightly less weighted than for
 *      cars because: (a) many motorcycle crashes begin with a failure
 *      to brake correctly rather than over-braking, (b) on ABS-equipped
 *      bikes hard braking is safer than hard cornering.
 *
 *    DISTRACTED      15% (car: 15%)
 *      Unchanged. Phone-while-riding is extremely dangerous but its
 *      base rate is lower because there's literally nowhere to put
 *      the phone safely on a motorcycle.
 *
 *    ACCELERATION    10% (car: 15%)
 *      Reduced because: (a) motorcycles legitimately accelerate harder
 *      than cars in normal use; (b) forward acceleration rarely causes
 *      crashes directly (it can cause wheelspin, but modern bikes often
 *      have traction control); (c) the crash-causing version is captured
 *      by "corner_acceleration" (a separate event penalised under cornering).
 *
 *  NEW PENALTY CATEGORIES for moto-only events:
 *
 *    extreme_lean       → cornering penalty bucket (it IS a cornering risk)
 *    corner_acceleration → cornering penalty bucket (same risk chain)
 *    speed_wobble       → new bucket: 'stability' (see below)
 *    highside_risk      → new bucket: 'stability' (pre-crash pattern)
 *
 *    stability          → treated as a 6th category with weight 0% in
 *    (new)                the composite. These events appear in the UI
 *                         with their own severity display but do NOT
 *                         currently reduce the numeric score because
 *                         our detection is still experimental. They serve
 *                         as coaching alerts. This is honest: we know the
 *                         algorithm for speed wobble is probabilistic,
 *                         and penalising a rider for a sensor artifact
 *                         would destroy trust.
 *
 *                         When detection confidence improves (v2), these
 *                         can be given a non-zero weight.
 *
 *  PILLION PASSENGER MODIFIER
 *    When hasPassenger = true, braking penalty × 1.2 (longer stopping
 *    distance, higher crash severity for two people).
 *
 *  ABS MODIFIER
 *    When hasABS = false, braking penalty × 1.15 (higher consequence
 *    of hard braking: front-lock risk).
 */

import {
  TripRecord,
  SafetyScore,
  CategoryScore,
  WeatherCondition,
} from '../types';
import { MotoSafetyEvent, MotoConfig } from './types';
import { ScoringContext } from '../SafetyScorer';

/**
 * Legacy motorcycle weights — used when deliveryRiderMode is disabled.
 * Left intact so existing fleet integrations don't regress.
 */
const MOTO_WEIGHTS = {
  acceleration: 0.10,
  braking:      0.20,
  cornering:    0.25,
  speeding:     0.30,
  distracted:   0.15,
  stability:    0.00, // intentionally 0 — see notes above
} as const;

/**
 * Delivery-rider spec weights (§5.2). Sum = 1.0.
 *
 *   w_overspeed = 0.25
 *   w_brake     = 0.25
 *   w_phone     = 0.20
 *   w_accel     = 0.12
 *   w_corner    = 0.10
 *   w_swerve    = 0.05
 *   w_tilt      = 0.03   (absorbed into cornering bucket since we don't
 *                         score tilt independently — it's a feature)
 *
 *  tilt + cornering together = 0.13 in the delivery model. We assign
 *  cornering = 0.13 in the delivery weights below.
 */
const DELIVERY_WEIGHTS = {
  acceleration: 0.12,
  braking:      0.25,
  cornering:    0.13,
  speeding:     0.25,
  distracted:   0.20,  // phone_use events
  swerving:     0.05,
  stability:    0.00,  // still coaching-only
} as const;

const MIN_DIVISOR_KM = 1.0;
const PENALTY_SCALE  = 25;

export class MotoScorer {
  private cfg: MotoConfig;

  constructor(cfg: MotoConfig) {
    this.cfg = cfg;
  }

  updateConfig(patch: Partial<MotoConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  scoreTrip(
    events: MotoSafetyEvent[],
    distanceM: number,
    crashed: boolean,
    context: Partial<ScoringContext> = {},
  ): SafetyScore {
    const ctx = {
      recoveredEventIds: new Set<string>(),
      graceFactor: 1.0,
      weatherCondition: null as WeatherCondition | null,
      ...context,
    };

    const useDelivery = this.cfg.deliveryRiderMode;
    const weights = useDelivery ? DELIVERY_WEIGHTS : MOTO_WEIGHTS;

    const distKm = Math.max(distanceM / 1000, MIN_DIVISOR_KM);
    const split  = this.splitByBucket(events, useDelivery);

    const acceleration = this.scoreCategory(split.acceleration, distKm, 'acceleration', ctx);
    const braking      = this.scoreCategory(split.braking,      distKm, 'braking',      ctx);
    const cornering    = this.scoreCategory(split.cornering,     distKm, 'cornering',    ctx);
    const speeding     = this.scoreCategory(split.speeding,      distKm, 'speeding',     ctx);
    const distracted   = this.scoreCategory(split.distracted,    distKm, 'distracted',   ctx);
    const swerving     = useDelivery
      ? this.scoreCategory(split.swerving ?? [], distKm, 'swerving', ctx)
      : null;

    let composite = crashed ? 0 :
      weights.acceleration * acceleration.score +
      weights.braking      * braking.score +
      weights.cornering    * cornering.score +
      weights.speeding     * speeding.score +
      weights.distracted   * distracted.score;

    if (useDelivery && swerving) {
      composite += (weights as typeof DELIVERY_WEIGHTS).swerving * swerving.score;
    }

    return {
      composite: round(composite, 1),
      acceleration,
      braking,
      cornering,
      speeding,
      distracted,
      crashed,
      routeGraceFactor: ctx.graceFactor,
      weatherCondition: ctx.weatherCondition,
    };
  }

  lifetimeScore(trips: TripRecord[]): number | null {
    const scorable = trips.filter(t => t.score !== null && t.distanceM >= this.cfg.minScorableDistanceM);
    if (!scorable.length) return null;
    let wsum = 0, wtot = 0;
    for (const t of scorable) { wsum += t.score!.composite * t.distanceM; wtot += t.distanceM; }
    return wtot > 0 ? round(wsum / wtot, 1) : null;
  }

  private scoreCategory(
    events: MotoSafetyEvent[],
    distKm: number,
    bucket: 'acceleration' | 'braking' | 'cornering' | 'speeding' | 'distracted' | 'swerving',
    ctx: { recoveredEventIds: Set<string>; graceFactor: number },
  ): CategoryScore {
    let penalty = 0;
    let recoveredCount = 0;
    for (const ev of events) {
      let p = this.eventPenalty(ev, bucket);
      if (ev.severity <= 2 && ctx.graceFactor < 1.0) p *= ctx.graceFactor;
      if (ctx.recoveredEventIds.has(ev.id)) { p *= this.cfg.recoveryPenaltyFactor; recoveredCount++; }
      penalty += p;
    }
    const rate = penalty / distKm;
    return {
      score: round(Math.max(0, Math.min(100, 100 - rate * PENALTY_SCALE)), 1),
      penalty: round(penalty, 2),
      eventCount: events.length,
      recoveredCount,
    };
  }

  private eventPenalty(
    ev: MotoSafetyEvent,
    bucket: 'acceleration' | 'braking' | 'cornering' | 'speeding' | 'distracted' | 'swerving',
  ): number {
    const mult = severityMult(ev.severity);
    let base: number;

    switch (ev.type) {
      case 'hard_acceleration': {
        base = 0.5;
        // Speed-context penalty (spec §4.2): high-speed accel scores harder.
        const spd = numericMeta(ev, 'speedKmH') ?? 0;
        base *= Math.max(0.5, Math.pow(spd / 30, 2));
        // Traffic suppression: if ambient flow was very low, halve.
        const ambient = numericMeta(ev, 'ambient2wSpeedKmH');
        if (ambient !== null && ambient < 15) base *= 0.5;
        break;
      }
      case 'hard_braking': {
        base = 0.75;
        if (!this.cfg.hasABS)      base *= 1.15;
        if (this.cfg.hasPassenger) base *= 1.20;
        // Spec §4.3 quadratic speed factor — braking hard from high speed
        // is disproportionately dangerous.
        const preSpd = numericMeta(ev, 'preBrakeSpeedKmH') ?? 30;
        base *= Math.max(0.5, Math.pow(preSpd / 30, 2));
        // Panic signature: triple the base penalty.
        if (ev.meta?.panic === true) base *= 3.0;
        // Emergency-braking mitigation (same as car scorer, unchanged).
        if (ev.meta?.precededByHardAccel === false) base *= 0.6;
        break;
      }
      case 'panic_brake':          base = 2.25; break; // equivalent of 3× hard_braking
      case 'hard_cornering':       base = 0.75; break;
      case 'extreme_lean':         base = 1.00; break;
      case 'corner_acceleration':  base = 1.25; break;
      case 'overspeeding': {
        // Spec §4.1: event_score = duration × (ratio - 1)² × band_multiplier.
        const dur = Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
        const ratio = numericMeta(ev, 'ratio') ?? 1.0;
        const overshoot = Math.max(0, ratio - 1.0);
        const bandMult = ev.meta?.band === 'severe' ? 3.8
          : ev.meta?.band === 'event' ? 2.3
          : 1.4;
        base = 0.10 * dur * overshoot * overshoot * bandMult;
        break;
      }
      case 'phone_use': {
        const dur = Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
        const subtype = (ev.meta?.subtype as string | undefined) ?? 'handheld';
        const typeMult =
          subtype === 'texting'      ? 2.0 :
          subtype === 'distraction'  ? 1.5 :
          subtype === 'call'         ? 1.2 : 1.0;
        // Incorporate speed scaling — phone use at 40 km/h is twice as bad
        // as phone use at 20 km/h (crash energy scales with v, roughly linear
        // here because cognitive delay at speed is linear in distance).
        const spd = numericMeta(ev, 'speedKmH') ?? 20;
        base = 0.25 * dur * typeMult * (spd / 20);
        break;
      }
      case 'swerving': {
        const impulse = numericMeta(ev, 'peakLatMs2') ?? 3.43;
        base = impulse / 3.43;
        // Spec §4.5: ×2 when phone held at event time.
        if (ev.meta?.phonePositionState === 'held') base *= 2.0;
        break;
      }
      case 'distracted_driving':
      case 'drowsy_driving':
        base = 0.4 * Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
        break;
      case 'speed_wobble':
      case 'highside_risk':
        base = 0; // stability bucket, weight 0 — coaching only
        break;
      default: base = 0.5;
    }

    let penalty = base * mult;

    // Time-of-day multiplier, applied as the spec requires (on the
    // SCORE, not on the thresholds).
    const todWeight = numericMeta(ev, 'timeOfDayWeight');
    if (todWeight !== null && todWeight > 0) penalty *= todWeight;

    // Phone-position gate: if the event relied on a mounted-only signal
    // (lean / corner_accel / extreme_lean) AND the phone confidence was
    // below the gate, discount by 50%. We don't suppress entirely because
    // a high-magnitude event with a low-confidence classification is still
    // informative — just less trusted.
    const phoneConf = numericMeta(ev, 'phonePositionConf');
    const phoneState = ev.meta?.phonePositionState as string | undefined;
    const isMountedSignal =
      ev.type === 'extreme_lean' || ev.type === 'corner_acceleration' || ev.type === 'hard_cornering';
    if (isMountedSignal && phoneConf !== null && phoneConf < this.cfg.phonePositionMinConfidence && phoneState !== 'mounted') {
      penalty *= 0.5;
    }

    return penalty;
  }

  private splitByBucket(
    events: MotoSafetyEvent[],
    deliveryMode: boolean,
  ): {
    acceleration: MotoSafetyEvent[];
    braking:      MotoSafetyEvent[];
    cornering:    MotoSafetyEvent[];
    speeding:     MotoSafetyEvent[];
    distracted:   MotoSafetyEvent[];
    stability:    MotoSafetyEvent[];
    swerving?:    MotoSafetyEvent[];
  } {
    const r = {
      acceleration: [] as MotoSafetyEvent[],
      braking:      [] as MotoSafetyEvent[],
      cornering:    [] as MotoSafetyEvent[],
      speeding:     [] as MotoSafetyEvent[],
      distracted:   [] as MotoSafetyEvent[],
      stability:    [] as MotoSafetyEvent[],
      swerving:     [] as MotoSafetyEvent[],
    };
    for (const ev of events) {
      switch (ev.type) {
        case 'hard_acceleration':   r.acceleration.push(ev); break;
        case 'hard_braking':
        case 'panic_brake':         r.braking.push(ev);      break;
        case 'hard_cornering':
        case 'extreme_lean':
        case 'corner_acceleration': r.cornering.push(ev);    break;
        case 'overspeeding':        r.speeding.push(ev);     break;
        case 'phone_use':
        case 'distracted_driving':
        case 'drowsy_driving':      r.distracted.push(ev);   break;
        case 'swerving':            r.swerving.push(ev);     break;
        case 'speed_wobble':
        case 'highside_risk':       r.stability.push(ev);    break;
        case 'crash': break;
      }
    }
    if (!deliveryMode) delete (r as { swerving?: MotoSafetyEvent[] }).swerving;
    return r;
  }
}

/**
 * Safe numeric-meta extraction. Meta values can legally be string/bool/
 * number; callers want a number or null.
 */
function numericMeta(ev: MotoSafetyEvent, key: string): number | null {
  const v = ev.meta?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function severityMult(s: 1|2|3|4|5): number {
  return [1.0, 1.5, 2.5, 4.0, 6.0][s - 1];
}

function round(n: number, d: number): number {
  const p = Math.pow(10, d); return Math.round(n * p) / p;
}

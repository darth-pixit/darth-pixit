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

const MOTO_WEIGHTS = {
  acceleration: 0.10,
  braking:      0.20,
  cornering:    0.25,
  speeding:     0.30,
  distracted:   0.15,
  stability:    0.00, // intentionally 0 — see notes above
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

    const distKm = Math.max(distanceM / 1000, MIN_DIVISOR_KM);
    const split  = this.splitByBucket(events);

    const acceleration = this.scoreCategory(split.acceleration, distKm, 'acceleration', ctx);
    const braking      = this.scoreCategory(split.braking,      distKm, 'braking',      ctx);
    const cornering    = this.scoreCategory(split.cornering,     distKm, 'cornering',    ctx);
    const speeding     = this.scoreCategory(split.speeding,      distKm, 'speeding',     ctx);
    const distracted   = this.scoreCategory(split.distracted,    distKm, 'distracted',   ctx);

    const composite = crashed ? 0 :
      MOTO_WEIGHTS.acceleration * acceleration.score +
      MOTO_WEIGHTS.braking      * braking.score +
      MOTO_WEIGHTS.cornering    * cornering.score +
      MOTO_WEIGHTS.speeding     * speeding.score +
      MOTO_WEIGHTS.distracted   * distracted.score;

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
    bucket: keyof typeof MOTO_WEIGHTS,
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

  private eventPenalty(ev: MotoSafetyEvent, bucket: keyof typeof MOTO_WEIGHTS): number {
    const mult = severityMult(ev.severity);
    let base: number;

    switch (ev.type) {
      case 'hard_acceleration':    base = 0.5; break;
      case 'hard_braking': {
        base = 0.75;
        if (!this.cfg.hasABS)      base *= 1.15;
        if (this.cfg.hasPassenger) base *= 1.20;
        // Emergency-braking mitigation (same as car scorer)
        if (ev.meta?.precededByHardAccel === false) base *= 0.6;
        break;
      }
      case 'hard_cornering':       base = 0.75; break;
      case 'extreme_lean':         base = 1.00; break; // higher than hard corner — closer to traction limit
      case 'corner_acceleration':  base = 1.25; break; // most dangerous single action a rider can take
      case 'overspeeding':
        base = 0.15 * Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
        break;
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

    return base * mult;
  }

  private splitByBucket(events: MotoSafetyEvent[]): Record<keyof typeof MOTO_WEIGHTS, MotoSafetyEvent[]> {
    const r: Record<keyof typeof MOTO_WEIGHTS, MotoSafetyEvent[]> = {
      acceleration: [], braking: [], cornering: [],
      speeding: [], distracted: [], stability: [],
    };
    for (const ev of events) {
      switch (ev.type) {
        case 'hard_acceleration':   r.acceleration.push(ev); break;
        case 'hard_braking':        r.braking.push(ev);      break;
        case 'hard_cornering':
        case 'extreme_lean':
        case 'corner_acceleration': r.cornering.push(ev);    break;
        case 'overspeeding':        r.speeding.push(ev);     break;
        case 'distracted_driving':
        case 'drowsy_driving':      r.distracted.push(ev);   break;
        case 'speed_wobble':
        case 'highside_risk':       r.stability.push(ev);    break;
        case 'crash': break;
      }
    }
    return r;
  }
}

function severityMult(s: 1|2|3|4|5): number {
  return [1.0, 1.5, 2.5, 4.0, 6.0][s - 1];
}

function round(n: number, d: number): number {
  const p = Math.pow(10, d); return Math.round(n * p) / p;
}

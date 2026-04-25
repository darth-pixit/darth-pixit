/**
 * CarScorer — safety scoring for 4W fleet vehicles.
 *
 * ================================================================
 *  WEIGHT RATIONALE (spec §5.2)
 * ================================================================
 *
 *  Based on NHTSA crash causation data for passenger vehicles:
 *
 *    OVERSPEED    0.22  Speed contributes to 26% of fatal crashes.
 *                       Injury risk scales as v²; at 130 vs 110 km/h
 *                       crash energy is 40% higher. Highest weight.
 *
 *    BRAKING      0.20  Hard braking is the #1 controllable factor in
 *                       rear-end collisions (following too close +
 *                       braking late). High weight, slightly lower than
 *                       2W because cars have better ABS stability.
 *
 *    PHONE        0.18  NHTSA: phone use is a factor in 9% of crashes
 *                       but massively over-represented in causation
 *                       (distraction triples crash risk). High weight.
 *
 *    LANE_CHANGE  0.10  Unsafe lane changes cause ~10% of highway
 *                       crashes. S-shape detection is precise enough
 *                       to justify a dedicated weight.
 *
 *    SEATBELT     0.08  Seatbelts reduce injury severity by ~45%. When
 *                       OBD detects the driver is unbelted, the potential
 *                       crash consequence is dramatically higher. We score
 *                       the exposure (time unbelted at speed) rather than
 *                       a crash probability.
 *
 *    CORNERING    0.08  Combined g-g circle. Lower than 2W (0.25) because
 *                       cars are more stable laterally; loss of control is
 *                       rarer for the same g level.
 *
 *    ACCEL        0.07  Hard acceleration is the weakest direct crash
 *                       cause for 4W. It matters for fuel/wear and for
 *                       following-distance creation, but the direct
 *                       fatality connection is weaker.
 *
 *    ENGINE_ABUSE 0.04  Fleet concern (wear + maintenance cost) more
 *                       than immediate crash risk. Non-zero because
 *                       overheating and over-rev can cause sudden
 *                       mechanical failure.
 *
 *    IDLING       0.03  Fuel and emissions waste. Low safety weight;
 *                       primarily a fleet efficiency signal.
 *
 *  Sum = 1.00. ✓
 *
 * ================================================================
 *  DTC AND OBD-DEGRADED EXCLUSION FROM COMPARATIVE RANKING
 * ================================================================
 *
 *  lifetimeScore() and rollingWindowScore() automatically exclude:
 *    - Trips with dtcSafetyCritical = true (fault present → driver has
 *      no full control of braking/ABS/stability; their score would be
 *      artificially high for the circumstances).
 *    - Trips with obdDegraded = true (OBD uptime < 50% means scores
 *      are unreliable because half the OBD-dependent events are blind).
 *
 *  Excluded trips are still stored for compliance/audit purposes with
 *  their score marked; they just don't influence fleet rankings.
 */

import { TripRecord, SafetyScore, CategoryScore, WeatherCondition } from '../types';
import { CarSafetyEvent, CarConfig } from './types';
import { ScoringContext } from '../SafetyScorer';

const CAR_WEIGHTS = {
  overspeed:    0.22,
  braking:      0.20,
  phone:        0.18,
  lane_change:  0.10,
  seatbelt:     0.08,
  cornering:    0.08,
  acceleration: 0.07,
  engine_abuse: 0.04,
  idling:       0.03,
} as const;

const MIN_DIVISOR_KM = 1.0;
const PENALTY_SCALE  = 25;

export interface CarRiderBaseline {
  acceleration: number;
  braking: number;
  cornering: number;
  overspeed: number;
  phone: number;
  tripCount: number;
}

export interface CarRiderDeviation {
  acceleration: boolean;
  braking: boolean;
  cornering: boolean;
  overspeed: boolean;
  phone: boolean;
}

export class CarScorer {
  private cfg: CarConfig;

  constructor(cfg: CarConfig) {
    this.cfg = cfg;
  }

  updateConfig(patch: Partial<CarConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  scoreTrip(
    events: CarSafetyEvent[],
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
    const buckets = this.splitByBucket(events);

    const acceleration = this.scoreCategory(buckets.acceleration, distKm, ctx);
    const braking      = this.scoreCategory(buckets.braking,      distKm, ctx);
    const cornering    = this.scoreCategory(buckets.cornering,    distKm, ctx);
    const speeding     = this.scoreCategory(buckets.overspeed,    distKm, ctx);
    const distracted   = this.scoreCategory(buckets.phone,        distKm, ctx);
    const lane         = this.scoreCategory(buckets.lane_change,  distKm, ctx);
    const seatbelt     = this.scoreCategory(buckets.seatbelt,     distKm, ctx);
    const engineAbuse  = this.scoreCategory(buckets.engine_abuse, distKm, ctx);
    const idling       = this.scoreCategory(buckets.idling,       distKm, ctx);

    let composite = crashed ? 0 :
      CAR_WEIGHTS.acceleration * acceleration.score +
      CAR_WEIGHTS.braking      * braking.score +
      CAR_WEIGHTS.cornering    * cornering.score +
      CAR_WEIGHTS.overspeed    * speeding.score +
      CAR_WEIGHTS.phone        * distracted.score +
      CAR_WEIGHTS.lane_change  * lane.score +
      CAR_WEIGHTS.seatbelt     * seatbelt.score +
      CAR_WEIGHTS.engine_abuse * engineAbuse.score +
      CAR_WEIGHTS.idling       * idling.score;

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

  /**
   * Distance-weighted lifetime composite, excluding OBD-degraded and
   * DTC-safety-critical trips. Pass the full trip history.
   *
   * `tripExtras` must match `trips` by index and carry the car-specific
   * flags (obdDegraded, dtcSafetyCritical). Use undefined when extras
   * are unavailable.
   */
  lifetimeScore(
    trips: TripRecord[],
    tripExtras: Array<{ obdDegraded?: boolean; dtcSafetyCritical?: boolean } | undefined> = [],
  ): number | null {
    const scorable = trips.filter((t, i) => {
      if (t.score === null) return false;
      if (t.distanceM < this.cfg.minScorableDistanceM) return false;
      const ex = tripExtras[i];
      if (ex?.obdDegraded) return false;
      if (ex?.dtcSafetyCritical) return false;
      return true;
    });
    if (!scorable.length) return null;
    let wsum = 0, wtot = 0;
    for (const t of scorable) { wsum += t.score!.composite * t.distanceM; wtot += t.distanceM; }
    return wtot > 0 ? round(wsum / wtot, 1) : null;
  }

  rollingWindowScore(trips: TripRecord[], days: number, now: number = Date.now()): number | null {
    const windowStart = now - days * 24 * 60 * 60 * 1000;
    const scorable = trips.filter(t =>
      t.score !== null &&
      t.distanceM >= this.cfg.minScorableDistanceM &&
      t.endedAt !== null &&
      t.endedAt >= windowStart,
    );
    if (!scorable.length) return null;
    let wsum = 0, wtot = 0;
    for (const t of scorable) { wsum += t.score!.composite * t.distanceM; wtot += t.distanceM; }
    return wtot > 0 ? round(wsum / wtot, 1) : null;
  }

  rolling30DayScore(trips: TripRecord[], now: number = Date.now()): number | null {
    return this.rollingWindowScore(trips, 30, now);
  }

  rolling7DayScore(trips: TripRecord[], now: number = Date.now()): number | null {
    return this.rollingWindowScore(trips, 7, now);
  }

  riderBaseline(trips: TripRecord[]): CarRiderBaseline | null {
    const scored = trips.filter(t =>
      t.score !== null && t.distanceM >= this.cfg.minScorableDistanceM,
    );
    if (scored.length < 50) return null;
    return {
      acceleration: percentile(scored.map(t => t.score!.acceleration.penalty), 0.20),
      braking:      percentile(scored.map(t => t.score!.braking.penalty),      0.20),
      cornering:    percentile(scored.map(t => t.score!.cornering.penalty),     0.20),
      overspeed:    percentile(scored.map(t => t.score!.speeding.penalty),      0.20),
      phone:        percentile(scored.map(t => t.score!.distracted.penalty),    0.20),
      tripCount: scored.length,
    };
  }

  deviationFromBaseline(trip: TripRecord, trips: TripRecord[]): CarRiderDeviation | null {
    const baseline = this.riderBaseline(trips);
    if (!baseline || !trip.score) return null;
    return {
      acceleration: trip.score.acceleration.penalty > baseline.acceleration,
      braking:      trip.score.braking.penalty      > baseline.braking,
      cornering:    trip.score.cornering.penalty     > baseline.cornering,
      overspeed:    trip.score.speeding.penalty      > baseline.overspeed,
      phone:        trip.score.distracted.penalty    > baseline.phone,
    };
  }

  private scoreCategory(
    events: CarSafetyEvent[],
    distKm: number,
    ctx: { recoveredEventIds: Set<string>; graceFactor: number },
  ): CategoryScore {
    let penalty = 0;
    let recoveredCount = 0;
    for (const ev of events) {
      let p = this.eventPenalty(ev);
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

  private eventPenalty(ev: CarSafetyEvent): number {
    const mult = severityMult(ev.severity);
    let base: number;

    switch (ev.type) {
      case 'hard_acceleration': {
        base = 0.40;
        const spd = numMeta(ev, 'speedKmH') ?? 0;
        base *= Math.max(0.5, Math.pow(spd / 40, 1.5));
        break;
      }
      case 'hard_braking': {
        base = 0.70;
        const preSpd = numMeta(ev, 'preSpeedKmH') ?? 30;
        base *= Math.max(0.5, Math.pow(preSpd / 30, 2));
        if (ev.meta?.absPulsed) base *= 0.8; // ABS working correctly, risk reduced
        break;
      }
      case 'hard_cornering': {
        base = 0.65;
        const spd = numMeta(ev, 'speedKmH') ?? 30;
        base *= Math.max(0.5, spd / 40);
        break;
      }
      case 'lane_change': {
        base = 0.50;
        const peak = numMeta(ev, 'peakLatMs2') ?? this.cfg.laneChangePeakLatMs2;
        base *= peak / this.cfg.laneChangePeakLatMs2;
        break;
      }
      case 'overspeeding': {
        const dur = Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
        const excess = numMeta(ev, 'excessKmH') ?? 10;
        const limit  = numMeta(ev, 'limitKmH')  ?? this.cfg.absoluteSpeedLimitKmH;
        const ratio  = excess / limit;
        base = 0.12 * dur * ratio * ratio *
          (ev.severity >= 4 ? 3.5 : ev.severity === 3 ? 2.0 : 1.2);
        break;
      }
      case 'phone_use': {
        const dur     = Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
        const spd     = numMeta(ev, 'speedKmH') ?? 20;
        const subtype = (ev.meta?.subtype as string | undefined) ?? 'handheld';
        const typeMult =
          subtype === 'texting'     ? 2.0 :
          subtype === 'distraction' ? 1.5 :
          subtype === 'call'        ? 1.2 : 1.0;
        base = 0.25 * dur * typeMult * (spd / 20);
        break;
      }
      case 'seatbelt_off': {
        const dur = Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
        const spd = numMeta(ev, 'maxSpeedKmH') ?? 30;
        // Seatbelt risk scales aggressively with speed (crash energy = ½mv²).
        base = 0.50 * (dur / 30) * Math.pow(spd / 50, 2);
        break;
      }
      case 'engine_abuse': {
        const dur     = Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
        const subtype = ev.meta?.subtype as EngineAbuseSubtype | undefined;
        const abuseMult =
          subtype === 'overheating' ? 3.0 :
          subtype === 'over_rev'    ? 2.0 :
          subtype === 'lugging'     ? 1.5 : 1.2;
        base = 0.10 * (dur / 10) * abuseMult;
        break;
      }
      case 'idling': {
        const dur = Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
        base = 0.05 * (dur / 60); // 1 penalty point per 20 minutes of idling
        break;
      }
      case 'distracted_driving':
      case 'drowsy_driving':
        base = 0.4 * Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
        break;
      case 'crash':
        base = 0;
        break;
      default:
        base = 0.5;
    }

    let penalty = base * mult;

    // Time-of-day multiplier applied to the final penalty.
    const todW = numMeta(ev, 'timeOfDayWeight');
    if (todW !== null && todW > 0) penalty *= todW;

    return penalty;
  }

  private splitByBucket(events: CarSafetyEvent[]): {
    acceleration: CarSafetyEvent[];
    braking:      CarSafetyEvent[];
    cornering:    CarSafetyEvent[];
    overspeed:    CarSafetyEvent[];
    phone:        CarSafetyEvent[];
    lane_change:  CarSafetyEvent[];
    seatbelt:     CarSafetyEvent[];
    engine_abuse: CarSafetyEvent[];
    idling:       CarSafetyEvent[];
  } {
    const r = {
      acceleration: [] as CarSafetyEvent[],
      braking:      [] as CarSafetyEvent[],
      cornering:    [] as CarSafetyEvent[],
      overspeed:    [] as CarSafetyEvent[],
      phone:        [] as CarSafetyEvent[],
      lane_change:  [] as CarSafetyEvent[],
      seatbelt:     [] as CarSafetyEvent[],
      engine_abuse: [] as CarSafetyEvent[],
      idling:       [] as CarSafetyEvent[],
    };
    for (const ev of events) {
      switch (ev.type) {
        case 'hard_acceleration':              r.acceleration.push(ev); break;
        case 'hard_braking':                   r.braking.push(ev);      break;
        case 'hard_cornering':                 r.cornering.push(ev);    break;
        case 'overspeeding':                   r.overspeed.push(ev);    break;
        case 'phone_use':
        case 'distracted_driving':
        case 'drowsy_driving':                 r.phone.push(ev);        break;
        case 'lane_change':                    r.lane_change.push(ev);  break;
        case 'seatbelt_off':                   r.seatbelt.push(ev);     break;
        case 'engine_abuse':                   r.engine_abuse.push(ev); break;
        case 'idling':                         r.idling.push(ev);       break;
        case 'crash':                          break;
      }
    }
    return r;
  }
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

type EngineAbuseSubtype = 'over_rev' | 'lugging' | 'high_load' | 'overheating';

function numMeta(ev: CarSafetyEvent, key: string): number | null {
  const v = ev.meta?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function severityMult(s: 1|2|3|4|5): number {
  return [1.0, 1.5, 2.5, 4.0, 6.0][s - 1];
}

function round(n: number, d: number): number {
  const p = Math.pow(10, d); return Math.round(n * p) / p;
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

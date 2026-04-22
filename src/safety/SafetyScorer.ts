/**
 * SafetyScorer — converts a trip's events + context into a 0–100
 * composite score and five per-category subscores.
 *
 * =============================================================
 *  Scoring philosophy & critique (unchanged from Phase 1)
 * =============================================================
 *
 * 1. Frequency per km — a 100 km trip with 3 events is safer than
 *    5 km with 3 events. Penalty normalised by distance.
 *
 * 2. Severity-weighted — a 2.5× threshold event is far more predictive
 *    of crash risk than a 1.05× event.
 *
 * 3. Asymmetric base penalties — braking > cornering > acceleration.
 *
 * 4. Emergency-braking mitigation — isolated hard brakes get 0.6×.
 *
 * 5. Crash floors composite to 0.
 *
 * 6. Category weights: speeding 25%, braking 25%, cornering 20%,
 *    distracted 15%, acceleration 15% (actuarial correlation order).
 *
 * =============================================================
 *  New modifiers in Phase 2
 * =============================================================
 *
 * A. ROUTE GRACE FACTOR (graceFactor ∈ [0.85, 1.0])
 *    Applied to ALL event penalties on this trip if the route is
 *    unfamiliar. Only affects severity 1–2 events — severity ≥ 3 events
 *    are too dangerous to excuse on unfamiliarity grounds.
 *
 *    CRITIQUE: "Unfamiliar" only applies at trip start. A driver who
 *    repeats the same aggressive behaviour in familiar territory gets
 *    no grace — correct. But a driver who drives perfectly in familiar
 *    territory and slightly too aggressively in a new town gets partial
 *    grace — also fair.
 *
 * B. RECOVERY BONUS (recoveredEventIds set)
 *    If an event is in the recovered set, its penalty × recoveryFactor
 *    (default 0.8). Only events with severity < 3 can recover (same
 *    cap as route grace — severe events don't get rewarded for later
 *    good behaviour).
 *
 * C. WEATHER THRESHOLD SCALING
 *    Weather scaling happens at DETECTION time (in EventDetector), not
 *    here. The scorer sees more events in rain but doesn't apply an
 *    additional penalty multiplier. This keeps scoring transparent:
 *    "you had 3 hard brakes" is meaningful; "your penalty was secretly
 *    multiplied 1.2×" is opaque and feels unfair.
 *
 * D. DROWSY DRIVING AND WEAR SIGNALS
 *    These are stored in the TripRecord for context but do NOT currently
 *    reduce the driving score — they are treated as advisory alerts to
 *    the driver, not as scored behaviours. Rationale: drowsy driving
 *    detection is probabilistic enough that penalising it directly would
 *    erode driver trust in the system. Wear signals are a vehicle
 *    maintenance concern, not a driver behaviour score.
 */

import {
  SafetyEvent,
  SafetyScore,
  CategoryScore,
  WeatherCondition,
  SafetyConfig,
  DEFAULT_SAFETY_CONFIG,
  TripRecord,
} from './types';

const CATEGORY_WEIGHTS = {
  acceleration: 0.15,
  braking: 0.25,
  cornering: 0.20,
  speeding: 0.25,
  distracted: 0.15,
} as const;

const MIN_DIVISOR_KM = 1.0;
const PENALTY_SCALE_PER_CATEGORY = 25;

export interface ScoringContext {
  /** Set of event IDs that earned the recovery bonus. From RecoveryTracker. */
  recoveredEventIds: Set<string>;
  /** Route grace factor 0.85..1.0. From RouteTracker. */
  graceFactor: number;
  /** Weather condition at time of trip. For display/metadata only. */
  weatherCondition: WeatherCondition | null;
}

const DEFAULT_CONTEXT: ScoringContext = {
  recoveredEventIds: new Set(),
  graceFactor: 1.0,
  weatherCondition: null,
};

export class SafetyScorer {
  private cfg: SafetyConfig;

  constructor(cfg: SafetyConfig = DEFAULT_SAFETY_CONFIG) {
    this.cfg = cfg;
  }

  updateConfig(patch: Partial<SafetyConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  scoreTrip(
    events: SafetyEvent[],
    distanceM: number,
    crashed: boolean,
    context: Partial<ScoringContext> = {},
  ): SafetyScore {
    const ctx: ScoringContext = { ...DEFAULT_CONTEXT, ...context };
    const distanceKm = Math.max(distanceM / 1000, MIN_DIVISOR_KM);

    const perType = splitByType(events);

    const acceleration = this.scoreCategory(perType.acceleration, distanceKm, 'acceleration', ctx);
    const braking      = this.scoreCategory(perType.braking,      distanceKm, 'braking',      ctx);
    const cornering    = this.scoreCategory(perType.cornering,     distanceKm, 'cornering',    ctx);
    const speeding     = this.scoreCategory(perType.speeding,      distanceKm, 'speeding',     ctx);
    const distracted   = this.scoreCategory(perType.distracted,    distanceKm, 'distracted',   ctx);

    const composite = crashed ? 0 :
      CATEGORY_WEIGHTS.acceleration * acceleration.score +
      CATEGORY_WEIGHTS.braking      * braking.score      +
      CATEGORY_WEIGHTS.cornering    * cornering.score     +
      CATEGORY_WEIGHTS.speeding     * speeding.score      +
      CATEGORY_WEIGHTS.distracted   * distracted.score;

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
    const scorable = trips.filter(
      (t) => t.score !== null && t.distanceM >= this.cfg.minScorableDistanceM,
    );
    if (scorable.length === 0) return null;
    let wsum = 0, wtot = 0;
    for (const t of scorable) {
      wsum += t.score!.composite * t.distanceM;
      wtot += t.distanceM;
    }
    return wtot > 0 ? round(wsum / wtot, 1) : null;
  }

  // ---------- internals ----------

  private scoreCategory(
    events: SafetyEvent[],
    distanceKm: number,
    category: keyof typeof CATEGORY_WEIGHTS,
    ctx: ScoringContext,
  ): CategoryScore {
    let penalty = 0;
    let recoveredCount = 0;
    for (const ev of events) {
      let p = this.eventPenalty(ev, category);
      // Route grace: only for severity 1–2 events.
      if (ev.severity <= 2 && ctx.graceFactor < 1.0) p *= ctx.graceFactor;
      // Recovery bonus: also only for severity < 3 (already enforced by RecoveryTracker).
      if (ctx.recoveredEventIds.has(ev.id)) {
        p *= this.cfg.recoveryPenaltyFactor;
        recoveredCount++;
      }
      penalty += p;
    }
    const penaltyPerKm = penalty / distanceKm;
    const deduction = penaltyPerKm * PENALTY_SCALE_PER_CATEGORY;
    const score = Math.max(0, Math.min(100, 100 - deduction));
    return { score: round(score, 1), penalty: round(penalty, 2), eventCount: events.length, recoveredCount };
  }

  private eventPenalty(
    ev: SafetyEvent,
    category: keyof typeof CATEGORY_WEIGHTS,
  ): number {
    const mult = severityMultiplier(ev.severity);
    let base: number;
    switch (category) {
      case 'acceleration': base = 0.5; break;
      case 'braking':      base = 0.75; break;
      case 'cornering':    base = 0.75; break;
      case 'speeding':     base = this.overspeedingPenaltyBase(ev); break;
      case 'distracted':   base = this.distractionPenaltyBase(ev); break;
    }
    let penalty = base * mult;
    // Emergency-braking mitigation: isolated hard brake (not following a hard accel).
    if (ev.type === 'hard_braking' && ev.meta?.precededByHardAccel === false) {
      penalty *= 0.6;
    }
    return penalty;
  }

  private overspeedingPenaltyBase(ev: SafetyEvent): number {
    const durS = Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
    return 0.15 * durS;
  }

  private distractionPenaltyBase(ev: SafetyEvent): number {
    const durS = Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
    return 0.4 * durS;
  }
}

function severityMultiplier(sev: 1 | 2 | 3 | 4 | 5): number {
  switch (sev) {
    case 1: return 1.0;
    case 2: return 1.5;
    case 3: return 2.5;
    case 4: return 4.0;
    case 5: return 6.0;
  }
}

function splitByType(events: SafetyEvent[]) {
  const r = {
    acceleration: [] as SafetyEvent[],
    braking:      [] as SafetyEvent[],
    cornering:    [] as SafetyEvent[],
    speeding:     [] as SafetyEvent[],
    distracted:   [] as SafetyEvent[],
  };
  for (const ev of events) {
    switch (ev.type) {
      case 'hard_acceleration':   r.acceleration.push(ev); break;
      case 'hard_braking':        r.braking.push(ev);      break;
      case 'hard_cornering':      r.cornering.push(ev);    break;
      case 'overspeeding':        r.speeding.push(ev);     break;
      case 'distracted_driving':
      case 'drowsy_driving':      r.distracted.push(ev);   break;
      case 'crash': break;
    }
  }
  return r;
}

function round(n: number, decimals: number): number {
  const p = Math.pow(10, decimals);
  return Math.round(n * p) / p;
}

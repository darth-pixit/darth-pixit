/**
 * SafetyScorer — converts a trip's events + distance into a 0–100
 * composite score and five per-category subscores.
 *
 * =============================================================
 *  Scoring philosophy & critique
 * =============================================================
 *
 * 1. Frequency per km, not raw counts.
 *    A 100 km highway trip with 3 events is safer than a 5 km city
 *    trip with 3 events. Penalty is always divided by distance (with a
 *    min-distance floor so a 200 m cold-start trip with one hard accel
 *    doesn't score 0).
 *
 * 2. Severity-weighted.
 *    A 2.5× threshold event is much more predictive of crash risk than
 *    a 1.05× threshold event. We use a non-linear multiplier so
 *    borderline events barely dent the score.
 *
 * 3. Asymmetric base penalties by event type.
 *    Braking > cornering > acceleration — matches actuarial data:
 *    repeated hard braking is the strongest single predictor of
 *    collision claims (tailgating proxy); hard acceleration correlates
 *    more with fuel and wear than crash rate.
 *
 * 4. Emergency-braking mitigation.
 *    If a hard-brake event is tagged "preceded by hard accel" → it's
 *    part of an aggressive pattern → full penalty. If isolated → likely
 *    emergency avoidance → 60% penalty. This is imperfect (an isolated
 *    hard brake could still be bad habit) but it's the best signal we
 *    have without more context.
 *
 * 5. Crash floors the score.
 *    A confirmed crash makes the composite score 0 for that trip AND
 *    flags crashed=true so dashboards can surface the incident.
 *
 * 6. Category weights in the composite.
 *    Based on published insurance-industry loss-cost correlations:
 *      Speeding 25%, Braking 25%, Cornering 20%, Distraction 15%,
 *      Acceleration 15%.
 *    Speeding is the #1 single factor in fatal crashes (NHTSA ~29%);
 *    braking is the strongest behavioral predictor; distraction is
 *    underweighted here relative to its real risk because our
 *    detection is a weak proxy (see EventDetector.ts).
 *
 * 7. Lifetime score = distance-weighted average of trip scores.
 *    Prevents gaming via "I'll only take short careful trips". A
 *    500 km road trip at 95 dominates fifty 2 km errand trips at 82.
 */

import {
  SafetyEvent,
  SafetyScore,
  CategoryScore,
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

/** Minimum distance (km) used as divisor to prevent tiny-trip blow-ups. */
const MIN_DIVISOR_KM = 1.0;

/** Converts penalty-per-km into a 0..100 score. Tuned against example trips. */
const PENALTY_SCALE_PER_CATEGORY = 25;

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
  ): SafetyScore {
    const distanceKm = Math.max(distanceM / 1000, MIN_DIVISOR_KM);

    const perType = splitByType(events);

    const acceleration = this.scoreCategory(perType.acceleration, distanceKm, 'acceleration');
    const braking = this.scoreCategory(perType.braking, distanceKm, 'braking');
    const cornering = this.scoreCategory(perType.cornering, distanceKm, 'cornering');
    const speeding = this.scoreCategory(perType.speeding, distanceKm, 'speeding');
    const distracted = this.scoreCategory(perType.distracted, distanceKm, 'distracted');

    const composite = crashed
      ? 0
      : CATEGORY_WEIGHTS.acceleration * acceleration.score +
        CATEGORY_WEIGHTS.braking * braking.score +
        CATEGORY_WEIGHTS.cornering * cornering.score +
        CATEGORY_WEIGHTS.speeding * speeding.score +
        CATEGORY_WEIGHTS.distracted * distracted.score;

    return {
      composite: round(composite, 1),
      acceleration,
      braking,
      cornering,
      speeding,
      distracted,
      crashed,
    };
  }

  /** Distance-weighted lifetime score across a list of scorable trips. */
  lifetimeScore(trips: TripRecord[]): number | null {
    const scorable = trips.filter(
      (t) => t.score !== null && t.distanceM >= this.cfg.minScorableDistanceM,
    );
    if (scorable.length === 0) return null;
    let wsum = 0;
    let wtot = 0;
    for (const t of scorable) {
      const w = t.distanceM;
      wsum += (t.score!.composite) * w;
      wtot += w;
    }
    return wtot > 0 ? round(wsum / wtot, 1) : null;
  }

  // ---------- internals ----------

  private scoreCategory(
    events: SafetyEvent[],
    distanceKm: number,
    category: keyof typeof CATEGORY_WEIGHTS,
  ): CategoryScore {
    let penalty = 0;
    for (const ev of events) {
      penalty += this.eventPenalty(ev, category);
    }
    const penaltyPerKm = penalty / distanceKm;
    const deduction = penaltyPerKm * PENALTY_SCALE_PER_CATEGORY;
    const score = Math.max(0, Math.min(100, 100 - deduction));
    return {
      score: round(score, 1),
      penalty: round(penalty, 2),
      eventCount: events.length,
    };
  }

  private eventPenalty(
    ev: SafetyEvent,
    category: keyof typeof CATEGORY_WEIGHTS,
  ): number {
    const severityMult = severityMultiplier(ev.severity);

    let base: number;
    switch (category) {
      case 'acceleration': base = 0.5; break;
      case 'braking':      base = 0.75; break;
      case 'cornering':    base = 0.75; break;
      case 'speeding':     base = this.overspeedingPenaltyBase(ev); break;
      case 'distracted':   base = this.distractionPenaltyBase(ev); break;
    }

    let penalty = base * severityMult;

    // Emergency-braking mitigation.
    if (ev.type === 'hard_braking' && ev.meta?.precededByHardAccel === false) {
      penalty *= 0.6;
    }

    return penalty;
  }

  private overspeedingPenaltyBase(ev: SafetyEvent): number {
    // Scale with event duration — 10s of speeding is worse than 3s.
    const durS = Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
    return 0.15 * durS; // 3s @ sev1 = 0.45 penalty; 30s @ sev3 = 9 base → plenty
  }

  private distractionPenaltyBase(ev: SafetyEvent): number {
    const durS = Math.max(1, (ev.endedAt - ev.startedAt) / 1000);
    return 0.4 * durS;
  }
}

function severityMultiplier(sev: 1 | 2 | 3 | 4 | 5): number {
  // Non-linear — borderline events barely count, extremes are punished hard.
  switch (sev) {
    case 1: return 1.0;
    case 2: return 1.5;
    case 3: return 2.5;
    case 4: return 4.0;
    case 5: return 6.0;
  }
}

function splitByType(events: SafetyEvent[]): {
  acceleration: SafetyEvent[];
  braking: SafetyEvent[];
  cornering: SafetyEvent[];
  speeding: SafetyEvent[];
  distracted: SafetyEvent[];
} {
  const r = {
    acceleration: [] as SafetyEvent[],
    braking: [] as SafetyEvent[],
    cornering: [] as SafetyEvent[],
    speeding: [] as SafetyEvent[],
    distracted: [] as SafetyEvent[],
  };
  for (const ev of events) {
    switch (ev.type) {
      case 'hard_acceleration': r.acceleration.push(ev); break;
      case 'hard_braking':      r.braking.push(ev); break;
      case 'hard_cornering':    r.cornering.push(ev); break;
      case 'overspeeding':      r.speeding.push(ev); break;
      case 'distracted_driving':r.distracted.push(ev); break;
      case 'crash':             /* handled via crashed flag */ break;
    }
  }
  return r;
}

function round(n: number, decimals: number): number {
  const p = Math.pow(10, decimals);
  return Math.round(n * p) / p;
}

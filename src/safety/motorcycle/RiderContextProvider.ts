/**
 * RiderContextProvider — produces the per-segment context that the
 * delivery-rider overspeed detector and scorer consume.
 *
 * ================================================================
 *  WHY WE NEED CONTEXT AT ALL
 * ================================================================
 *
 *  The v1 moto engine used a single absolute speed limit (110 km/h) as
 *  the overspeed threshold. That value is almost meaningless for an
 *  Indian last-mile delivery rider — most of whom never exceed 60 km/h
 *  in a typical shift. A rider filter-splitting through 40 km/h traffic
 *  on a residential road at 45 km/h is a MUCH bigger issue than the
 *  same rider doing 75 km/h on a ring road with 80 km/h flow.
 *
 *  The spec resolves this by pulling three context signals:
 *
 *    ambient_2w_speed  (Mappls, live 2W traffic flow, refreshed 15 min)
 *    speed_limit       (OSM maxspeed tag, cached; else class default)
 *    road_class        (OSM highway tag)
 *
 *  and computing a reference speed:
 *
 *    ref = max(ambient × 1.15,  legal_limit,  fallback_by_class)
 *
 *  Then the overspeed band is based on the ratio speed/ref rather than
 *  an absolute value.
 *
 * ================================================================
 *  WHAT THIS MODULE ACTUALLY DOES
 * ================================================================
 *
 *  We deliberately do NOT make network calls from here. The app may be
 *  offline; the OBD pipeline runs on every dispatch regardless. This
 *  module accepts optional external signals:
 *
 *     - setAmbient2WSpeed()  — called by a higher layer that has
 *                              successfully hit the Mappls API.
 *     - setRoadClass()       — called by an OSM lookup layer.
 *     - setSpeedLimit()      — called by whichever source knows it.
 *
 *  When those signals are absent (v1, no map API, offline), we fall back
 *  to a heuristic based on the rider's recent rolling speed: it is a
 *  reasonable signal for the current road class. A rider cruising at
 *  55 km/h for 30 seconds is almost certainly on a secondary or better
 *  road; a rider stuck in 18 km/h stop-go is in residential/tertiary.
 *
 *  The heuristic is intentionally conservative: it biases the inferred
 *  road class *downward* (smaller/slower road) which pushes the reference
 *  speed *downward*, which makes overspeed detection more sensitive rather
 *  than less. Better to raise a borderline flag than silently let dangerous
 *  speeds through.
 */

import { RiderContext, RoadClass, TimeOfDayBucket } from './types';

/** Static Indian defaults when maxspeed is missing (spec §3.1). */
const SPEED_LIMIT_BY_CLASS: Record<RoadClass, number> = {
  residential: 30,
  service:     30,
  tertiary:    40,
  secondary:   50,
  primary:     60,
  trunk_urban: 60,
  trunk_rural: 80,
  motorway:    80, // 2W legal limit on most Indian expressways
};

/** Typical ambient 2W flow speed on each road class, in km/h. Spec-aligned. */
const AMBIENT_BY_CLASS: Record<RoadClass, number> = {
  residential: 20,
  service:     20,
  tertiary:    30,
  secondary:   40,
  primary:     50,
  trunk_urban: 55,
  trunk_rural: 65,
  motorway:    70,
};

/** 15% faster than ambient — delivery riders legitimately move faster than flow. */
const AMBIENT_DELIVERY_BUFFER = 1.15;

export interface RiderContextProviderOptions {
  todDayWeight: number;
  todDuskWeight: number;
  todNightWeight: number;
}

export class RiderContextProvider {
  private ambient2wSpeedKmH: number | null = null;
  private speedLimitKmH: number | null = null;
  private roadClass: RoadClass | null = null;
  private ambientIsLive = false;

  /** Rolling window of recent speeds for heuristic road-class inference. */
  private recentSpeeds: number[] = [];
  private readonly SPEEDS_MAX = 30; // ~30 s at 1 Hz

  private opts: RiderContextProviderOptions;

  constructor(opts: RiderContextProviderOptions) {
    this.opts = opts;
  }

  updateOptions(patch: Partial<RiderContextProviderOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  /** Called by an external Mappls/traffic integration (if available). */
  setAmbient2WSpeed(kmH: number): void {
    if (kmH > 0) {
      this.ambient2wSpeedKmH = kmH;
      this.ambientIsLive = true;
    }
  }

  /** Called by an external OSM/Mappls integration (if available). */
  setRoadClass(rc: RoadClass): void { this.roadClass = rc; }

  /** Called by an external source (OSM maxspeed tag, zone beacon, etc.). */
  setSpeedLimit(kmH: number): void {
    if (kmH > 0) this.speedLimitKmH = kmH;
  }

  /** Must be called every speed tick so the heuristic fallback stays current. */
  recordSpeed(kmH: number): void {
    this.recentSpeeds.push(kmH);
    if (this.recentSpeeds.length > this.SPEEDS_MAX) this.recentSpeeds.shift();
  }

  /**
   * Compute the current rider context. Fallbacks layer cleanly:
   *   1. Live Mappls ambient + OSM speed limit (preferred).
   *   2. OSM road class + class defaults.
   *   3. Heuristic road-class inference from recent rolling speed.
   */
  getContext(now: number = Date.now()): RiderContext {
    const heuristicClass = this.inferRoadClass();
    const roadClass = this.roadClass ?? heuristicClass;

    const speedLimit = this.speedLimitKmH ?? SPEED_LIMIT_BY_CLASS[roadClass];
    const ambient = this.ambient2wSpeedKmH ?? AMBIENT_BY_CLASS[roadClass];

    const tod = bucketTimeOfDay(now);
    const todWeight = this.timeOfDayWeight(tod);

    return {
      ambient2wSpeedKmH: ambient,
      speedLimitKmH: speedLimit,
      roadClass,
      timeOfDay: tod,
      timeOfDayWeight: todWeight,
      isFallback: !(this.ambientIsLive && this.roadClass !== null && this.speedLimitKmH !== null),
    };
  }

  /**
   * Reference speed for overspeed detection:
   *   ref = max(ambient × 1.15, legal_limit)
   * Ambient-based reference lets urban riders filter-split slightly above
   * flow without being flagged, while the legal limit prevents absurd
   * underestimates (e.g., a congested motorway's ambient might be 35 km/h).
   */
  getReferenceSpeedKmH(ctx?: RiderContext): number {
    const c = ctx ?? this.getContext();
    return Math.max(c.ambient2wSpeedKmH * AMBIENT_DELIVERY_BUFFER, c.speedLimitKmH);
  }

  reset(): void {
    this.ambient2wSpeedKmH = null;
    this.speedLimitKmH = null;
    this.roadClass = null;
    this.ambientIsLive = false;
    this.recentSpeeds = [];
  }

  // ------- internals -------

  private timeOfDayWeight(tod: TimeOfDayBucket): number {
    switch (tod) {
      case 'day':   return this.opts.todDayWeight;
      case 'dusk':  return this.opts.todDuskWeight;
      case 'night': return this.opts.todNightWeight;
    }
  }

  /**
   * Heuristic road-class inference from recent rolling speed distribution.
   * Biased downward (slower road class) to err on the side of more-sensitive
   * overspeed detection. Uses p80 of recent speeds as the characteristic.
   */
  private inferRoadClass(): RoadClass {
    if (this.recentSpeeds.length < 10) return 'tertiary'; // conservative mid-range default

    const sorted = [...this.recentSpeeds].sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)];

    if (p80 < 25) return 'residential';
    if (p80 < 35) return 'tertiary';
    if (p80 < 50) return 'secondary';
    if (p80 < 65) return 'primary';
    if (p80 < 75) return 'trunk_urban';
    return 'trunk_rural';
  }
}

/**
 * Time-of-day bucketing. Uses local time from the Date object. Dusk is
 * defined per the spec (18:00–20:00). Night is 20:00–06:00.
 */
export function bucketTimeOfDay(now: number): TimeOfDayBucket {
  const hour = new Date(now).getHours();
  if (hour >= 6 && hour < 18) return 'day';
  if (hour >= 18 && hour < 20) return 'dusk';
  return 'night';
}

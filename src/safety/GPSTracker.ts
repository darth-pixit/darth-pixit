/**
 * GPSTracker — accumulates GPS points over a trip, maintains a
 * downsampled breadcrumb trail, and computes distance.
 *
 * Why Haversine (and not a projected planar distance)?
 *   For trips under a few hundred km it's accurate to <0.5% and doesn't
 *   need a UTM zone. For intercity driving where the Earth's curvature
 *   matters, Haversine is still the simplest thing that's correct.
 *
 * Why accuracy-gating?
 *   GPS in urban canyons can jitter by 30+ m. If we integrate every
 *   sample into distance, a parked car at a red light accumulates
 *   "distance" from noise alone. We drop points whose reported accuracy
 *   is worse than 20 m, and we require a minimum inter-point distance
 *   (2 m) so same-position jitter doesn't inflate odometer.
 */

import { GPSPoint } from './types';

const EARTH_RADIUS_M = 6371000;
const MAX_ACCURACY_M = 20;
const MIN_STEP_M = 2;
/** Subsample trail to one point per ~5s for display. Raw samples still drive scoring. */
const TRAIL_MIN_INTERVAL_MS = 5000;

export class GPSTracker {
  private last: GPSPoint | null = null;
  private distanceM = 0;
  private trail: Array<{ lat: number; lng: number; t: number }> = [];
  private lastTrailT = 0;
  /** All points in the current trip, for crash-report pre-impact trail. */
  private recent: GPSPoint[] = [];
  private readonly RECENT_WINDOW_MS = 60000;

  ingest(point: GPSPoint): { distanceDeltaM: number; accepted: boolean } {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
      return { distanceDeltaM: 0, accepted: false };
    }
    if (point.accuracyM > MAX_ACCURACY_M) {
      return { distanceDeltaM: 0, accepted: false };
    }

    this.recent.push(point);
    const cutoff = point.t - this.RECENT_WINDOW_MS;
    while (this.recent.length > 1 && this.recent[0].t < cutoff) {
      this.recent.shift();
    }

    let delta = 0;
    if (this.last) {
      delta = haversineM(this.last.lat, this.last.lng, point.lat, point.lng);
      if (delta < MIN_STEP_M) {
        // Still update last so we don't miss gradual drift across many samples,
        // but don't inflate distance.
        delta = 0;
      } else {
        this.distanceM += delta;
      }
    }
    this.last = point;

    if (point.t - this.lastTrailT > TRAIL_MIN_INTERVAL_MS || this.trail.length === 0) {
      this.trail.push({ lat: point.lat, lng: point.lng, t: point.t });
      this.lastTrailT = point.t;
    }

    return { distanceDeltaM: delta, accepted: true };
  }

  getDistanceM(): number {
    return this.distanceM;
  }

  getTrail(): Array<{ lat: number; lng: number; t: number }> {
    return this.trail;
  }

  getLast(): GPSPoint | null {
    return this.last;
  }

  /** Last N seconds of GPS points — for crash report. */
  getRecent(): GPSPoint[] {
    return [...this.recent];
  }

  reset(): void {
    this.last = null;
    this.distanceM = 0;
    this.trail = [];
    this.lastTrailT = 0;
    this.recent = [];
  }
}

export function haversineM(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const dφ = ((lat2 - lat1) * Math.PI) / 180;
  const dλ = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

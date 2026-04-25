/**
 * OSMOverpassClient — OpenStreetMap Overpass bridge.
 *
 * ================================================================
 *  WHAT IT FETCHES (spec §3.1)
 * ================================================================
 *
 *  1. Nearest highway way tag → road class + maxspeed (if tagged).
 *  2. Traffic-signal nodes within 30 m — used by the normal-stop
 *     false-positive filter so a "gradual decel to zero" near a
 *     signal is reliably classified as a red-light stop, not a
 *     hard brake.
 *
 *  Overpass is free, unauthenticated, and rate-limited per IP. We
 *  cache aggressively (24 h) keyed by ~150 m grid so a single rider's
 *  full shift issues ≤ ~50 requests.
 *
 *  A single Overpass query bundles both data needs; one network
 *  round-trip covers road + signals for a segment.
 *
 * ================================================================
 *  FALLBACK
 * ================================================================
 *
 *  Overpass has occasional outages. The client never throws — it
 *  returns null, and the engine falls back to the heuristic road-class
 *  inference in RiderContextProvider. Traffic-signal proximity simply
 *  becomes "unknown", and the RoadObstacleFilter keeps its physical
 *  signature ("gradual decel → zero speed") which is what v1 uses.
 */

import { RoadClass } from './types';
import { parseMaxspeed, toRoadClass } from './MapplsClient';

export interface OSMOverpassClientOptions {
  /** Overpass endpoint; override to use a self-hosted mirror. */
  endpoint?: string;
  /** Radius for the highway way lookup, metres. */
  wayRadiusM?: number;
  /** Radius for traffic-signal node lookup, metres. */
  signalRadiusM?: number;
  /** Network timeout per request, ms. */
  timeoutMs?: number;
  /** Max LRU entries. */
  cacheSize?: number;
  /** Cache TTL, ms. */
  cacheTTLMs?: number;
}

export interface TrafficSignalPoint {
  lat: number;
  lng: number;
  distM: number;
}

export interface OSMResult {
  roadClass: RoadClass;
  speedLimitKmH: number | null;
  maxspeedRaw?: string;
  trafficSignalsNearby: TrafficSignalPoint[];
  fetchedAt: number;
  /** True if the fetch came from the network; false if served from cache. */
  fresh: boolean;
}

const DEFAULT_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const DEFAULT_WAY_RADIUS_M = 25;
const DEFAULT_SIGNAL_RADIUS_M = 40;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CACHE_SIZE = 512;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;

const GRID_DEG = 0.0015; // ~150 m

const BACKOFF_MS = [1000, 5000, 30_000, 120_000];

interface UrlBackoff { failures: number; nextAttemptAt: number }

export class OSMOverpassClient {
  private opts: Required<OSMOverpassClientOptions>;
  private cache = new Map<string, OSMResult>();
  private backoff: UrlBackoff = { failures: 0, nextAttemptAt: 0 };

  constructor(opts: OSMOverpassClientOptions = {}) {
    this.opts = {
      endpoint: opts.endpoint ?? DEFAULT_ENDPOINT,
      wayRadiusM: opts.wayRadiusM ?? DEFAULT_WAY_RADIUS_M,
      signalRadiusM: opts.signalRadiusM ?? DEFAULT_SIGNAL_RADIUS_M,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cacheSize: opts.cacheSize ?? DEFAULT_CACHE_SIZE,
      cacheTTLMs: opts.cacheTTLMs ?? DEFAULT_TTL_MS,
    };
  }

  async query(lat: number, lng: number, now: number = Date.now()): Promise<OSMResult | null> {
    const key = this.cellKey(lat, lng);
    const cached = this.cache.get(key);
    if (cached && now - cached.fetchedAt < this.opts.cacheTTLMs) {
      this.touchLRU(key, cached);
      return { ...cached, fresh: false };
    }

    if (now < this.backoff.nextAttemptAt) {
      return cached ? { ...cached, fresh: false } : null;
    }

    const ql = this.buildQuery(lat, lng);
    try {
      const resp = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: `[out:json][timeout:10];${ql}`,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!resp.ok) { this.recordFailure(); return cached ?? null; }
      const json = await resp.json() as { elements?: OverpassElement[] };
      this.backoff = { failures: 0, nextAttemptAt: 0 };
      const parsed = this.parse(json.elements ?? [], lat, lng, now);
      this.putLRU(key, parsed);
      return parsed;
    } catch {
      this.recordFailure();
      return cached ?? null;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  // ---------- internals ----------

  private buildQuery(lat: number, lng: number): string {
    const wr = this.opts.wayRadiusM;
    const sr = this.opts.signalRadiusM;
    // Return the nearest highway way + all traffic signal nodes nearby.
    return (
      `way(around:${wr},${lat.toFixed(6)},${lng.toFixed(6)})[highway];out tags 1;` +
      `node(around:${sr},${lat.toFixed(6)},${lng.toFixed(6)})[highway=traffic_signals];out;`
    );
  }

  private parse(elements: OverpassElement[], lat: number, lng: number, now: number): OSMResult {
    let rawHighway: string | undefined;
    let maxspeedRaw: string | undefined;
    const signals: TrafficSignalPoint[] = [];

    for (const el of elements) {
      if (el.type === 'way' && el.tags) {
        if (!rawHighway) rawHighway = el.tags.highway;
        if (!maxspeedRaw) maxspeedRaw = el.tags.maxspeed;
      } else if (el.type === 'node' && el.tags?.highway === 'traffic_signals') {
        if (typeof el.lat === 'number' && typeof el.lon === 'number') {
          const d = haversineM(lat, lng, el.lat, el.lon);
          signals.push({ lat: el.lat, lng: el.lon, distM: d });
        }
      }
    }
    signals.sort((a, b) => a.distM - b.distM);

    return {
      roadClass: toRoadClass(rawHighway),
      speedLimitKmH: parseMaxspeed(maxspeedRaw),
      maxspeedRaw,
      trafficSignalsNearby: signals,
      fetchedAt: now,
      fresh: true,
    };
  }

  private recordFailure(): void {
    this.backoff.failures = Math.min(this.backoff.failures + 1, BACKOFF_MS.length);
    this.backoff.nextAttemptAt = Date.now() + BACKOFF_MS[this.backoff.failures - 1];
  }

  private cellKey(lat: number, lng: number): string {
    const la = Math.round(lat / GRID_DEG) * GRID_DEG;
    const lo = Math.round(lng / GRID_DEG) * GRID_DEG;
    return `${la.toFixed(4)},${lo.toFixed(4)}`;
  }

  private putLRU(key: string, val: OSMResult): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, val);
    while (this.cache.size > this.opts.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private touchLRU(key: string, val: OSMResult): void {
    this.cache.delete(key);
    this.cache.set(key, val);
  }
}

interface OverpassElement {
  type: 'way' | 'node' | 'relation';
  id?: number;
  lat?: number;
  lon?: number;
  tags?: {
    highway?: string;
    maxspeed?: string;
    [k: string]: string | undefined;
  };
}

export function haversineM(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLa = toRad(la2 - la1);
  const dLo = toRad(lo2 - lo1);
  const a =
    Math.sin(dLa / 2) * Math.sin(dLa / 2) +
    Math.cos(toRad(la1)) * Math.cos(toRad(la2)) *
      Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

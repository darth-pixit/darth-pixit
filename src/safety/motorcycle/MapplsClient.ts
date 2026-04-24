/**
 * MapplsClient — Mappls (MapmyIndia) REST bridge for the 2W rider context.
 *
 * ================================================================
 *  WHAT IT FETCHES
 * ================================================================
 *
 *  1. Traffic flow speed for a 2W profile at a given lat/lng. This is
 *     the "ambient 2W speed" in spec §4.1: the reference the overspeed
 *     detector compares against (with +15% delivery-rider buffer).
 *
 *  2. Reverse-geocode the segment to derive road class and, when
 *     present, the legal speed limit (maxspeed tag).
 *
 *  Both are optional. The engine degrades cleanly when either is
 *  unavailable — RiderContextProvider has a heuristic road-class
 *  inference from rolling-speed p80 for offline/no-auth scenarios.
 *
 * ================================================================
 *  WHY THE ENDPOINT TEMPLATES ARE CONFIGURABLE
 * ================================================================
 *
 *  Mappls surfaces 2W traffic flow to fleet customers through a
 *  handful of endpoint SKUs that vary by product tier (Traffic Flow
 *  Speed API, Nearby Flow, Route-level flow, etc.). Hard-coding one
 *  path means a customer swap breaks the client. Instead we accept
 *  full URL templates with {apiKey} / {lat} / {lng} placeholders,
 *  defaulting to the most common public pattern. Override via options.
 *
 * ================================================================
 *  AUTH
 * ================================================================
 *
 *  Two supported modes:
 *    1. REST API key — passed in a header (Authorization: bearer) OR
 *       interpolated into the URL (older endpoints). Choose via
 *       `apiKeyInUrl`.
 *    2. OAuth 2.0 client credentials — exchange clientId/clientSecret
 *       for a token, reused until it expires (typical 24 h).
 *
 *  OAuth is attempted first if credentials are provided; fallback to
 *  REST key if the token exchange fails.
 *
 * ================================================================
 *  CACHING
 * ================================================================
 *
 *  - Flow:  15 min TTL (spec §3.2), keyed by ~100 m grid cell.
 *  - Rev:   24 h TTL, keyed by ~150 m grid cell (road network stable).
 *  - LRU bounded to 512 entries for each cache.
 *
 *  This is critical on Indian roads: a rider crosses a new flow segment
 *  every ~30 s in a dense ride. A naive "fetch per GPS tick" would burn
 *  ~3000 calls/shift/rider and the API quota within hours.
 */

import { RoadClass } from './types';

export interface MapplsClientOptions {
  /** REST API key. Required unless using OAuth client-credentials. */
  apiKey?: string;
  /** OAuth client ID (preferred over apiKey when available). */
  clientId?: string;
  /** OAuth client secret. */
  clientSecret?: string;

  /** If true, apiKey is interpolated into {apiKey} in URL templates. */
  apiKeyInUrl?: boolean;

  /**
   * URL template for 2W traffic-flow lookup. The client substitutes
   * {apiKey}, {lat}, {lng} before fetching. Override for endpoint SKUs
   * other than the default.
   */
  trafficFlowUrl?: string;
  /** URL template for reverse-geocode. Same substitution rules. */
  revGeocodeUrl?: string;
  /** OAuth token exchange URL. */
  tokenUrl?: string;

  /** Network timeout per request, ms. */
  timeoutMs?: number;
  /** Max LRU entries per cache. */
  cacheSize?: number;
}

export interface MapplsTrafficResult {
  ambient2wSpeedKmH: number;
  confidence: 'live' | 'stale';
  fetchedAt: number;
}

export interface MapplsReverseResult {
  roadClass: RoadClass;
  speedLimitKmH: number | null;
  maxspeedRaw?: string;
  fetchedAt: number;
}

const DEFAULT_TRAFFIC_URL =
  'https://apis.mappls.com/advancedmaps/v1/{apiKey}/traffic_speed?lat={lat}&lng={lng}&profile=2w';
const DEFAULT_REV_URL =
  'https://apis.mappls.com/advancedmaps/v1/{apiKey}/rev_geocode?lat={lat}&lng={lng}';
const DEFAULT_TOKEN_URL =
  'https://outpost.mappls.com/api/security/oauth/token';

const FLOW_TTL_MS = 15 * 60_000;
const REV_TTL_MS  = 24 * 60 * 60_000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_SIZE = 512;
const FLOW_GRID_DEG = 0.001;   // ~100 m at the equator
const REV_GRID_DEG  = 0.0015;  // ~150 m

/** Backoff schedule (ms) when a request fails. Caps at 60 s. */
const BACKOFF_MS = [1000, 3000, 10_000, 30_000, 60_000];

/**
 * Attempts-failed tracker per URL so we don't retry immediately after a
 * failure storm. Avoids hammering the API during an outage.
 */
interface UrlBackoff { failures: number; nextAttemptAt: number }

export class MapplsClient {
  private opts: Required<Omit<MapplsClientOptions, 'apiKey' | 'clientId' | 'clientSecret'>> &
    Pick<MapplsClientOptions, 'apiKey' | 'clientId' | 'clientSecret'>;

  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string | null> | null = null;

  private flowCache = new Map<string, MapplsTrafficResult>();
  private revCache = new Map<string, MapplsReverseResult>();
  private backoff = new Map<string, UrlBackoff>();

  constructor(opts: MapplsClientOptions) {
    if (!opts.apiKey && !(opts.clientId && opts.clientSecret)) {
      throw new Error('MapplsClient: requires apiKey or OAuth credentials');
    }
    this.opts = {
      apiKey: opts.apiKey,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      apiKeyInUrl: opts.apiKeyInUrl ?? true,
      trafficFlowUrl: opts.trafficFlowUrl ?? DEFAULT_TRAFFIC_URL,
      revGeocodeUrl: opts.revGeocodeUrl ?? DEFAULT_REV_URL,
      tokenUrl: opts.tokenUrl ?? DEFAULT_TOKEN_URL,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      cacheSize: opts.cacheSize ?? DEFAULT_CACHE_SIZE,
    };
  }

  /**
   * Fetch ambient 2W traffic flow speed. Never throws — returns null on
   * any failure so the engine falls back to the heuristic pipeline.
   */
  async getTrafficFlow(lat: number, lng: number, now: number = Date.now()): Promise<MapplsTrafficResult | null> {
    const key = this.cellKey(lat, lng, FLOW_GRID_DEG);
    const cached = this.flowCache.get(key);
    if (cached && now - cached.fetchedAt < FLOW_TTL_MS) {
      this.touchLRU(this.flowCache, key, cached);
      return cached;
    }

    const url = this.interpolate(this.opts.trafficFlowUrl, lat, lng);
    const json = await this.requestJSON<Record<string, unknown>>(url);
    if (!json) {
      // Serve stale if we have something — marginally worse than nothing.
      if (cached) return { ...cached, confidence: 'stale' };
      return null;
    }

    // Accept a few plausible response shapes. Mappls variants return
    // speedKmH / speed / flowSpeed depending on the SKU.
    const speedKmH = pickNumber(json, ['speedKmH', 'speed', 'flowSpeed', 'current_speed']);
    if (speedKmH === null || speedKmH <= 0) return cached ?? null;

    const result: MapplsTrafficResult = {
      ambient2wSpeedKmH: speedKmH,
      confidence: 'live',
      fetchedAt: now,
    };
    this.putLRU(this.flowCache, key, result);
    return result;
  }

  /**
   * Reverse-geocode to road class + legal speed limit. Cached 24 h.
   */
  async reverseGeocode(lat: number, lng: number, now: number = Date.now()): Promise<MapplsReverseResult | null> {
    const key = this.cellKey(lat, lng, REV_GRID_DEG);
    const cached = this.revCache.get(key);
    if (cached && now - cached.fetchedAt < REV_TTL_MS) {
      this.touchLRU(this.revCache, key, cached);
      return cached;
    }

    const url = this.interpolate(this.opts.revGeocodeUrl, lat, lng);
    const json = await this.requestJSON<Record<string, unknown>>(url);
    if (!json) return cached ?? null;

    const rawHighway =
      pickString(json, ['highway', 'road_class', 'class']) ??
      pickNestedString(json, ['results', 0, 'road_class']) ??
      pickNestedString(json, ['results', 0, 'highway']);
    const maxspeedRaw =
      pickString(json, ['maxspeed', 'speed_limit']) ??
      pickNestedString(json, ['results', 0, 'maxspeed']) ??
      pickNestedString(json, ['results', 0, 'speed_limit']);

    const roadClass = toRoadClass(rawHighway);
    const speedLimitKmH = parseMaxspeed(maxspeedRaw);
    const result: MapplsReverseResult = {
      roadClass,
      speedLimitKmH,
      maxspeedRaw: maxspeedRaw ?? undefined,
      fetchedAt: now,
    };
    this.putLRU(this.revCache, key, result);
    return result;
  }

  clearCache(): void {
    this.flowCache.clear();
    this.revCache.clear();
    this.backoff.clear();
  }

  // ----------- internals -----------

  private async requestJSON<T>(url: string): Promise<T | null> {
    const now = Date.now();
    const bo = this.backoff.get(url);
    if (bo && now < bo.nextAttemptAt) return null;

    let headers: Record<string, string> = { Accept: 'application/json' };

    // OAuth path
    if (this.opts.clientId && this.opts.clientSecret) {
      const token = await this.ensureToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    } else if (this.opts.apiKey && !this.opts.apiKeyInUrl) {
      headers.Authorization = `Bearer ${this.opts.apiKey}`;
    }

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      if (!resp.ok) {
        this.recordFailure(url);
        return null;
      }
      const json = await resp.json() as T;
      this.backoff.delete(url);
      return json;
    } catch {
      this.recordFailure(url);
      return null;
    }
  }

  private async ensureToken(): Promise<string | null> {
    const now = Date.now();
    if (this.token && now < this.token.expiresAt - 60_000) return this.token.value;
    if (this.tokenInFlight) return this.tokenInFlight;

    this.tokenInFlight = (async () => {
      try {
        const body = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.opts.clientId!,
          client_secret: this.opts.clientSecret!,
        }).toString();
        const resp = await fetch(this.opts.tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        if (!resp.ok) return null;
        const j = await resp.json() as { access_token?: string; expires_in?: number };
        if (!j.access_token) return null;
        const ttlMs = (j.expires_in ?? 86_400) * 1000;
        this.token = { value: j.access_token, expiresAt: now + ttlMs };
        return this.token.value;
      } catch {
        return null;
      } finally {
        this.tokenInFlight = null;
      }
    })();
    return this.tokenInFlight;
  }

  private recordFailure(url: string): void {
    const cur = this.backoff.get(url) ?? { failures: 0, nextAttemptAt: 0 };
    cur.failures = Math.min(cur.failures + 1, BACKOFF_MS.length);
    cur.nextAttemptAt = Date.now() + BACKOFF_MS[cur.failures - 1];
    this.backoff.set(url, cur);
  }

  private interpolate(template: string, lat: number, lng: number): string {
    return template
      .replace('{apiKey}', encodeURIComponent(this.opts.apiKey ?? ''))
      .replace('{lat}', lat.toFixed(6))
      .replace('{lng}', lng.toFixed(6))
      .replace('{lon}', lng.toFixed(6));
  }

  private cellKey(lat: number, lng: number, grid: number): string {
    const la = Math.round(lat / grid) * grid;
    const lo = Math.round(lng / grid) * grid;
    return `${la.toFixed(4)},${lo.toFixed(4)}`;
  }

  private putLRU<V>(cache: Map<string, V>, key: string, val: V): void {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, val);
    while (cache.size > this.opts.cacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  private touchLRU<V>(cache: Map<string, V>, key: string, val: V): void {
    cache.delete(key);
    cache.set(key, val);
  }
}

// ================================================================
//  Pure helpers — exported so OSM client can reuse the parser.
// ================================================================

/** Parse an OSM-style maxspeed string ("40", "40 mph", "IN:urban", ...). */
export function parseMaxspeed(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(mph|kmh|km\/h)?/);
  if (!m) {
    // OSM country-zone tags (e.g. "IN:urban"): use conservative defaults.
    if (s.includes('urban')) return 50;
    if (s.includes('rural')) return 80;
    if (s.includes('living_street')) return 20;
    return null;
  }
  const n = parseFloat(m[1]);
  const isMph = m[2] === 'mph';
  return isMph ? Math.round(n * 1.60934) : Math.round(n);
}

/** Map OSM/Mappls highway tag → our RoadClass union. */
export function toRoadClass(raw: string | null | undefined): RoadClass {
  if (!raw) return 'tertiary';
  const s = String(raw).toLowerCase();
  if (s.includes('motorway')) return 'motorway';
  if (s.includes('trunk')) {
    // We don't know urban vs rural from the tag alone; bias urban.
    return 'trunk_urban';
  }
  if (s.includes('primary')) return 'primary';
  if (s.includes('secondary')) return 'secondary';
  if (s.includes('tertiary')) return 'tertiary';
  if (s.includes('residential') || s.includes('living_street')) return 'residential';
  if (s.includes('service') || s.includes('unclassified')) return 'service';
  return 'tertiary';
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickNestedString(obj: unknown, path: Array<string | number>): string | null {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return typeof cur === 'string' && cur.length > 0 ? cur : null;
}

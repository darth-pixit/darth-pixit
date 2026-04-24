/**
 * ContextEnrichmentService — wires Mappls + OSM lookups into the engine.
 *
 * ================================================================
 *  ROLE
 * ================================================================
 *
 *  RiderContextProvider (in MotoTripManager) accepts three externally-
 *  pushed signals: ambient_2w_speed, road_class, speed_limit. This
 *  service owns the side of the pipeline that actually fetches those
 *  values from Mappls (2W flow) and OSM (road class / maxspeed) and
 *  pushes them in.
 *
 *  It also exposes a `nearestTrafficSignalM(lat, lng)` read used by the
 *  normal-stop obstacle filter to classify a brake as a red-light stop
 *  when it ends within 30 m of a tagged signal.
 *
 * ================================================================
 *  DEBOUNCING
 * ================================================================
 *
 *  A dispatch rider crosses ~100 m of the road network every 5–15 s.
 *  We trigger a lookup when:
 *    1. The rider has moved ≥ `debounceM` (default 100 m) since the
 *       last successful lookup, AND
 *    2. At least `debounceIntervalMs` (default 15 s) have passed, so
 *       we don't hammer the API when the rider is still within a cell.
 *
 *  A forced refresh happens every `maxStaleMs` regardless so we pick
 *  up traffic-flow changes even if the rider is parked.
 *
 * ================================================================
 *  FAILURE MODEL
 * ================================================================
 *
 *  Fetches are fire-and-forget — we don't await them from the GPS
 *  callback (blocking the ingest loop would hurt battery and latency).
 *  A failed lookup keeps the previous context live; a completely cold
 *  start with no network yields the heuristic road-class fallback in
 *  RiderContextProvider.
 */

import { GPSPoint } from '../types';
import { MapplsClient } from './MapplsClient';
import { OSMOverpassClient, TrafficSignalPoint, haversineM } from './OSMOverpassClient';
import { RoadClass } from './types';

export interface EngineContextSink {
  setAmbient2WSpeedKmH(kmH: number): void;
  setRoadClass(rc: RoadClass): void;
  setSpeedLimitKmH(kmH: number): void;
}

export interface ContextEnrichmentOptions {
  mappls?: MapplsClient;
  osm?: OSMOverpassClient;
  /** Minimum movement between lookups (m). */
  debounceM?: number;
  /** Minimum time between lookups (ms). */
  debounceIntervalMs?: number;
  /** Force a refresh after this much time even if the rider hasn't moved. */
  maxStaleMs?: number;
  /** Traffic-signal proximity considered "near" for normal-stop filter. */
  trafficSignalNearMeters?: number;
}

interface LastLookup {
  lat: number;
  lng: number;
  t: number;
  signals: TrafficSignalPoint[];
}

export class ContextEnrichmentService {
  private opts: Required<Omit<ContextEnrichmentOptions, 'mappls' | 'osm'>> &
    Pick<ContextEnrichmentOptions, 'mappls' | 'osm'>;
  private sink: EngineContextSink;
  private last: LastLookup | null = null;
  private inFlight = false;

  constructor(sink: EngineContextSink, opts: ContextEnrichmentOptions = {}) {
    this.sink = sink;
    this.opts = {
      mappls: opts.mappls,
      osm: opts.osm,
      debounceM: opts.debounceM ?? 100,
      debounceIntervalMs: opts.debounceIntervalMs ?? 15_000,
      maxStaleMs: opts.maxStaleMs ?? 15 * 60_000,
      trafficSignalNearMeters: opts.trafficSignalNearMeters ?? 30,
    };
  }

  /** Call this from the engine's GPS binding on every fix. */
  onGPS(point: GPSPoint): void {
    if (!this.shouldLookup(point)) return;
    if (this.inFlight) return;
    this.inFlight = true;
    this.lookup(point.lat, point.lng, point.t).finally(() => { this.inFlight = false; });
  }

  /**
   * Return the distance (metres) to the nearest known traffic signal
   * for a given location, or null if we haven't queried the area or
   * none were found.
   */
  nearestTrafficSignalM(lat: number, lng: number): number | null {
    if (!this.last || this.last.signals.length === 0) return null;
    let best = Infinity;
    for (const s of this.last.signals) {
      const d = haversineM(lat, lng, s.lat, s.lng);
      if (d < best) best = d;
    }
    return Number.isFinite(best) ? best : null;
  }

  /** True iff the given location is within the "near-signal" threshold. */
  isNearTrafficSignal(lat: number, lng: number): boolean {
    const d = this.nearestTrafficSignalM(lat, lng);
    return d !== null && d <= this.opts.trafficSignalNearMeters;
  }

  reset(): void {
    this.last = null;
  }

  // ---------- internals ----------

  private shouldLookup(p: GPSPoint): boolean {
    const now = p.t;
    if (!this.last) return true;
    const movedM = haversineM(p.lat, p.lng, this.last.lat, this.last.lng);
    const stale = now - this.last.t >= this.opts.maxStaleMs;
    if (stale) return true;
    if (movedM < this.opts.debounceM) return false;
    return now - this.last.t >= this.opts.debounceIntervalMs;
  }

  private async lookup(lat: number, lng: number, t: number): Promise<void> {
    const tasks: Array<Promise<unknown>> = [];
    if (this.opts.mappls) tasks.push(this.opts.mappls.getTrafficFlow(lat, lng, t).then(r => {
      if (r && r.ambient2wSpeedKmH > 0) this.sink.setAmbient2WSpeedKmH(r.ambient2wSpeedKmH);
    }));

    // Prefer OSM for road class + speed limit (Overpass tags are authoritative);
    // fall back to Mappls reverse-geocode if OSM is unavailable. We record
    // traffic-signal nodes from OSM only (Mappls doesn't expose them).
    let signals: TrafficSignalPoint[] = this.last?.signals ?? [];
    if (this.opts.osm) {
      tasks.push(this.opts.osm.query(lat, lng, t).then(r => {
        if (!r) return;
        this.sink.setRoadClass(r.roadClass);
        if (r.speedLimitKmH !== null) this.sink.setSpeedLimitKmH(r.speedLimitKmH);
        signals = r.trafficSignalsNearby;
      }));
    } else if (this.opts.mappls) {
      tasks.push(this.opts.mappls.reverseGeocode(lat, lng, t).then(r => {
        if (!r) return;
        this.sink.setRoadClass(r.roadClass);
        if (r.speedLimitKmH !== null) this.sink.setSpeedLimitKmH(r.speedLimitKmH);
      }));
    }

    try { await Promise.all(tasks); } catch { /* individual tasks never throw */ }
    this.last = { lat, lng, t, signals };
  }
}

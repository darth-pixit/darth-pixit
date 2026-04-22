/**
 * RouteTracker — tile-based route familiarity scoring.
 *
 * =============================================================
 *  How it works
 * =============================================================
 *
 *  The Earth is divided into a grid of tiles (default ~500 m × 500 m).
 *  Every GPS point visited during any trip increments that tile's visit
 *  count.  At the start of a new trip the first ~20 GPS points are
 *  compared against the stored tile counts to compute a "familiarity
 *  score" (0 = never been here, 1 = well-known route).
 *
 *  Score = (fraction of tiles with visit count ≥ 1) weighted by
 *           log(max_visits) so tiles visited many times count more.
 *
 *  This is evaluated mid-trip (after the first 2 km are covered) so we
 *  have enough tiles to judge familiarity.
 *
 * =============================================================
 *  Why a grace factor for unfamiliar routes?
 * =============================================================
 *
 *  On a first-time route you don't know:
 *    - Where sharp bends are → might corner harder (slightly)
 *    - What the posted speed limit is → might speed slightly
 *    - Where school zones / cyclists typically appear → less anticipation
 *
 *  A 15% penalty reduction for a completely unfamiliar route
 *  acknowledges this context without excusing genuinely dangerous
 *  behaviour (severity 3+ events get no grace, see SafetyScorer).
 *
 *  CRITIQUE: "I haven't been on this road" doesn't excuse hard cornering.
 *  The grace should ONLY apply to severity 1–2 events and should vanish
 *  after 2–3 repeat drives. The SafetyScorer enforces the severity cap;
 *  the graceFactor decays naturally as tiles accumulate visits.
 *
 * =============================================================
 *  Tile key encoding
 * =============================================================
 *
 *  tileSize = 0.005 degrees ≈ 556 m latitude, 390–556 m longitude.
 *  key = floor(lat / tileSize) + "_" + floor(lng / tileSize)
 *  ~7 million tiles cover the whole Earth — easily fits in AsyncStorage
 *  with a compact representation.
 *
 *  WHY not geohash? Geohash has better spatial locality properties
 *  but the same query ("is this point familiar?") is O(1) with our
 *  flat map vs O(log n) with a geohash tree. For the volumes here
 *  flat is simpler.
 *
 * =============================================================
 *  Storage
 * =============================================================
 *
 *  After a trip ends, `persistTiles()` should be called with the trip
 *  trail so new tiles are written to permanent storage. We keep a hot
 *  in-memory map for the current session.
 */

import { SafetyConfig, DEFAULT_SAFETY_CONFIG, RouteContext } from './types';
import { KVStore } from './SafetyDatabase';

const KV_KEY = 'safety/route/tiles';

type TileMap = Record<string, number>; // tile_key → visit count

export class RouteTracker {
  private cfg: SafetyConfig;
  private tiles: TileMap = {};
  private loaded = false;

  constructor(cfg: SafetyConfig = DEFAULT_SAFETY_CONFIG) {
    this.cfg = cfg;
  }

  updateConfig(patch: Partial<SafetyConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  async load(kv: KVStore): Promise<void> {
    try {
      const raw = await kv.getItem(KV_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          this.tiles = parsed as TileMap;
        }
      }
    } catch { /* start fresh */ }
    this.loaded = true;
  }

  async persist(kv: KVStore): Promise<void> {
    try {
      await kv.setItem(KV_KEY, JSON.stringify(this.tiles));
    } catch { /* non-fatal */ }
  }

  /**
   * Evaluate familiarity for a trail of GPS points (e.g., taken from
   * the first 2 km of the trip or the whole trip trail).
   * Tiles are looked up from the in-memory map without persisting.
   */
  evaluate(trail: Array<{ lat: number; lng: number }>): RouteContext {
    if (trail.length === 0) {
      return { familiarityScore: 0, graceFactor: 0.85, tilesMatched: 0, tilesTotal: 0 };
    }

    const keys = trail.map((p) => this.tileKey(p.lat, p.lng));
    const unique = Array.from(new Set(keys));
    const total = unique.length;
    let matchedWeight = 0;
    let totalWeight = 0;

    for (const key of unique) {
      const visits = this.tiles[key] ?? 0;
      // Weight: each tile contributes 1 to the denominator.
      // To the numerator it contributes: min(visits, fullFamiliar) / fullFamiliar
      // This way a tile visited 5 times is fully familiar; 0 = unknown.
      const weight = Math.min(visits, this.cfg.routeFullFamiliarVisits) /
        this.cfg.routeFullFamiliarVisits;
      matchedWeight += weight;
      totalWeight += 1;
    }

    const familiarityScore = total > 0 ? matchedWeight / totalWeight : 0;

    // Grace factor: linearly scales from 0.85 (fully unfamiliar) to 1.0 (fully familiar).
    const graceFactor = 0.85 + 0.15 * familiarityScore;

    return {
      familiarityScore,
      graceFactor,
      tilesMatched: Math.round(matchedWeight),
      tilesTotal: total,
    };
  }

  /**
   * Record all tiles in a trail as visited. Call after each trip ends.
   * Does NOT write to persistent storage — call persist() separately.
   */
  recordTrail(trail: Array<{ lat: number; lng: number }>): void {
    for (const p of trail) {
      const key = this.tileKey(p.lat, p.lng);
      this.tiles[key] = (this.tiles[key] ?? 0) + 1;
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  private tileKey(lat: number, lng: number): string {
    const s = this.cfg.routeTileSize;
    return `${Math.floor(lat / s)}_${Math.floor(lng / s)}`;
  }
}

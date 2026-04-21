/**
 * SafetyDatabase — persistence for trips, crash reports, and config.
 *
 * Storage abstraction: we take a simple key/value interface so the app
 * can back this with AsyncStorage, MMKV, filesystem, SQLite, or an
 * in-memory store for tests. Keeping persistence out of the engine
 * core means the algorithms stay independent of any RN library.
 *
 * Schema:
 *   safety/config          → SafetyConfig (single doc)
 *   safety/trips/index     → string[] of trip ids, newest first
 *   safety/trips/<id>      → TripRecord
 *   safety/crashes/<id>    → CrashReport (also embedded in TripRecord,
 *                            but stored separately for fast recall)
 *
 * Trip list index lets us load metadata for the history screen
 * without deserializing every full trip (useful once the list is long).
 */

import { TripRecord, CrashReport, SafetyConfig, DEFAULT_SAFETY_CONFIG } from './types';

export interface KVStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  /**
   * Optional: return all keys with a given prefix. Used for index
   * rebuilds and debug. AsyncStorage has getAllKeys() — wire it here
   * if available.
   */
  getAllKeys?(): Promise<string[]>;
}

export class InMemoryKV implements KVStore {
  private store = new Map<string, string>();
  async getItem(k: string) { return this.store.get(k) ?? null; }
  async setItem(k: string, v: string) { this.store.set(k, v); }
  async removeItem(k: string) { this.store.delete(k); }
  async getAllKeys() { return Array.from(this.store.keys()); }
}

const KEY_CONFIG = 'safety/config';
const KEY_TRIPS_INDEX = 'safety/trips/index';
const KEY_TRIP = (id: string) => `safety/trips/${id}`;
const KEY_CRASH = (id: string) => `safety/crashes/${id}`;

const MAX_TRIPS_KEPT = 200; // cap history to avoid unbounded growth

export class SafetyDatabase {
  constructor(private kv: KVStore) {}

  // ---------- Config ----------

  async loadConfig(): Promise<SafetyConfig> {
    const raw = await this.kv.getItem(KEY_CONFIG);
    if (!raw) return { ...DEFAULT_SAFETY_CONFIG };
    try {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SAFETY_CONFIG, ...parsed };
    } catch {
      return { ...DEFAULT_SAFETY_CONFIG };
    }
  }

  async saveConfig(cfg: SafetyConfig): Promise<void> {
    await this.kv.setItem(KEY_CONFIG, JSON.stringify(cfg));
  }

  // ---------- Trips ----------

  async saveTrip(trip: TripRecord): Promise<void> {
    await this.kv.setItem(KEY_TRIP(trip.id), JSON.stringify(trip));
    const index = await this.loadTripIndex();
    if (!index.includes(trip.id)) {
      index.unshift(trip.id);
      // Trim to cap.
      while (index.length > MAX_TRIPS_KEPT) {
        const dropped = index.pop();
        if (dropped) await this.kv.removeItem(KEY_TRIP(dropped)).catch(() => {});
      }
      await this.kv.setItem(KEY_TRIPS_INDEX, JSON.stringify(index));
    }
    if (trip.crash) {
      await this.kv.setItem(KEY_CRASH(trip.crash.id), JSON.stringify(trip.crash));
    }
  }

  async loadTrip(id: string): Promise<TripRecord | null> {
    const raw = await this.kv.getItem(KEY_TRIP(id));
    if (!raw) return null;
    try { return JSON.parse(raw) as TripRecord; } catch { return null; }
  }

  async loadTripIndex(): Promise<string[]> {
    const raw = await this.kv.getItem(KEY_TRIPS_INDEX);
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  async loadAllTrips(limit: number = 50): Promise<TripRecord[]> {
    const ids = (await this.loadTripIndex()).slice(0, limit);
    const trips: TripRecord[] = [];
    for (const id of ids) {
      const t = await this.loadTrip(id);
      if (t) trips.push(t);
    }
    return trips;
  }

  async deleteTrip(id: string): Promise<void> {
    await this.kv.removeItem(KEY_TRIP(id));
    const index = await this.loadTripIndex();
    const next = index.filter((i) => i !== id);
    if (next.length !== index.length) {
      await this.kv.setItem(KEY_TRIPS_INDEX, JSON.stringify(next));
    }
  }

  // ---------- Crashes ----------

  async loadCrash(id: string): Promise<CrashReport | null> {
    const raw = await this.kv.getItem(KEY_CRASH(id));
    if (!raw) return null;
    try { return JSON.parse(raw) as CrashReport; } catch { return null; }
  }

  async loadAllCrashes(): Promise<CrashReport[]> {
    if (!this.kv.getAllKeys) return [];
    const keys = await this.kv.getAllKeys();
    const crashKeys = keys.filter((k) => k.startsWith('safety/crashes/'));
    const out: CrashReport[] = [];
    for (const k of crashKeys) {
      const raw = await this.kv.getItem(k);
      if (!raw) continue;
      try { out.push(JSON.parse(raw) as CrashReport); } catch { /* skip */ }
    }
    return out.sort((a, b) => b.detectedAt - a.detectedAt);
  }
}

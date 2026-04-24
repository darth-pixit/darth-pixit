import { open } from '@op-engineering/op-sqlite';
import type { DB } from '@op-engineering/op-sqlite';
import type { OBDData } from '../obd/OBDManager';

export interface TripRow {
  id: string;
  started_at: number;
  ended_at: number | null;
  distance_km: number;
  fuel_used_l: number;
  avg_kml: number | null;
  eco_secs: number;
  moderate_secs: number;
  push_secs: number;
  is_demo: number;
}

export interface TripSummaryStats {
  endedAt: number;
  distanceKm: number;
  fuelUsedL: number;
  avgKmL: number | null;
  ecoSecs: number;
  moderateSecs: number;
  pushSecs: number;
}

export interface ReadingRow {
  id: number;
  trip_id: string;
  ts: number;
  rpm: number | null;
  speed_kmh: number | null;
  fuel_rate_lph: number | null;
  engine_load_pct: number | null;
  maf_g_per_s: number | null;
  map_kpa: number | null;
  coolant_c: number | null;
  battery_v: number | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS trips (
    id            TEXT    PRIMARY KEY,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    distance_km   REAL    NOT NULL DEFAULT 0,
    fuel_used_l   REAL    NOT NULL DEFAULT 0,
    avg_kml       REAL,
    eco_secs      REAL    NOT NULL DEFAULT 0,
    moderate_secs REAL    NOT NULL DEFAULT 0,
    push_secs     REAL    NOT NULL DEFAULT 0,
    is_demo       INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS obd_readings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id         TEXT    NOT NULL REFERENCES trips(id),
    ts              INTEGER NOT NULL,
    rpm             REAL,
    speed_kmh       REAL,
    fuel_rate_lph   REAL,
    engine_load_pct REAL,
    maf_g_per_s     REAL,
    map_kpa         REAL,
    coolant_c       REAL,
    battery_v       REAL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_readings_trip ON obd_readings(trip_id)`,
  `CREATE INDEX IF NOT EXISTS idx_readings_ts   ON obd_readings(ts)`,
];

export class TelemetryDB {
  private static instance: TelemetryDB | null = null;
  private db: DB | null = null;

  static getInstance(): TelemetryDB {
    if (!TelemetryDB.instance) TelemetryDB.instance = new TelemetryDB();
    return TelemetryDB.instance;
  }

  async init(): Promise<void> {
    if (this.db) return;
    this.db = open({ name: 'darth_pixit.db' });
    for (const sql of SCHEMA) {
      await this.db.execute(sql);
    }
  }

  private getDB(): DB {
    if (!this.db) throw new Error('TelemetryDB.init() was not called');
    return this.db;
  }

  async createTrip(id: string, startedAt: number, isDemo: boolean): Promise<void> {
    await this.getDB().execute(
      `INSERT OR IGNORE INTO trips (id, started_at, is_demo) VALUES (?, ?, ?)`,
      [id, startedAt, isDemo ? 1 : 0],
    );
  }

  async insertReading(tripId: string, data: Partial<OBDData>): Promise<void> {
    await this.getDB().execute(
      `INSERT INTO obd_readings
        (trip_id, ts, rpm, speed_kmh, fuel_rate_lph, engine_load_pct, maf_g_per_s, map_kpa, coolant_c, battery_v)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tripId,
        Date.now(),
        data.rpm ?? null,
        data.speedKmH ?? null,
        data.fuelRateLPerH ?? null,
        data.engineLoadPct ?? null,
        data.mafGPerS ?? null,
        data.mapKPa ?? null,
        data.coolantC ?? null,
        data.batteryVolts ?? null,
      ],
    );
  }

  async closeTrip(id: string, stats: TripSummaryStats): Promise<void> {
    await this.getDB().execute(
      `UPDATE trips
       SET ended_at = ?, distance_km = ?, fuel_used_l = ?, avg_kml = ?,
           eco_secs = ?, moderate_secs = ?, push_secs = ?
       WHERE id = ?`,
      [
        stats.endedAt,
        stats.distanceKm,
        stats.fuelUsedL,
        stats.avgKmL ?? null,
        stats.ecoSecs,
        stats.moderateSecs,
        stats.pushSecs,
        id,
      ],
    );
  }

  async getTrips(limit = 50): Promise<TripRow[]> {
    const result = await this.getDB().execute(
      `SELECT * FROM trips WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?`,
      [limit],
    );
    return (result.rows ?? []) as unknown as TripRow[];
  }

  async getTripReadings(tripId: string): Promise<ReadingRow[]> {
    const result = await this.getDB().execute(
      `SELECT * FROM obd_readings WHERE trip_id = ? ORDER BY ts ASC`,
      [tripId],
    );
    return (result.rows ?? []) as unknown as ReadingRow[];
  }

  /** Daily average km/L over the last `days` calendar days. */
  async getEfficiencyTrend(days = 30): Promise<Array<{ date: string; avg_kml: number }>> {
    const result = await this.getDB().execute(
      `SELECT date(started_at / 1000, 'unixepoch') AS date,
              AVG(avg_kml) AS avg_kml
       FROM trips
       WHERE ended_at IS NOT NULL
         AND avg_kml IS NOT NULL
         AND started_at >= ?
       GROUP BY date
       ORDER BY date ASC`,
      [Date.now() - days * 24 * 60 * 60 * 1000],
    );
    return (result.rows ?? []) as Array<{ date: string; avg_kml: number }>;
  }
}

import { TelemetryDB } from '../db/TelemetryDB';
import { useOBDStore } from './OBDStore';
import type { OBDState } from './OBDManager';

const SAMPLE_INTERVAL_MS = 2_000;

function tripId(): string {
  return Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
}

function engineZone(engineLoadPct: number | null, rpm: number | null): 'eco' | 'moderate' | 'push' {
  const throttle = engineLoadPct !== null ? engineLoadPct / 100 : (rpm !== null ? rpm / 6000 : 0);
  if (throttle <= 0.4) return 'eco';
  if (throttle <= 0.7) return 'moderate';
  return 'push';
}

/**
 * Listens to OBDStore and writes every real OBD session to TelemetryDB.
 *
 * Trip lifecycle:
 *   state → 'ready'                         : open new trip
 *   state → 'reconnecting'                  : keep trip open, pause sampling
 *   state → 'idle' | 'error' (was active)   : close trip with stats
 *
 * Sampling interval: 2 s. At 1 h of driving that's 1,800 obd_readings rows —
 * small enough that SQLite handles it without any retention policy needed.
 */
export class TripLogger {
  private static instance: TripLogger | null = null;

  private unsubscribe: (() => void) | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private activeTripId: string | null = null;
  private lastKnownState: OBDState = 'idle';

  // Accumulators reset on each trip start.
  private distanceKm = 0;
  private fuelUsedL = 0;
  private ecoSecs = 0;
  private moderateSecs = 0;
  private pushSecs = 0;

  static getInstance(): TripLogger {
    if (!TripLogger.instance) TripLogger.instance = new TripLogger();
    return TripLogger.instance;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = useOBDStore.subscribe((store) => {
      const next = store.state;
      if (next !== this.lastKnownState) {
        const prev = this.lastKnownState;
        this.lastKnownState = next;
        this.onStateChange(next, prev);
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.activeTripId) {
      this.stopSampling();
      this.finishTrip().catch(() => {});
    }
  }

  private onStateChange(next: OBDState, prev: OBDState): void {
    this.lastKnownState = next;

    if (next === 'ready' && prev !== 'ready' && prev !== 'reconnecting') {
      this.beginTrip();
    } else if (next === 'ready' && prev === 'reconnecting') {
      // Reconnected — resume sampling on the existing trip.
      if (this.activeTripId && !this.sampleTimer) this.startSampling();
    } else if (next === 'reconnecting' && this.activeTripId) {
      // Temporarily lost connection — pause sampling but keep the trip open.
      this.stopSampling();
    } else if ((next === 'idle' || next === 'error') && this.activeTripId) {
      this.stopSampling();
      this.finishTrip().catch(() => {});
    }
  }

  private beginTrip(): void {
    this.activeTripId = tripId();
    this.distanceKm = 0;
    this.fuelUsedL = 0;
    this.ecoSecs = 0;
    this.moderateSecs = 0;
    this.pushSecs = 0;

    TelemetryDB.getInstance()
      .createTrip(this.activeTripId, Date.now(), false)
      .then(() => this.startSampling())
      .catch(() => {});
  }

  private startSampling(): void {
    if (this.sampleTimer) return;
    this.sampleTimer = setInterval(() => this.takeSample(), SAMPLE_INTERVAL_MS);
  }

  private stopSampling(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
  }

  private takeSample(): void {
    if (!this.activeTripId) return;
    const store = useOBDStore.getState();
    const dtHours = SAMPLE_INTERVAL_MS / 3_600_000;

    this.distanceKm += (store.speedKmH ?? 0) * dtHours;
    this.fuelUsedL  += (store.fuelRateLPerH ?? 0) * dtHours;

    const zone = engineZone(store.engineLoadPct, store.rpm);
    const dtSecs = SAMPLE_INTERVAL_MS / 1_000;
    if (zone === 'eco')      this.ecoSecs      += dtSecs;
    else if (zone === 'moderate') this.moderateSecs += dtSecs;
    else                         this.pushSecs     += dtSecs;

    TelemetryDB.getInstance().insertReading(this.activeTripId, store).catch(() => {});
  }

  private async finishTrip(): Promise<void> {
    const id = this.activeTripId;
    if (!id) return;
    this.activeTripId = null;

    const avgKmL = this.fuelUsedL > 0.001 ? this.distanceKm / this.fuelUsedL : null;

    await TelemetryDB.getInstance().closeTrip(id, {
      endedAt:      Date.now(),
      distanceKm:   this.distanceKm,
      fuelUsedL:    this.fuelUsedL,
      avgKmL,
      ecoSecs:      this.ecoSecs,
      moderateSecs: this.moderateSecs,
      pushSecs:     this.pushSecs,
    });
  }
}

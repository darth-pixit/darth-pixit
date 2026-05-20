import { OBDData } from '../obd/OBDManager';

export interface Trip {
  id: string;
  startTime: number;
  endTime: number;
  durationSec: number;
  maxSpeedKmH: number;
  avgSpeedKmH: number;
  distanceKm: number;
  totalFuelL: number;
  ecoTimePct: number;
  modTimePct: number;
  pushTimePct: number;
}

// Must stay above MOTION_SPEED for MOTION_HOLD_MS before a trip starts
const MOTION_SPEED = 5;       // km/h
const MOTION_HOLD_MS = 8_000; // 8 s

// Must stay below STOP_SPEED for STOP_HOLD_MS before a trip ends
const STOP_SPEED = 2;          // km/h
const STOP_HOLD_MS = 90_000;   // 90 s

interface Sample {
  ts: number;
  speed: number;
  fuelRateLPerH: number | null;
  engineLoadPct: number | null;
}

type Phase = 'idle' | 'arming' | 'running' | 'draining';

export class TripDetector {
  private static _inst: TripDetector;
  static getInstance(): TripDetector {
    if (!TripDetector._inst) TripDetector._inst = new TripDetector();
    return TripDetector._inst;
  }

  private phase: Phase = 'idle';
  private phaseAt = 0;
  private tripStart = 0;
  private samples: Sample[] = [];
  private onEnded: ((t: Trip) => void) | null = null;
  private onActive: ((active: boolean, start: number) => void) | null = null;

  setTripEndedHandler(fn: (t: Trip) => void): void { this.onEnded = fn; }
  setActiveHandler(fn: (active: boolean, start: number) => void): void { this.onActive = fn; }

  get active(): boolean {
    return this.phase === 'running' || this.phase === 'draining';
  }
  get tripStartTime(): number { return this.tripStart; }

  feed(data: OBDData): void {
    if (data.state !== 'ready') {
      // Transient states (scanning, connecting, reconnecting) are BLE hiccups —
      // don't throw away a live trip over a momentary adapter blip.
      // Only terminate on idle (user stopped) or error (unrecoverable).
      if (data.state === 'idle' || data.state === 'error') {
        if (this.active) this.finish();
        else this.phase = 'idle';
      }
      return;
    }

    const now = Date.now();
    const spd = data.speedKmH ?? 0;

    switch (this.phase) {
      case 'idle':
        if (spd >= MOTION_SPEED) { this.phase = 'arming'; this.phaseAt = now; }
        break;

      case 'arming':
        if (spd < MOTION_SPEED) {
          this.phase = 'idle';
        } else if (now - this.phaseAt >= MOTION_HOLD_MS) {
          this.tripStart = this.phaseAt;
          this.samples = [];
          this.phase = 'running';
          this.onActive?.(true, this.tripStart);
        }
        break;

      case 'running':
        this.samples.push({ ts: now, speed: spd, fuelRateLPerH: data.fuelRateLPerH, engineLoadPct: data.engineLoadPct });
        if (spd <= STOP_SPEED) { this.phase = 'draining'; this.phaseAt = now; }
        break;

      case 'draining':
        this.samples.push({ ts: now, speed: spd, fuelRateLPerH: data.fuelRateLPerH, engineLoadPct: data.engineLoadPct });
        if (spd > STOP_SPEED) {
          this.phase = 'running';
        } else if (now - this.phaseAt >= STOP_HOLD_MS) {
          this.finish();
        }
        break;
    }
  }

  private finish(): void {
    const trip = this.build();
    this.phase = 'idle';
    this.samples = [];
    this.onActive?.(false, 0);
    if (trip) this.onEnded?.(trip);
  }

  private build(): Trip | null {
    const s = this.samples;
    if (s.length < 5) return null;

    const endTime = s[s.length - 1].ts;
    let maxSpeed = 0, totalSpeed = 0, distKm = 0, fuelL = 0;
    let ecoTicks = 0, modTicks = 0, pushTicks = 0;

    for (let i = 0; i < s.length; i++) {
      const dtSec = i === 0 ? 0 : (s[i].ts - s[i - 1].ts) / 1000;
      const { speed, fuelRateLPerH, engineLoadPct } = s[i];

      maxSpeed = Math.max(maxSpeed, speed);
      totalSpeed += speed;
      distKm += speed * (dtSec / 3600);

      if (fuelRateLPerH !== null) fuelL += fuelRateLPerH * (dtSec / 3600);

      const load = (engineLoadPct ?? 0) / 100;
      if (load <= 0.40) ecoTicks++;
      else if (load <= 0.70) modTicks++;
      else pushTicks++;
    }

    const total = ecoTicks + modTicks + pushTicks;
    // Round each bucket independently, then fix the remainder on the largest bucket
    // so the three values always sum to exactly 100%.
    let ecoPct = 0, modPct = 0, pushPct = 0;
    if (total) {
      ecoPct  = Math.round((ecoTicks  / total) * 100);
      modPct  = Math.round((modTicks  / total) * 100);
      pushPct = 100 - ecoPct - modPct;
    }
    return {
      id: String(this.tripStart),
      startTime: this.tripStart,
      endTime,
      durationSec: (endTime - this.tripStart) / 1000,
      maxSpeedKmH: Math.round(maxSpeed),
      avgSpeedKmH: Math.round(totalSpeed / s.length),
      distanceKm: Math.round(distKm * 10) / 10,
      totalFuelL: Math.round(fuelL * 100) / 100,
      ecoTimePct: ecoPct,
      modTimePct: modPct,
      pushTimePct: pushPct,
    };
  }
}

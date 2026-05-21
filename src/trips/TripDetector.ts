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

type Phase = 'idle' | 'arming' | 'running' | 'draining';

interface Acc {
  maxSpeed: number;
  totalSpeed: number;
  distKm: number;
  fuelL: number;
  ecoTicks: number;
  modTicks: number;
  pushTicks: number;
  sampleCount: number;
  lastTs: number;
  endTs: number;
}

function freshAcc(now: number): Acc {
  return { maxSpeed: 0, totalSpeed: 0, distKm: 0, fuelL: 0, ecoTicks: 0, modTicks: 0, pushTicks: 0, sampleCount: 0, lastTs: now, endTs: now };
}

export class TripDetector {
  private static _inst: TripDetector;
  static getInstance(): TripDetector {
    if (!TripDetector._inst) TripDetector._inst = new TripDetector();
    return TripDetector._inst;
  }

  private phase: Phase = 'idle';
  private phaseAt = 0;
  private tripStart = 0;
  private acc: Acc = freshAcc(0);
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
      if (this.active) this.finish();
      else this.phase = 'idle';
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
          this.acc = freshAcc(now);
          this.phase = 'running';
          this.onActive?.(true, this.tripStart);
        }
        break;

      case 'running':
        this.updateAcc(spd, data.fuelRateLPerH, data.engineLoadPct, now);
        if (spd <= STOP_SPEED) { this.phase = 'draining'; this.phaseAt = now; }
        break;

      case 'draining':
        this.updateAcc(spd, data.fuelRateLPerH, data.engineLoadPct, now);
        if (spd > STOP_SPEED) {
          this.phase = 'running';
        } else if (now - this.phaseAt >= STOP_HOLD_MS) {
          this.finish();
        }
        break;
    }
  }

  private updateAcc(speed: number, fuelRateLPerH: number | null, engineLoadPct: number | null, now: number): void {
    const a = this.acc;
    const dtSec = a.sampleCount === 0 ? 0 : (now - a.lastTs) / 1000;

    a.maxSpeed = Math.max(a.maxSpeed, speed);
    a.totalSpeed += speed;
    a.distKm += speed * (dtSec / 3600);
    if (fuelRateLPerH !== null) a.fuelL += fuelRateLPerH * (dtSec / 3600);

    const load = (engineLoadPct ?? 0) / 100;
    if (load <= 0.40) a.ecoTicks++;
    else if (load <= 0.70) a.modTicks++;
    else a.pushTicks++;

    a.sampleCount++;
    a.lastTs = now;
    a.endTs = now;
  }

  private finish(): void {
    const trip = this.build();
    this.phase = 'idle';
    this.acc = freshAcc(0);
    this.onActive?.(false, 0);
    if (trip) this.onEnded?.(trip);
  }

  private build(): Trip | null {
    const a = this.acc;
    if (a.sampleCount < 5) return null;

    const total = a.ecoTicks + a.modTicks + a.pushTicks;
    return {
      id: String(this.tripStart),
      startTime: this.tripStart,
      endTime: a.endTs,
      durationSec: (a.endTs - this.tripStart) / 1000,
      maxSpeedKmH: Math.round(a.maxSpeed),
      avgSpeedKmH: Math.round(a.totalSpeed / a.sampleCount),
      distanceKm: Math.round(a.distKm * 10) / 10,
      totalFuelL: Math.round(a.fuelL * 100) / 100,
      ecoTimePct: total ? Math.round((a.ecoTicks / total) * 100) : 0,
      modTimePct: total ? Math.round((a.modTicks / total) * 100) : 0,
      pushTimePct: total ? Math.round((a.pushTicks / total) * 100) : 0,
    };
  }
}

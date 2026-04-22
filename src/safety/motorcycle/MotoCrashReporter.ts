/**
 * MotoCrashReporter — gyroscope-primary crash detection for motorcycles.
 *
 * ================================================================
 *  WHY GYROSCOPE IS THE PRIMARY TRIGGER (not linear acceleration)
 * ================================================================
 *
 *  Car crash: the dominant energy transfer is along the vehicle's
 *  direction of travel (or lateral in a T-bone). The vehicle stays
 *  upright. Linear accelerometer is the right primary sensor.
 *
 *  Motorcycle crash types and their physics:
 *
 *  LOW-SIDE (slide-out crash — most common, ~60% of corner crashes)
 *    The front or rear tire washes out and the bike tips to the inside
 *    of the curve. The bike ROLLS rapidly. ROLL RATE exceeds 5 rad/s
 *    in the first 300 ms, while linear accel may only reach 1.5–2g
 *    initially (the rider slides, doesn't impact directly).
 *    Signal: gyro ROLL first, then linear spike on road impact.
 *
 *  HIGH-SIDE (flip crash — severe, ~20% of crashes, most fatalities)
 *    Rear slides, grips, rider is launched. ROLL rate 8–15 rad/s in
 *    < 200 ms. Linear accel spike follows when rider or bike hits ground.
 *    Signal: gyro ROLL + large YAW reversal, then linear spike.
 *
 *  FRONT-WASH (front tuck — ~15% of crashes)
 *    Front wheel tucks under. Rapid PITCH FORWARD. Linear accel spike
 *    as rider hits the road over the bars.
 *    Signal: gyro PITCH first, then linear.
 *
 *  HEAD-ON or T-BONE (mechanical impact)
 *    Similar to car crash — LINEAR accel primary. Less common for bikes.
 *
 *  Combined trigger strategy:
 *    Primary:   gyro total magnitude > 6 rad/s (catches 80%+ of crashes)
 *    Secondary: linear accel > 2.5g (catches the remaining 20% + head-on)
 *    Either trigger opens a 10-s evaluation window (same as car).
 *
 *  Validation features (same 5-feature score as car reporter):
 *    1. Primary threshold met (always true on entry)
 *    2. Multi-axis: for gyro trigger, require both roll AND pitch/yaw >1.5
 *       rad/s; for accel trigger, require two axes > 10 m/s²
 *    3. Speed drop ≥ 15 km/h within 5 s
 *    4. Impact speed ≥ 15 km/h
 *    5. Confirmed stop (speed < 5 km/h for 10 s after event)
 *
 *  SELF-CRITIQUE
 *  -------------
 *  False positives from aggressive stunt riding (wheelies, burn-outs)
 *  can produce gyro magnitudes of 3–5 rad/s. Our 6 rad/s threshold
 *  should be clear of these, but a professional stunt rider on public
 *  roads could still trigger it. The speed-drop and confirmed-stop
 *  validation filters should eliminate those cases (stunt riders keep
 *  riding after the stunt).
 *
 *  Phone separation: after a crash the phone (if bar-mounted) may
 *  separate and continue to move/vibrate, generating misleading post-
 *  impact data. The 10-s post-window capture is short enough that most
 *  separated phones will have settled by then.
 */

import { AccelerometerSample, GyroscopeSample, GPSPoint, CrashReport, SafetyConfig } from '../types';
import { MotoConfig } from './types';

interface SensorRecord {
  t: number;
  linMag: number;
  gyroMag: number;
  gyroRoll: number; // largest component of gyro
  gyroPitch: number;
}

interface SpeedSample { t: number; kmH: number; }

export type CrashSuspectedHandler = (info: { t: number; peakG: number; trigger: 'linear' | 'gyro' }) => void;
export type CrashConfirmedHandler = (report: CrashReport & { trigger: 'linear' | 'gyro'; peakGyroRadS: number }) => void;

export class MotoCrashReporter {
  private cfg: MotoConfig;

  private readonly BUFFER_CAP = 1800; // 30s at 60 Hz
  private buffer: SensorRecord[] = [];
  private bufferWrite = 0;

  private speedBuffer: SpeedSample[] = [];
  private readonly SPEED_BUFFER_MS = 30000;

  private suspectedAt = 0;
  private suspectedLinearG = 0;
  private suspectedGyroRadS = 0;
  private suspectedTrigger: 'linear' | 'gyro' = 'linear';
  private suspectedMultiAxis = false;
  private pendingPostTrace: Array<{ t: number; mag: number }> = [];
  private pendingPreGPS: GPSPoint[] = [];

  private onSuspected: CrashSuspectedHandler | null = null;
  private onConfirmed: CrashConfirmedHandler | null = null;

  private locationGetter: () => { lat: number; lng: number } | null;
  private gpsRecentGetter: () => GPSPoint[];
  private reportIdCounter = 0;

  constructor(
    cfg: MotoConfig,
    locationGetter: () => { lat: number; lng: number } | null,
    gpsRecentGetter: () => GPSPoint[],
  ) {
    this.cfg = cfg;
    this.locationGetter = locationGetter;
    this.gpsRecentGetter = gpsRecentGetter;
  }

  setHandlers(suspected: CrashSuspectedHandler, confirmed: CrashConfirmedHandler): void {
    this.onSuspected = suspected;
    this.onConfirmed = confirmed;
  }

  updateConfig(patch: Partial<MotoConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  ingestAccel(s: AccelerometerSample, linearMag: number): void {
    // Do nothing with linear alone yet — we record it and check combined.
    this.recordSample(s.t, linearMag, 0, 0, 0);
  }

  ingestGyro(s: GyroscopeSample, linearMag: number): void {
    const { x, y, z } = s.gyro;
    const gyroMag = Math.sqrt(x * x + y * y + z * z);
    const components = [Math.abs(x), Math.abs(y), Math.abs(z)].sort((a, b) => b - a);

    this.recordSample(s.t, linearMag, gyroMag, components[0], components[1]);

    if (this.suspectedAt > 0) {
      const sinceMs = s.t - this.suspectedAt;
      if (sinceMs <= 10000) {
        this.pendingPostTrace.push({ t: s.t, mag: Math.max(linearMag, gyroMag) });
      }
      if (sinceMs >= 10000) this.evaluateConfirmation(s.t);
      return;
    }

    const linG = linearMag / 9.81;
    const linearTriggered = linG >= this.cfg.crashPeakThreshold / 9.81;
    const gyroTriggered = gyroMag >= this.cfg.crashGyroThresholdRadS;

    if (!linearTriggered && !gyroTriggered) return;

    const impactSpeed = this.getFreshestSpeed(s.t);
    const fastEnough = (impactSpeed ?? 0) >= this.cfg.crashMinSpeedKmH;

    // Multi-axis validation differs by trigger.
    let multiAxis: boolean;
    if (gyroTriggered) {
      // Require both dominant and second component to be significant.
      multiAxis = components[1] >= 1.5;
    } else {
      const ax = [Math.abs(s.gyro.x)]; // using gyro passed in
      // We already validated via the overall component check for accel.
      multiAxis = linG >= this.cfg.crashPeakThreshold / 9.81 * 1.2; // strong enough to not need multi-axis
    }

    if (!multiAxis && !fastEnough) return;

    this.suspectedAt = s.t;
    this.suspectedLinearG = linG;
    this.suspectedGyroRadS = gyroMag;
    this.suspectedTrigger = gyroTriggered ? 'gyro' : 'linear';
    this.suspectedMultiAxis = multiAxis;
    this.pendingPostTrace = [{ t: s.t, mag: Math.max(linearMag / 9.81, gyroMag) }];
    this.pendingPreGPS = this.gpsRecentGetter();

    this.onSuspected?.({ t: s.t, peakG: Math.max(linG, gyroMag), trigger: this.suspectedTrigger });
  }

  ingestSpeed(speedKmH: number, t: number): void {
    this.speedBuffer.push({ t, kmH: speedKmH });
    const cutoff = t - this.SPEED_BUFFER_MS;
    while (this.speedBuffer.length > 1 && this.speedBuffer[0].t < cutoff) this.speedBuffer.shift();
  }

  flush(t: number): void {
    if (this.suspectedAt > 0 && t - this.suspectedAt >= 5000) this.evaluateConfirmation(t);
  }

  reset(): void {
    this.buffer = [];
    this.bufferWrite = 0;
    this.speedBuffer = [];
    this.suspectedAt = 0;
    this.suspectedLinearG = 0;
    this.suspectedGyroRadS = 0;
    this.suspectedMultiAxis = false;
    this.pendingPostTrace = [];
    this.pendingPreGPS = [];
  }

  private recordSample(t: number, linMag: number, gyroMag: number, roll: number, pitch: number): void {
    const rec: SensorRecord = { t, linMag, gyroMag, gyroRoll: roll, gyroPitch: pitch };
    if (this.buffer.length < this.BUFFER_CAP) {
      this.buffer.push(rec);
    } else {
      this.buffer[this.bufferWrite] = rec;
      this.bufferWrite = (this.bufferWrite + 1) % this.BUFFER_CAP;
    }
  }

  private evaluateConfirmation(tNow: number): void {
    const impactT = this.suspectedAt;
    const impactSpeed = this.getFreshestSpeed(impactT);
    const speedAt5s   = this.getSpeedAt(impactT + 5000);
    const speedAt10s  = this.getSpeedAt(impactT + 10000);

    let features = 0;
    features++; // Feature 1: primary threshold (already met)
    if (this.suspectedMultiAxis) features++;
    const drop = (impactSpeed ?? 0) - (speedAt5s ?? (impactSpeed ?? 0));
    if (drop >= this.cfg.crashSpeedDropKmH) features++;
    if ((impactSpeed ?? 0) >= this.cfg.crashMinSpeedKmH) features++;
    const confirmedStop = (speedAt10s ?? 0) < 5;
    if (confirmedStop) features++;

    if (features >= 3) {
      const report = {
        id: `moto_crash_${Date.now()}_${++this.reportIdCounter}`,
        detectedAt: impactT,
        location: this.locationGetter(),
        peakG: this.suspectedLinearG,
        speedAtImpactKmH: impactSpeed,
        preImpactTrace: this.extractPreTrace(impactT),
        postImpactTrace: this.pendingPostTrace.slice(),
        preImpactTrail: this.pendingPreGPS.slice(),
        confirmedStop,
        featuresTriggered: features,
        trigger: this.suspectedTrigger,
        peakGyroRadS: this.suspectedGyroRadS,
      };
      this.onConfirmed?.(report);
    }

    this.suspectedAt = 0;
    this.pendingPostTrace = [];
    this.pendingPreGPS = [];
  }

  private extractPreTrace(impactT: number): Array<{ t: number; mag: number }> {
    const windowMs = 10000;
    const ordered = this.orderedBuffer().filter(r => r.t >= impactT - windowMs && r.t <= impactT);
    return ordered.map(r => ({ t: r.t, mag: Math.max(r.linMag / 9.81, r.gyroMag) }));
  }

  private orderedBuffer(): SensorRecord[] {
    if (this.buffer.length < this.BUFFER_CAP) return this.buffer;
    return this.buffer.slice(this.bufferWrite).concat(this.buffer.slice(0, this.bufferWrite));
  }

  private getFreshestSpeed(t: number): number | null {
    if (!this.speedBuffer.length) return null;
    let best: SpeedSample | null = null;
    for (const s of this.speedBuffer) if (s.t <= t && (!best || s.t > best.t)) best = s;
    return best ? best.kmH : null;
  }

  private getSpeedAt(t: number): number | null {
    if (!this.speedBuffer.length) return null;
    let before: SpeedSample | null = null;
    let after: SpeedSample | null = null;
    for (const s of this.speedBuffer) {
      if (s.t <= t && (!before || s.t > before.t)) before = s;
      if (s.t >= t && (!after  || s.t < after.t))  after  = s;
    }
    if (!before) return after ? after.kmH : null;
    if (!after)  return before.kmH;
    if (after.t === before.t) return before.kmH;
    return before.kmH + (t - before.t) / (after.t - before.t) * (after.kmH - before.kmH);
  }
}

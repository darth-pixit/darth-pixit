/**
 * CrashReporter — multi-feature crash detection with pre/post-impact
 * sensor buffering.
 *
 * =============================================================
 *  Why a multi-feature score instead of "|a| > 2.5g"?
 * =============================================================
 *
 *   A single g-force threshold produces 10–30% false positives from:
 *     - potholes and speed bumps (spike, but vehicle keeps moving)
 *     - the phone falling off the mount (single-axis, car fine)
 *     - hand-manipulated phone (low speed, brief)
 *
 *   A true crash has a cluster of co-occurring features:
 *     1. Peak |linear accel| > 2.5g
 *     2. Multi-axis energy — a crash hits at least 2 of 3 axes hard
 *     3. Large speed drop within ~5 s (ΔV > 15 km/h)
 *     4. Speed was non-trivial at impact (>15 km/h) — below that the
 *        energy is too low for an injury-causing crash and the spike
 *        is almost always a phone drop
 *     5. Confirmed stop — the car doesn't resume driving in the next
 *        10 s (could be stunned driver, crumpled vehicle, or airbag)
 *
 *   We count how many of those fire and only call it a crash if ≥3.
 *
 *   Features 1+2 can fire immediately; feature 3 needs 5 s of speed
 *   data after impact; feature 5 needs 10 s. So the detector returns
 *   "suspected" immediately (for UI alerting / start-of-capture) and
 *   "confirmed" after the follow-up window.
 *
 * =============================================================
 *  Buffer design
 * =============================================================
 *
 *   Ring buffer at full sensor rate (60 Hz * 30 s = 1800 samples).
 *   We store compact { t, mag, dominantAxis } records, ~24 bytes each
 *   = ~43 KB in memory. A single crash report is downsampled to ~20 Hz
 *   for storage/transmission (~200 pre + 200 post ≈ 10 KB).
 */

import { AccelerometerSample, CrashReport, GPSPoint, SafetyConfig } from './types';

interface SensorRecord {
  t: number;
  mag: number;
  max: number; // max of |x|, |y|, |z| — used for multi-axis discrimination
  mid: number; // second-largest of the three — if this is also big → multi-axis
}

export type CrashSuspectedHandler = (info: { t: number; peakG: number }) => void;
export type CrashConfirmedHandler = (report: CrashReport) => void;

interface SpeedSample {
  t: number;
  kmH: number;
}

export class CrashReporter {
  private cfg: SafetyConfig;

  /** 30 s at 60 Hz. */
  private readonly BUFFER_CAP = 1800;
  private buffer: SensorRecord[] = [];
  private bufferWrite = 0;

  private speedBuffer: SpeedSample[] = [];
  private readonly SPEED_BUFFER_MS = 30000;

  /**
   * If a high-g spike has fired recently and we're within the 10s
   * post-window, we're in "evaluating" mode — no re-fire; waiting for
   * confirmation.
   */
  private suspectedAt = 0;
  private suspectedPeakG = 0;
  private suspectedDominantMultiAxis = false;
  /** Captured trail + post-impact trace while confirming. */
  private pendingPostTrace: Array<{ t: number; mag: number }> = [];
  private pendingPreImpactGPS: GPSPoint[] = [];

  private onSuspected: CrashSuspectedHandler | null = null;
  private onConfirmed: CrashConfirmedHandler | null = null;

  private locationGetter: () => { lat: number; lng: number } | null;
  private gpsRecentGetter: () => GPSPoint[];

  private reportIdCounter = 0;

  constructor(
    cfg: SafetyConfig,
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

  updateConfig(patch: Partial<SafetyConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /** Feed every accelerometer sample. Gravity should already be removed. */
  ingestAccel(s: AccelerometerSample, linearMag: number): void {
    const ax = Math.abs(s.accel.x);
    const ay = Math.abs(s.accel.y);
    const az = Math.abs(s.accel.z);
    const sorted = [ax, ay, az].sort((a, b) => b - a);
    const rec: SensorRecord = {
      t: s.t,
      mag: linearMag,
      max: sorted[0],
      mid: sorted[1],
    };

    // Ring buffer push.
    if (this.buffer.length < this.BUFFER_CAP) {
      this.buffer.push(rec);
    } else {
      this.buffer[this.bufferWrite] = rec;
      this.bufferWrite = (this.bufferWrite + 1) % this.BUFFER_CAP;
    }

    // If suspected, keep capturing the 10 s post-trace.
    if (this.suspectedAt > 0) {
      const sinceMs = s.t - this.suspectedAt;
      if (sinceMs <= 10000) {
        this.pendingPostTrace.push({ t: s.t, mag: linearMag });
      }
      // Evaluate confirmation once the window expires.
      if (sinceMs >= 10000) {
        this.evaluateConfirmation(s.t);
      }
      return;
    }

    // Primary trigger: |linearMag| > crashPeakThreshold
    if (linearMag >= this.cfg.crashPeakThreshold) {
      // Immediate features: multi-axis, impact speed.
      const multiAxis = rec.mid >= 10; // second-largest axis still >1g → multi-axis energy
      const impactSpeedKmH = this.getFreshestSpeed(s.t);
      const impactFastEnough = (impactSpeedKmH ?? 0) >= this.cfg.crashMinSpeedKmH;

      // We require at least one of multiAxis or impactFastEnough to
      // even *suspect* — this filters most phone drops on the spot.
      if (!multiAxis && !impactFastEnough) return;

      this.suspectedAt = s.t;
      this.suspectedPeakG = linearMag;
      this.suspectedDominantMultiAxis = multiAxis;
      this.pendingPostTrace = [{ t: s.t, mag: linearMag }];
      this.pendingPreImpactGPS = this.gpsRecentGetter();

      this.onSuspected?.({ t: s.t, peakG: linearMag });
    }
  }

  /** Feed every speed update (km/h, from OBD or GPS). */
  ingestSpeed(speedKmH: number, t: number): void {
    this.speedBuffer.push({ t, kmH: speedKmH });
    const cutoff = t - this.SPEED_BUFFER_MS;
    while (this.speedBuffer.length > 1 && this.speedBuffer[0].t < cutoff) {
      this.speedBuffer.shift();
    }
  }

  /** Force evaluation — e.g., on trip end. */
  flush(t: number): void {
    if (this.suspectedAt > 0 && t - this.suspectedAt >= 5000) {
      this.evaluateConfirmation(t);
    }
  }

  reset(): void {
    this.buffer = [];
    this.bufferWrite = 0;
    this.speedBuffer = [];
    this.suspectedAt = 0;
    this.suspectedPeakG = 0;
    this.suspectedDominantMultiAxis = false;
    this.pendingPostTrace = [];
    this.pendingPreImpactGPS = [];
  }

  // ---------- internals ----------

  private evaluateConfirmation(tNow: number): void {
    const impactT = this.suspectedAt;
    const peakG = this.suspectedPeakG;

    const impactSpeed = this.getFreshestSpeed(impactT);
    const speedAt5s = this.getSpeedAt(impactT + 5000);
    const speedAt10s = this.getSpeedAt(impactT + 10000);

    let features = 0;
    // Feature 1: peak threshold (already known to be true to enter here).
    features++;
    // Feature 2: multi-axis energy.
    if (this.suspectedDominantMultiAxis) features++;
    // Feature 3: speed drop.
    const speedDrop = (impactSpeed ?? 0) - (speedAt5s ?? (impactSpeed ?? 0));
    if (speedDrop >= this.cfg.crashSpeedDropKmH) features++;
    // Feature 4: impact speed non-trivial.
    if ((impactSpeed ?? 0) >= this.cfg.crashMinSpeedKmH) features++;
    // Feature 5: confirmed stop (speed at +10s < 5 km/h).
    const confirmedStop = (speedAt10s ?? 0) < 5;
    if (confirmedStop) features++;

    const confirmed = features >= 3;
    if (confirmed) {
      const report: CrashReport = {
        id: `crash_${Date.now()}_${++this.reportIdCounter}`,
        detectedAt: impactT,
        location: this.locationGetter(),
        peakG,
        speedAtImpactKmH: impactSpeed,
        preImpactTrace: this.extractPreTrace(impactT),
        postImpactTrace: this.pendingPostTrace.slice(),
        preImpactTrail: this.pendingPreImpactGPS.slice(),
        confirmedStop,
        featuresTriggered: features,
      };
      this.onConfirmed?.(report);
    }

    this.suspectedAt = 0;
    this.suspectedPeakG = 0;
    this.suspectedDominantMultiAxis = false;
    this.pendingPostTrace = [];
    this.pendingPreImpactGPS = [];
  }

  /**
   * Pull the last ~10 s from the ring buffer, downsampled to ~20 Hz for
   * storage compactness.
   */
  private extractPreTrace(impactT: number): Array<{ t: number; mag: number }> {
    const windowMs = 10000;
    const targetSamples = 200;
    const all = this.orderedBuffer().filter(r => r.t >= impactT - windowMs && r.t <= impactT);
    if (all.length <= targetSamples) return all.map(r => ({ t: r.t, mag: r.mag }));
    const stride = Math.floor(all.length / targetSamples);
    const out: Array<{ t: number; mag: number }> = [];
    for (let i = 0; i < all.length; i += stride) out.push({ t: all[i].t, mag: all[i].mag });
    return out;
  }

  private orderedBuffer(): SensorRecord[] {
    if (this.buffer.length < this.BUFFER_CAP) return this.buffer;
    return this.buffer.slice(this.bufferWrite).concat(this.buffer.slice(0, this.bufferWrite));
  }

  private getFreshestSpeed(t: number): number | null {
    if (this.speedBuffer.length === 0) return null;
    // Find the sample closest to t that is <= t.
    let best: SpeedSample | null = null;
    for (const s of this.speedBuffer) {
      if (s.t <= t && (!best || s.t > best.t)) best = s;
    }
    return best ? best.kmH : null;
  }

  private getSpeedAt(t: number): number | null {
    if (this.speedBuffer.length === 0) return null;
    let before: SpeedSample | null = null;
    let after: SpeedSample | null = null;
    for (const s of this.speedBuffer) {
      if (s.t <= t && (!before || s.t > before.t)) before = s;
      if (s.t >= t && (!after || s.t < after.t)) after = s;
    }
    if (!before) return after ? after.kmH : null;
    if (!after) return before.kmH;
    if (after.t === before.t) return before.kmH;
    const frac = (t - before.t) / (after.t - before.t);
    return before.kmH + frac * (after.kmH - before.kmH);
  }
}

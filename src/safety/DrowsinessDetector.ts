/**
 * DrowsinessDetector — detects driver fatigue through micro-steering
 * oscillation patterns in the gyroscope signal.
 *
 * =============================================================
 *  The physics of drowsy steering
 * =============================================================
 *
 *  A fully alert driver makes smooth, intentional steering corrections.
 *  A drowsy driver makes small, involuntary micro-corrections at
 *  irregular intervals — the car drifts, the semi-conscious driver
 *  snaps it back. This produces a characteristic pattern in the
 *  steering (and therefore the yaw-rate gyroscope signal):
 *
 *    - Variance of yaw-rate is LOW for attentive highway cruising
 *      (speed is stable, lane is maintained, corrections are rare)
 *    - Variance RISES as drowsiness sets in (micro-corrections)
 *    - The frequency is 0.05–0.3 Hz (one correction every 3–20 s)
 *
 *  We use the simpler variance-ratio approach rather than FFT because:
 *    - Variance is O(n) to compute on a rolling window
 *    - The ratio (current / baseline) normalises for phone orientation
 *      and mount (someone who mounts the phone sideways will have a
 *      different absolute variance, but the ratio still rises with
 *      drowsiness)
 *    - FFT would require a 60 Hz gyroscope, which some devices don't
 *      provide precisely; variance is robust to irregular sampling
 *
 * =============================================================
 *  Calibration
 * =============================================================
 *
 *  We need a "normal" baseline before we can detect deviations.
 *  Calibration window: first 5 minutes of highway driving (speed
 *  > drowsyMinSpeedKmH). If the driver starts drowsy (unlikely but
 *  possible), the baseline is too high — we will not detect further
 *  degradation from a bad baseline.
 *
 *  CRITIQUE: the 5-minute calibration window is a trade-off:
 *    - Too short: variance is noisy, bad baseline
 *    - Too long: driver might be drowsy before detection kicks in
 *  5 minutes at highway speed is a reasonable minimum. The threshold
 *  of 2× is conservative; published research (Johns & Horne 2000)
 *  suggests drowsy-vs-alert lane-keeping variance can be 3–5×, so
 *  2× gives early warning with some margin for alert-driver variance.
 *
 * =============================================================
 *  Why total angular velocity magnitude, not pure yaw?
 * =============================================================
 *
 *  Phone mount orientation is unknown. If the phone is laid flat on the
 *  seat, Z = yaw. Mounted portrait on the windshield, X might be yaw.
 *  Using magnitude avoids any coordinate transform, at the cost of
 *  including pitch (braking/acceleration) and roll noise. On a straight
 *  highway above 80 km/h, pitch and roll variance are low and constant
 *  over time, so the ratio baseline cancels them out.
 */

import { GyroscopeSample, DrowsinessSignal, SafetyConfig, DEFAULT_SAFETY_CONFIG } from './types';

export type DrowsinessListener = (signal: DrowsinessSignal) => void;

interface WindowSample {
  t: number;
  mag: number;
}

export class DrowsinessDetector {
  private cfg: SafetyConfig;
  private listener: DrowsinessListener | null = null;

  /** Calibration: collect samples during NORMAL early-trip driving. */
  private calibrationSamples: number[] = [];
  private calibrationStart = 0;
  private calibrationComplete = false;
  private baselineVariance = 0;

  /** Rolling window for current variance computation (60 s), trimmed by timestamp. */
  private window: WindowSample[] = [];
  private readonly WINDOW_MS = 60_000;

  /** Time of first high-variance observation (for sustained-duration check). */
  private elevatedSince = 0;
  private lastAlertT = 0;
  private readonly MIN_ALERT_INTERVAL_MS = 2 * 60_000; // don't spam every 30s

  private currentSpeedKmH = 0;

  constructor(cfg: SafetyConfig = DEFAULT_SAFETY_CONFIG) {
    this.cfg = cfg;
  }

  setListener(l: DrowsinessListener): void {
    this.listener = l;
  }

  updateConfig(patch: Partial<SafetyConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /** Update current speed from OBD or GPS so we can gate on highway speed. */
  updateSpeed(speedKmH: number): void {
    this.currentSpeedKmH = speedKmH;
  }

  ingest(sample: GyroscopeSample): void {
    const { x, y, z } = sample.gyro;
    const mag = Math.sqrt(x * x + y * y + z * z);
    const atHighSpeed = this.currentSpeedKmH >= this.cfg.drowsyMinSpeedKmH;

    if (!atHighSpeed) return;

    const calibMinMs = this.cfg.drowsyCalibrationMinutes * 60_000;

    // Calibration phase
    if (!this.calibrationComplete) {
      if (this.calibrationStart === 0) this.calibrationStart = sample.t;
      this.calibrationSamples.push(mag);
      if (sample.t - this.calibrationStart >= calibMinMs) {
        this.baselineVariance = sampleVariance(this.calibrationSamples);
        this.calibrationComplete = true;
        // Pre-fill the rolling window with calibration samples so we
        // have a full 60 s of history right after calibration. We don't
        // have per-sample timestamps from calibration, so synthesise them
        // linearly — they'll be evicted naturally once real samples arrive.
        const calibDt = calibMinMs / Math.max(1, this.calibrationSamples.length - 1);
        this.window = this.calibrationSamples.map((m, i) => ({
          t: this.calibrationStart + i * calibDt,
          mag: m,
        }));
      }
      return;
    }

    // Rolling window update: push new sample, then evict anything older
    // than WINDOW_MS using actual timestamps (not a sample-count approximation
    // that breaks when the gyroscope rate differs from 60 Hz).
    this.window.push({ t: sample.t, mag });
    const cutoffT = sample.t - this.WINDOW_MS;
    let firstKeep = 0;
    while (firstKeep < this.window.length - 1 && this.window[firstKeep].t < cutoffT) {
      firstKeep++;
    }
    if (firstKeep > 0) this.window = this.window.slice(firstKeep);

    if (this.window.length < 60) return; // need at least 1 s of data

    const currentVariance = sampleVariance(this.window.map((s) => s.mag));
    if (this.baselineVariance < 1e-6) return; // degenerate baseline
    const ratio = currentVariance / this.baselineVariance;

    if (ratio >= this.cfg.drowsyVarianceRatioThreshold) {
      if (this.elevatedSince === 0) this.elevatedSince = sample.t;
      const elevDurationMs = sample.t - this.elevatedSince;
      if (
        elevDurationMs >= this.cfg.drowsyMinElevatedDurationS * 1000 &&
        sample.t - this.lastAlertT > this.MIN_ALERT_INTERVAL_MS
      ) {
        this.lastAlertT = sample.t;
        this.listener?.({
          detectedAt: sample.t,
          varianceRatio: ratio,
          speedKmH: this.currentSpeedKmH,
          durationMs: elevDurationMs,
        });
      }
    } else {
      this.elevatedSince = 0;
    }
  }

  reset(): void {
    this.calibrationSamples = [];
    this.calibrationStart = 0;
    this.calibrationComplete = false;
    this.baselineVariance = 0;
    this.window = [];
    this.elevatedSince = 0;
    this.lastAlertT = 0;
    this.currentSpeedKmH = 0;
  }

  isCalibrated(): boolean {
    return this.calibrationComplete;
  }
}

function sampleVariance(samples: number[]): number {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const sq = samples.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return sq / (samples.length - 1);
}

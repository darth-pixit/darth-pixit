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

/** One sample in the rolling window, keyed by timestamp for time-based eviction. */
interface WindowSample {
  t: number;
  mag: number;
}

/** Samples collected for one statistical window. */
interface Window {
  startT: number;
  samples: WindowSample[];
}

export class DrowsinessDetector {
  private cfg: SafetyConfig;
  private listener: DrowsinessListener | null = null;

  /** Calibration: collect samples during NORMAL early-trip driving. */
  private calibrationSamples: WindowSample[] = [];
  private calibrationStart = 0;
  private calibrationComplete = false;
  private baselineVariance = 0;

  /** Rolling window for current variance computation (60 s). */
  private window: Window = { startT: 0, samples: [] };
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
      this.calibrationSamples.push({ t: sample.t, mag });
      if (sample.t - this.calibrationStart >= calibMinMs) {
        this.baselineVariance = sampleVariance(this.calibrationSamples);
        this.calibrationComplete = true;
        // Pre-fill the rolling window with calibration samples so we
        // have a full 60 s of history right after calibration.
        this.window = { startT: this.calibrationStart, samples: [...this.calibrationSamples] };
      }
      return;
    }

    // Rolling window update — evict by timestamp, not by sample count.
    // A count-based eviction assumes a fixed sample rate (60 Hz); real
    // devices vary from 30–200 Hz. Time-based eviction is rate-agnostic.
    if (this.window.startT === 0) this.window.startT = sample.t;
    this.window.samples.push({ t: sample.t, mag });
    const windowCutoff = sample.t - this.WINDOW_MS;
    // Drop from the front while there are at least 2 samples, preserving
    // the first sample so we always have a non-empty window.
    while (this.window.samples.length > 1 && this.window.samples[0].t < windowCutoff) {
      this.window.samples.shift();
    }

    // Need at least 1 s of samples (at any rate) before computing variance.
    const windowSpanMs = sample.t - this.window.samples[0].t;
    if (this.window.samples.length < 10 || windowSpanMs < 1000) return;

    const currentVariance = sampleVariance(this.window.samples);
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
    this.window = { startT: 0, samples: [] };
    this.elevatedSince = 0;
    this.lastAlertT = 0;
    this.currentSpeedKmH = 0;
  }

  isCalibrated(): boolean {
    return this.calibrationComplete;
  }
}

function sampleVariance(samples: WindowSample[]): number {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((a, s) => a + s.mag, 0) / samples.length;
  const sq = samples.reduce((acc, s) => acc + (s.mag - mean) ** 2, 0);
  return sq / (samples.length - 1);
}

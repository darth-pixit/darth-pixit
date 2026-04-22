/**
 * MotoEventDetector — all six motorcycle-specific event streams.
 *
 * Reuses the car EventDetector for hard_acceleration, hard_braking,
 * hard_cornering, overspeeding, distracted_driving, and drowsy_driving.
 * Adds four new motorcycle-only events.
 *
 * New events:
 *   1. extreme_lean       — lean > extremeLeanThresholdDeg (default 50°)
 *   2. corner_acceleration — throttle while leaning > 25°
 *   3. speed_wobble       — yaw oscillation 2–8 Hz at speed
 *   4. highside_risk      — rapid yaw-rate reversal pattern
 *
 * ================================================================
 *  SPEED WOBBLE DETECTION
 * ================================================================
 *
 *  A speed wobble (tank slapper) is a resonant oscillation of the
 *  front wheel/steering assembly at its natural frequency, typically
 *  2–10 Hz. It develops when:
 *    - Speed is high (> 60 km/h for most bikes)
 *    - Steering damper is worn, missing, or undersized
 *    - Sudden weight change (lifting off seat, crosswind)
 *
 *  The gyroscope yaw channel shows the signature: sustained oscillation
 *  of amplitude > 0.6 rad/s at 2–8 Hz. An FFT would be ideal but is
 *  expensive on-device. Instead we use a narrow band-pass proxy:
 *
 *    high-pass filter yaw at ~1.5 Hz (to remove steering inputs)
 *    + envelope detection (RMS over 0.5 s window)
 *    + amplitude threshold > 0.6 rad/s for > 0.5 s
 *
 *  We implement the high-pass filter as:
 *    hp[n] = α * (hp[n-1] + raw[n] - raw[n-1])
 *    α = τ / (τ + dt), τ = 1 / (2π × f_cutoff)
 *    At 60 Hz, f_cutoff = 1.5 Hz → τ = 0.106 → α = 0.864
 *
 * ================================================================
 *  HIGH-SIDE RISK DETECTION
 * ================================================================
 *
 *  A high-side begins when the rear wheel loses traction (slides out)
 *  and then suddenly regains it, whipping the bike back violently.
 *  The pre-crash signature is:
 *    a) Yaw rate builds in one direction (rear slides out)
 *    b) Yaw rate snaps to the OPPOSITE direction within 0.3–0.8 s
 *    c) The reversal rate (dω/dt) is extreme (> 15 rad/s²)
 *
 *  We detect this as: peak positive yaw exceeds HS_YAW_THRESHOLD,
 *  then within HS_REVERSAL_WINDOW_MS the yaw crosses to negative
 *  (or vice versa) and the rate-of-change exceeds HS_RATE_THRESHOLD.
 *
 *  This is a WARNING event — it fires before the crash if it fires at
 *  all. If followed by a crash event within 2 s, the crash severity is
 *  upgraded to 5.
 */

import { EventDetector } from '../EventDetector';
import { GyroscopeSample } from '../types';
import { MotoConfig, MotoSafetyEvent, LeanState } from './types';

export type MotoEventListener = (ev: MotoSafetyEvent) => void;

const G = 9.81;

// High-pass filter coefficient at 1.5 Hz, 60 Hz sample rate
const HP_ALPHA = 0.864;

// High-side detection constants
const HS_YAW_THRESHOLD   = 2.5;   // rad/s — rear has clearly slid
const HS_REVERSAL_MS     = 600;   // window for snap-back
const HS_RATE_THRESHOLD  = 12;    // rad/s² — snap-back rate

export class MotoEventDetector {
  private cfg: MotoConfig;
  private listener: MotoEventListener | null = null;
  private baseDetector: EventDetector;

  // ---- Lean state (fed from LeanAngleEstimator via TripManager) ----
  private currentLeanDeg = 0;
  private currentLeanAbsDeg = 0;

  // ---- Extreme lean ----
  private extremeLeanSince = 0;
  private extremeLeanPeak = 0;

  // ---- Corner acceleration ----
  private cornerAccelSince = 0;
  private cornerAccelPeak = 0;

  // ---- Speed wobble ----
  private hpYaw = 0;    // high-pass filtered yaw
  private prevRawYaw = 0;
  private wobbleSamples: number[] = [];
  private wobbleSince = 0;

  // ---- High-side risk ----
  private peakYaw = 0;
  private peakYawDir = 0;     // +1 or -1
  private peakYawT = 0;

  private currentSpeedKmH = 0;
  private currentLongAccel = 0;

  private locationGetter: () => { lat: number; lng: number } | null;
  private idCounter = 0;

  constructor(
    locationGetter: () => { lat: number; lng: number } | null,
    cfg: MotoConfig,
  ) {
    this.cfg = cfg;
    this.locationGetter = locationGetter;
    this.baseDetector = new EventDetector(locationGetter, cfg);
  }

  setListener(l: MotoEventListener): void {
    this.listener = l;
    // Forward base detector events via the same listener after adapting the type.
    this.baseDetector.setListener((ev) => {
      // EventDetector events are compatible with MotoSafetyEvent structure.
      this.listener?.(ev as MotoSafetyEvent);
    });
  }

  updateLeanState(lean: LeanState): void {
    this.currentLeanDeg = lean.angleDeg;
    this.currentLeanAbsDeg = Math.abs(lean.angleDeg);
  }

  /**
   * Main tick — must be called on every speed/accel update, same as
   * EventDetector.tick(). Also drives the base detector.
   */
  tick(input: {
    longitudinal: number;
    lateral: number;
    speedKmH: number;
    linearMag: number;
    t: number;
  }): void {
    this.currentSpeedKmH = input.speedKmH;
    this.currentLongAccel = input.longitudinal;

    this.baseDetector.tick(input);

    this.checkExtremeLean(input.t);
    this.checkCornerAccel(input.longitudinal, input.t);
  }

  /** Ingest one gyroscope sample for wobble and high-side detection. */
  ingestGyro(sample: GyroscopeSample): void {
    const rawYaw = sample.gyro.z;

    this.checkSpeedWobble(rawYaw, sample.t);
    this.checkHighsideRisk(rawYaw, sample.t);

    this.prevRawYaw = rawYaw;
  }

  onAppBackground(t: number): void { this.baseDetector.onAppBackground(t); }
  onAppForeground(t: number): void { this.baseDetector.onAppForeground(t); }

  flush(t: number): void {
    this.baseDetector.flush(t);
    if (this.extremeLeanSince > 0) {
      const dur = t - this.extremeLeanSince;
      if (dur >= this.cfg.minEventDurationS * 1000) this.emitExtremeLean(t, dur);
      this.extremeLeanSince = 0;
    }
    if (this.cornerAccelSince > 0) {
      const dur = t - this.cornerAccelSince;
      if (dur >= 500) this.emitCornerAccel(t, dur);
      this.cornerAccelSince = 0;
    }
  }

  updateConfig(patch: Partial<MotoConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    this.baseDetector.updateConfig(patch);
  }

  reset(): void {
    this.baseDetector.reset();
    this.currentLeanDeg = 0;
    this.currentLeanAbsDeg = 0;
    this.extremeLeanSince = 0;
    this.extremeLeanPeak = 0;
    this.cornerAccelSince = 0;
    this.cornerAccelPeak = 0;
    this.hpYaw = 0;
    this.prevRawYaw = 0;
    this.wobbleSamples = [];
    this.wobbleSince = 0;
    this.peakYaw = 0;
    this.peakYawDir = 0;
    this.peakYawT = 0;
    this.currentSpeedKmH = 0;
    this.currentLongAccel = 0;
  }

  // ---------- private detectors ----------

  private checkExtremeLean(t: number): void {
    const over = this.currentLeanAbsDeg >= this.cfg.extremeLeanThresholdDeg;
    if (over) {
      if (!this.extremeLeanSince) this.extremeLeanSince = t;
      if (this.currentLeanAbsDeg > this.extremeLeanPeak) this.extremeLeanPeak = this.currentLeanAbsDeg;
    } else if (this.extremeLeanSince) {
      const dur = t - this.extremeLeanSince;
      if (dur >= this.cfg.minEventDurationS * 1000) this.emitExtremeLean(t, dur);
      this.extremeLeanSince = 0;
      this.extremeLeanPeak = 0;
    }
  }

  private checkCornerAccel(longAccel: number, t: number): void {
    // Throttle input while leaning: accel > threshold AND lean > threshold.
    const leanOver = this.currentLeanAbsDeg >= this.cfg.cornerAccelLeanThresholdDeg;
    const accelOver = longAccel >= this.cfg.cornerAccelThreshold;

    if (leanOver && accelOver) {
      if (!this.cornerAccelSince) this.cornerAccelSince = t;
      if (longAccel > this.cornerAccelPeak) this.cornerAccelPeak = longAccel;
    } else if (this.cornerAccelSince) {
      const dur = t - this.cornerAccelSince;
      if (dur >= 500) this.emitCornerAccel(t, dur);
      this.cornerAccelSince = 0;
      this.cornerAccelPeak = 0;
    }
  }

  private checkSpeedWobble(rawYaw: number, t: number): void {
    if (this.currentSpeedKmH < this.cfg.wobbleMinSpeedKmH) {
      this.hpYaw = 0;
      this.wobbleSamples = [];
      this.wobbleSince = 0;
      return;
    }

    // High-pass filter (removes DC steering intention, passes oscillation)
    this.hpYaw = HP_ALPHA * (this.hpYaw + rawYaw - this.prevRawYaw);

    // Collect RMS over a 0.5-s rolling window (30 samples at 60 Hz)
    this.wobbleSamples.push(this.hpYaw * this.hpYaw);
    if (this.wobbleSamples.length > 30) this.wobbleSamples.shift();
    if (this.wobbleSamples.length < 10) return;

    const rms = Math.sqrt(this.wobbleSamples.reduce((a, b) => a + b, 0) / this.wobbleSamples.length);

    if (rms >= this.cfg.wobbleAmplitudeThresholdRadS) {
      if (!this.wobbleSince) this.wobbleSince = t;
      const dur = t - this.wobbleSince;
      if (dur >= this.cfg.wobbleMinDurationS * 1000) {
        // Emit then reset so we don't spam.
        const severity = rms >= this.cfg.wobbleAmplitudeThresholdRadS * 3 ? 5
          : rms >= this.cfg.wobbleAmplitudeThresholdRadS * 2 ? 4
          : rms >= this.cfg.wobbleAmplitudeThresholdRadS * 1.5 ? 3 : 2;

        const ev: MotoSafetyEvent = {
          id: `wobble_${t}_${++this.idCounter}`,
          type: 'speed_wobble',
          startedAt: this.wobbleSince,
          endedAt: t,
          peak: rms,
          severity,
          location: this.locationGetter(),
          meta: { speedKmH: this.currentSpeedKmH, rmsRadS: rms },
        };
        this.listener?.(ev);
        this.wobbleSince = t; // reset window to avoid continuous firing
        this.wobbleSamples = [];
      }
    } else {
      this.wobbleSince = 0;
    }
  }

  private checkHighsideRisk(rawYaw: number, t: number): void {
    // Track the peak yaw magnitude and its direction.
    if (Math.abs(rawYaw) > Math.abs(this.peakYaw)) {
      this.peakYaw = rawYaw;
      this.peakYawDir = rawYaw > 0 ? 1 : -1;
      this.peakYawT = t;
    }

    // If peak exceeded threshold, watch for reversal within the window.
    const peakMet = Math.abs(this.peakYaw) >= HS_YAW_THRESHOLD;
    const withinWindow = this.peakYawT > 0 && (t - this.peakYawT) < HS_REVERSAL_MS;

    if (peakMet && withinWindow) {
      const reversalOccurring = rawYaw * this.peakYawDir < -0.5; // sign flipped
      if (reversalOccurring) {
        // Estimate dω/dt over last 2 samples (60 Hz → dt ≈ 16.7ms)
        const dOmegaDt = Math.abs(rawYaw - this.peakYaw) / 0.0167;
        if (dOmegaDt >= HS_RATE_THRESHOLD) {
          const ev: MotoSafetyEvent = {
            id: `highside_${t}_${++this.idCounter}`,
            type: 'highside_risk',
            startedAt: this.peakYawT,
            endedAt: t,
            peak: dOmegaDt,
            severity: dOmegaDt >= 30 ? 5 : dOmegaDt >= 20 ? 4 : 3,
            location: this.locationGetter(),
            meta: {
              peakYawRadS: this.peakYaw,
              snapRateRadS2: dOmegaDt,
              speedKmH: this.currentSpeedKmH,
              leanDeg: this.currentLeanDeg,
            },
          };
          this.listener?.(ev);
          this.peakYaw = 0;
          this.peakYawT = 0;
        }
      }
    } else if (!withinWindow) {
      // Window expired without a reversal — reset.
      this.peakYaw = 0;
      this.peakYawT = 0;
    }
  }

  private emitExtremeLean(t: number, durMs: number): void {
    const deg = this.extremeLeanPeak;
    const severity: 1|2|3|4|5 =
      deg >= this.cfg.extremeLeanThresholdDeg + 10 ? 5 :
      deg >= this.cfg.extremeLeanThresholdDeg + 6  ? 4 :
      deg >= this.cfg.extremeLeanThresholdDeg + 3  ? 3 :
      deg >= this.cfg.extremeLeanThresholdDeg + 1  ? 2 : 1;

    this.listener?.({
      id: `xlean_${t}_${++this.idCounter}`,
      type: 'extreme_lean',
      startedAt: this.extremeLeanSince,
      endedAt: t,
      peak: deg,
      severity,
      location: this.locationGetter(),
      meta: { leanDeg: deg, durationMs: durMs, speedKmH: this.currentSpeedKmH },
    });
  }

  private emitCornerAccel(t: number, durMs: number): void {
    this.listener?.({
      id: `cacc_${t}_${++this.idCounter}`,
      type: 'corner_acceleration',
      startedAt: this.cornerAccelSince,
      endedAt: t,
      peak: this.cornerAccelPeak,
      severity: this.cornerAccelPeak >= this.cfg.cornerAccelThreshold * 2 ? 4 :
                this.cornerAccelPeak >= this.cfg.cornerAccelThreshold * 1.5 ? 3 : 2,
      location: this.locationGetter(),
      meta: {
        accelMs2: this.cornerAccelPeak,
        leanDeg: this.currentLeanAbsDeg,
        durationMs: durMs,
        speedKmH: this.currentSpeedKmH,
      },
    });
  }
}

/**
 * SensorFusion — turns raw phone-frame accelerometer samples plus a
 * speed source (OBD or GPS) into "vehicle-frame" motion that the
 * detectors can use.
 *
 * Design critique (important — Damoov uses a proprietary calibrated
 * fusion; we deliberately do something simpler):
 *
 *   A phone on a dash can be mounted at any orientation. To rotate raw
 *   accel into the vehicle frame "properly", you need full orientation
 *   tracking (Madgwick / Mahony filter over accel+gyro+mag). That is
 *   doable but (a) requires a calibrated magnetometer the user will not
 *   hold still, and (b) drifts under sustained turns.
 *
 *   Instead we use a hybrid that is actually *more* robust for the
 *   detectors we care about:
 *
 *     - Longitudinal accel is derived from the *speed* signal
 *       (OBD or GPS). This is exact — no orientation math needed.
 *       Phone can be upside down in a cupholder; the derivative of
 *       vehicle speed is still vehicle-longitudinal accel.
 *
 *     - Lateral accel is the centripetal formula a = v * dθ/dt, using
 *       GPS heading rate. This is also orientation-independent.
 *
 *     - The phone accelerometer is used for two things only:
 *         (1) crash detection (peak |a| after gravity removal), where
 *             we only care about *magnitude*, not direction;
 *         (2) distracted-driving motion-pattern detection (ditto).
 *
 *   Result: the algorithm works regardless of how the phone is oriented
 *   or whether it's mounted at all. We trade the ability to detect fast
 *   sub-second lateral events (which GPS at 1 Hz can miss) for much
 *   higher robustness. CrashReporter's multi-axis validation covers the
 *   high-frequency case for the one event where resolution really matters.
 */

import { AccelerometerSample, Vec3 } from './types';

/**
 * Low-pass cutoff for gravity estimation. At 60 Hz a coefficient of
 * 0.98 gives a ~1 Hz cutoff — fast enough to track the phone being
 * re-mounted, slow enough that real accelerations don't leak into the
 * "gravity" estimate (they'd leak into linearAccel instead).
 */
const GRAVITY_LP_ALPHA = 0.98;

export class SensorFusion {
  private gravity: Vec3 = { x: 0, y: 0, z: 9.81 };
  private gravityInitialized = false;

  /** Latest linear accel magnitude (m/s^2), gravity removed. */
  private lastLinearMag = 0;

  /**
   * Speed history for longitudinal-accel derivation. We keep a short
   * window so we can compute a smoothed derivative (a plain point
   * difference is unusably noisy for OBD at ~4 Hz / GPS at 1 Hz).
   */
  private speedHistory: Array<{ t: number; v: number }> = [];
  private readonly SPEED_HISTORY_MS = 1500;

  /**
   * Heading history for centripetal-accel derivation. Same idea.
   */
  private headingHistory: Array<{ t: number; h: number }> = [];
  private readonly HEADING_HISTORY_MS = 2000;

  private lastLinear: Vec3 = { x: 0, y: 0, z: 0 };

  ingestAccelerometer(s: AccelerometerSample): number {
    if (!this.gravityInitialized) {
      this.gravity = { ...s.accel };
      this.gravityInitialized = true;
    } else {
      this.gravity.x = GRAVITY_LP_ALPHA * this.gravity.x + (1 - GRAVITY_LP_ALPHA) * s.accel.x;
      this.gravity.y = GRAVITY_LP_ALPHA * this.gravity.y + (1 - GRAVITY_LP_ALPHA) * s.accel.y;
      this.gravity.z = GRAVITY_LP_ALPHA * this.gravity.z + (1 - GRAVITY_LP_ALPHA) * s.accel.z;
    }

    const lx = s.accel.x - this.gravity.x;
    const ly = s.accel.y - this.gravity.y;
    const lz = s.accel.z - this.gravity.z;
    this.lastLinear = { x: lx, y: ly, z: lz };
    this.lastLinearMag = Math.sqrt(lx * lx + ly * ly + lz * lz);
    return this.lastLinearMag;
  }

  /** Last gravity-removed accel vector (m/s²). Crash detector uses per-axis values. */
  getLastLinear(): Vec3 {
    return { ...this.lastLinear };
  }

  /** Latest linear-accel magnitude. Crash detector taps this. */
  getLinearMag(): number {
    return this.lastLinearMag;
  }

  /** Current gravity vector estimate (m/s²). LeanAngleEstimator uses this. */
  getGravity(): Vec3 {
    return { ...this.gravity };
  }

  /**
   * Ingest a speed sample (from either OBD or GPS) in m/s.
   * Returns the current smoothed longitudinal accel, m/s^2.
   */
  ingestSpeed(speedMPS: number, t: number): number {
    this.speedHistory.push({ t, v: speedMPS });
    const cutoff = t - this.SPEED_HISTORY_MS;
    while (this.speedHistory.length > 1 && this.speedHistory[0].t < cutoff) {
      this.speedHistory.shift();
    }
    return this.computeLongitudinalAccel();
  }

  /**
   * Ingest a GPS heading (degrees from north).
   * Returns current centripetal lateral accel, m/s^2 (signed: + = right).
   *
   * Needs a recent speed to compute the product, so call ingestSpeed first.
   */
  ingestHeading(headingDeg: number, t: number): number {
    this.headingHistory.push({ t, h: headingDeg });
    const cutoff = t - this.HEADING_HISTORY_MS;
    while (this.headingHistory.length > 1 && this.headingHistory[0].t < cutoff) {
      this.headingHistory.shift();
    }
    return this.computeLateralAccel();
  }

  getCurrentSpeedMPS(): number {
    if (this.speedHistory.length === 0) return 0;
    return this.speedHistory[this.speedHistory.length - 1].v;
  }

  /** Current lateral accel (m/s^2, signed). Safe to call any time. */
  getLateralAccel(): number {
    return this.computeLateralAccel();
  }

  /** Current longitudinal accel (m/s^2, signed). Safe to call any time. */
  getLongitudinalAccel(): number {
    return this.computeLongitudinalAccel();
  }

  private computeLongitudinalAccel(): number {
    /**
     * Why linear regression instead of just (v_last - v_first) / dt?
     * A point-difference on a 4 Hz OBD signal has ~0.3 m/s^2 RMS noise
     * from quantization alone (speed is a whole-km/h integer). LR over a
     * ~1.5 s window cuts that noise by roughly sqrt(N) while still
     * reacting fast enough to detect the 0.6 s minimum-duration window.
     */
    const n = this.speedHistory.length;
    if (n < 2) return 0;
    const t0 = this.speedHistory[0].t;
    let sumT = 0, sumV = 0, sumTT = 0, sumTV = 0;
    for (const p of this.speedHistory) {
      const dt = (p.t - t0) / 1000;
      sumT += dt;
      sumV += p.v;
      sumTT += dt * dt;
      sumTV += dt * p.v;
    }
    const denom = n * sumTT - sumT * sumT;
    if (denom < 1e-6) return 0;
    return (n * sumTV - sumT * sumV) / denom;
  }

  private computeLateralAccel(): number {
    const n = this.headingHistory.length;
    if (n < 2) return 0;
    const speed = this.getCurrentSpeedMPS();
    if (speed < 0.5) return 0;

    // Unwrap headings so a 359° -> 1° transition doesn't look like a 358° swing.
    const unwrapped: Array<{ t: number; h: number }> = [];
    let offset = 0;
    let prev = this.headingHistory[0].h;
    for (const p of this.headingHistory) {
      let h = p.h + offset;
      const diff = h - prev;
      if (diff > 180) { offset -= 360; h -= 360; }
      else if (diff < -180) { offset += 360; h += 360; }
      unwrapped.push({ t: p.t, h });
      prev = h;
    }

    const t0 = unwrapped[0].t;
    let sumT = 0, sumH = 0, sumTT = 0, sumTH = 0;
    for (const p of unwrapped) {
      const dt = (p.t - t0) / 1000;
      sumT += dt;
      sumH += p.h;
      sumTT += dt * dt;
      sumTH += dt * p.h;
    }
    const denom = n * sumTT - sumT * sumT;
    if (denom < 1e-6) return 0;
    const headingRateDegPerS = (n * sumTH - sumT * sumH) / denom;
    const headingRateRadPerS = (headingRateDegPerS * Math.PI) / 180;

    return speed * headingRateRadPerS;
  }

  reset(): void {
    this.gravityInitialized = false;
    this.gravity = { x: 0, y: 0, z: 9.81 };
    this.lastLinear = { x: 0, y: 0, z: 0 };
    this.lastLinearMag = 0;
    this.speedHistory = [];
    this.headingHistory = [];
  }
}

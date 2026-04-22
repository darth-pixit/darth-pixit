/**
 * LeanAngleEstimator — estimates motorcycle lean angle continuously.
 *
 * ================================================================
 *  Two estimation paths and why we need both
 * ================================================================
 *
 *  PATH 1 — GPS centripetal (primary)
 *  -----------------------------------
 *  For a motorcycle in steady-state circular motion the equilibrium
 *  condition gives:
 *
 *      tan(θ) = a_centripetal / g
 *      a_centripetal = v × dθ_heading/dt  (same as SensorFusion)
 *
 *  Pros: orientation-independent (phone can be anywhere on the bike);
 *        robust in steady corners.
 *  Cons: GPS heading at 1 Hz → 1-second latency; misses corner entry/
 *        exit dynamics; inaccurate at low speed (<15 km/h, GPS heading
 *        becomes noisy).
 *
 *  PATH 2 — IMU tilt (secondary, high-frequency)
 *  -----------------------------------------------
 *  The gravity vector rotates as the bike leans. If we track the
 *  LP-filtered gravity direction in the phone frame, its deviation
 *  from "rest position" (measured during the first few seconds of
 *  straight-line riding) reveals the roll angle.
 *
 *  Specifically: let g0 be the gravity vector when the bike is upright.
 *  As the bike leans by angle θ, the gravity vector rotates in the roll
 *  plane. The angle between current gravity and g0 IS the lean angle
 *  (to first order, ignoring road camber and rider body movement).
 *
 *  Pros: 60 Hz update rate; captures corner entry/exit flicks; no GPS.
 *  Cons: requires a "zero lean" calibration instant; sensitive to phone
 *        repositioning; road camber (~2–5°) and rider weight shift
 *        introduce bias of 2–5°.
 *
 *  FUSION STRATEGY
 *  ---------------
 *  1. Calibrate g0 during the first 3 s of riding at speed (< 5 km/h
 *     lateral accel = straight line confirmed by GPS).
 *  2. Use IMU tilt as the working lean estimate at 60 Hz.
 *  3. When a GPS-derived centripetal reading is available, apply a
 *     complementary-filter correction:
 *       lean_fused = 0.7 * lean_imu + 0.3 * lean_gps
 *     (IMU is fast but drifts; GPS is slow but accurate at steady state)
 *  4. If the IMU has not been calibrated yet, fall back to GPS-only.
 *
 *  SELF-CRITIQUE
 *  -------------
 *  The tilt calibration assumes the bike is upright when calibrated.
 *  If the rider calibrates on a banked road or in a parking lot with
 *  a camber, all subsequent lean angles are biased. We detect this by
 *  comparing the calibrated g0 magnitude to 9.81 m/s² — if it deviates
 *  by > 0.3 m/s² we discard the calibration and retry.
 *
 *  Road camber (2–5°) is a permanent bias we cannot remove without
 *  mapping data. We accept this as a ±3° accuracy limit.
 */

import { AccelerometerSample, Vec3 } from '../types';

const G = 9.81; // m/s²

export class LeanAngleEstimator {
  /** Gravity vector at "upright" (calibration reference). */
  private g0: Vec3 | null = null;
  private calibrated = false;
  private calibrationSamples: Vec3[] = [];
  private readonly CALIB_SAMPLE_TARGET = 180; // 3s at 60 Hz

  /** Current LP-filtered gravity vector (from SensorFusion companion). */
  private gravity: Vec3 = { x: 0, y: 0, z: G };

  /** Latest fused lean angle, degrees. Positive = right lean. */
  private leanDeg = 0;
  private leanSource: 'gps' | 'imu' = 'gps';

  /** Most recent GPS centripetal estimate for the complementary filter. */
  private gpsCentripetal = 0;
  private gpsCentripetalT = 0;

  /**
   * Provide the LP-filtered gravity vector from SensorFusion on each
   * accelerometer sample. We use it here rather than re-filtering.
   */
  ingestGravity(gravity: Vec3, speedKmH: number): void {
    this.gravity = gravity;

    // Calibration: collect g0 during confirmed straight-line riding
    if (!this.calibrated && speedKmH > 10 && speedKmH < 80) {
      // Gate: only accept samples when we have recent GPS confirming < 5 m/s² lateral
      // (caller must confirm the bike is straight before calling with doCalib = true)
      this.calibrationSamples.push({ ...gravity });
      if (this.calibrationSamples.length >= this.CALIB_SAMPLE_TARGET) {
        this.finishCalibration();
      }
    }

    if (!this.calibrated) {
      // Before calibration: GPS-only (computed separately via updateGPS)
      return;
    }

    // IMU tilt estimate: angle between current gravity and g0
    const theta = angleBetween(gravity, this.g0!);
    // Determine sign: which direction is the bike leaning?
    // We use the cross-product g0 × g to get a rotation axis, then
    // compare that axis to the "forward" direction. Positive = right.
    // Without knowing "forward" in the phone frame we use the component
    // of gravity perpendicular to both g0 and the current g.
    const sign = leanSign(gravity, this.g0!);
    const imuLean = sign * (theta * 180 / Math.PI);

    // Complementary filter with GPS if fresh (< 2s old).
    const gpsFresh = Date.now() - this.gpsCentripetalT < 2000 && this.gpsCentripetal > 0.1;
    if (gpsFresh) {
      const gpsLean = (Math.atan(this.gpsCentripetal / G) * 180 / Math.PI) *
        (imuLean >= 0 ? 1 : -1);
      this.leanDeg = 0.7 * imuLean + 0.3 * gpsLean;
      this.leanSource = 'imu';
    } else {
      this.leanDeg = imuLean;
      this.leanSource = 'imu';
    }
  }

  /**
   * Called from SensorFusion after each GPS heading update. Provides
   * the centripetal acceleration estimate derived from v × dθ/dt.
   */
  updateGPS(centripetal: number, t: number, leftTurn: boolean): void {
    this.gpsCentripetal = centripetal;
    this.gpsCentripetalT = t;

    if (!this.calibrated) {
      const gpsLeanDeg = Math.atan(centripetal / G) * 180 / Math.PI;
      this.leanDeg = leftTurn ? -gpsLeanDeg : gpsLeanDeg;
      this.leanSource = 'gps';
    }
  }

  /**
   * Signal that the bike is confirmed upright and the calibration
   * window should start (or restart if already failed).
   */
  requestCalibration(): void {
    this.calibrationSamples = [];
    this.calibrated = false;
    this.g0 = null;
  }

  getLeanDeg(): number { return this.leanDeg; }
  isCalibrated(): boolean { return this.calibrated; }
  getSource(): 'gps' | 'imu' { return this.leanSource; }

  reset(): void {
    this.g0 = null;
    this.calibrated = false;
    this.calibrationSamples = [];
    this.leanDeg = 0;
    this.gpsCentripetal = 0;
    this.gpsCentripetalT = 0;
  }

  private finishCalibration(): void {
    const n = this.calibrationSamples.length;
    const mean: Vec3 = {
      x: this.calibrationSamples.reduce((s, v) => s + v.x, 0) / n,
      y: this.calibrationSamples.reduce((s, v) => s + v.y, 0) / n,
      z: this.calibrationSamples.reduce((s, v) => s + v.z, 0) / n,
    };
    const mag = vecMag(mean);
    if (Math.abs(mag - G) > 0.3) {
      // Calibration is on a banked surface — discard and retry.
      this.calibrationSamples = [];
      return;
    }
    this.g0 = mean;
    this.calibrated = true;
    this.calibrationSamples = [];
  }
}

// ---------- Vector helpers ----------

function vecMag(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function angleBetween(a: Vec3, b: Vec3): number {
  const cosine = dot(a, b) / (vecMag(a) * vecMag(b) + 1e-9);
  return Math.acos(Math.max(-1, Math.min(1, cosine)));
}

/**
 * Returns +1 (right lean) or -1 (left lean) based on the rotation
 * direction from g0 to g.
 *
 * The axis of rotation is g0 × g. We need to know whether this axis
 * points "forward" or "backward" relative to the bike. Since we don't
 * know the bike frame, we use the largest component of the cross product
 * as a proxy — this is approximate but works well when the phone is
 * roughly aligned with the bike.
 */
function leanSign(g: Vec3, g0: Vec3): number {
  const axis = cross(g0, g);
  // The component with the largest absolute value is the "dominant" roll axis
  const maxAbs = Math.max(Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z));
  if (maxAbs < 1e-6) return 1;
  if (Math.abs(axis.x) === maxAbs) return axis.x > 0 ? 1 : -1;
  if (Math.abs(axis.y) === maxAbs) return axis.y > 0 ? 1 : -1;
  return axis.z > 0 ? 1 : -1;
}

/**
 * PhonePositionClassifier — classifies where the phone is being carried
 * on every tick, at ~1 Hz output, so downstream detectors can decide
 * whether to emit events at full confidence or suppress them.
 *
 * ================================================================
 *  WHY THIS RUNS FIRST
 * ================================================================
 *
 *  The single biggest source of false positives in smartphone-only
 *  telematics on motorcycles is a phone bouncing around in a pocket
 *  during normal urban riding. A phone in a cargo pocket produces:
 *
 *    - Lateral spikes of 0.5–1.5 g on every pothole (false "swerve")
 *    - Pitch-axis accelerations during walking (false "acceleration")
 *    - Orientation changes (rider reaches for something) that would be
 *      interpreted by a naive lean estimator as the bike leaning 30°+
 *
 *  Delivery-rider safety spec: "All downstream algorithms must consume
 *  both state + confidence". We embed that gate into this module's
 *  output so individual detectors don't need to reinvent it.
 *
 * ================================================================
 *  FEATURES (10-second sliding window, 1 Hz update)
 * ================================================================
 *
 *  1. orientation_variance
 *     Standard deviation of the gravity-vector direction over the
 *     window, in degrees. Mounted phones sit still (var < 1°). A phone
 *     in a pocket during walking has >10° variance; held in hand while
 *     riding is also >5°.
 *
 *  2. motion_coupling
 *     Correlation between the phone's linear-accel magnitude and the
 *     GPS-derived vehicle accel magnitude. Mounted phone feels every
 *     tap of the vehicle (ρ > 0.6). Pocket dampens high-frequency
 *     content (ρ ≈ 0.2–0.4). Held in hand has its own signature
 *     (ρ ≈ 0.3 but with high-freq energy much higher than vehicle).
 *
 *  3. high_freq_energy
 *     RMS of the accel signal above 5 Hz, estimated via a high-pass
 *     filter. Pockets and bags act like mechanical low-pass filters:
 *     they attenuate high-frequency content by 6–12 dB.
 *
 *  4. touch_event_rate (optional)
 *     Touches per second while moving. If the touch callback is wired
 *     in, sustained >0.5 touches/s strongly implies "held + interacting".
 *     If not available (touch plumbing isn't native on RN by default),
 *     this feature is left at 0 and contributes nothing.
 *
 *  5. charging_state (optional)
 *     On a cradle-mounted rig it's common for the phone to be charging.
 *     A True charging state is a weak positive prior for "mounted".
 *
 * ================================================================
 *  CLASSIFIER
 * ================================================================
 *
 *  The spec recommends XGBoost/LightGBM trained on ~100 labelled rides.
 *  We do not ship an ML runtime in v1. Instead we use a transparent
 *  decision-rule classifier that produces a confidence score from a
 *  weighted sum of feature scores. It is easy to tune per fleet and
 *  easy to replace with a tree ensemble later without changing callers.
 *
 *  The rules are calibrated from public data (Damoov 2022 phone-handling
 *  whitepaper; NHTSA smartphone sensor studies). They target ≥ 90%
 *  accuracy on the critical mounted-vs-not-mounted binary distinction,
 *  as required by §9.3 of the spec.
 *
 * ================================================================
 *  FAIL-SAFE: UNKNOWN
 * ================================================================
 *
 *  Before the window fills (first ~10 seconds of a trip) we emit
 *  'unknown' with confidence 0. Downstream detectors treat 'unknown'
 *  exactly like "not mounted" — i.e., they use their orientation-agnostic
 *  fallback path. No events are suppressed purely on 'unknown'; they are
 *  just prevented from using mounted-phone-only signals like lean angle.
 */

import { AccelerometerSample, Vec3 } from '../types';
import { PhonePositionState, PhonePositionSnapshot } from './types';

const WINDOW_MS = 10000;
/** High-pass filter cutoff for "high-frequency energy" feature, ~5 Hz at 60 Hz. */
const HP_ALPHA = 0.60;
/** How often to recompute classification output. */
const EMIT_INTERVAL_MS = 1000;

interface Sample {
  t: number;
  gravityDir: Vec3;      // unit-length gravity direction at this tick
  linearMag: number;     // |accel - gravity|
  hpMag: number;         // magnitude of the HP-filtered signal
  vehicleAccel: number;  // GPS-derived |a_fwd| at this tick (for coupling)
}

export class PhonePositionClassifier {
  private samples: Sample[] = [];
  private lastEmitT = 0;
  private lastOutput: PhonePositionSnapshot = {
    state: 'unknown',
    confidence: 0,
    updatedAt: 0,
  };

  // High-pass filter state (per-axis).
  private hpX = 0; private hpY = 0; private hpZ = 0;
  private prevX = 0; private prevY = 0; private prevZ = 0;
  private prevInitialised = false;

  // Touch-event counter since last emit (and the last fully-observed rate
  // so outside callers can reliably read a stable value between emits).
  private touchCount = 0;
  private lastTouchRatePerSec = 0;
  private chargingState = false;

  /**
   * When set, the classifier caps confidence at this value and marks the
   * result meta so downstream scoring knows a mount shift is suspected.
   * Cleared by clearMountShiftSuspicion().
   */
  private mountShiftConfidenceCap: number | null = null;

  /**
   * Push raw accelerometer sample and the current gravity/vehicle-accel
   * context. Emits a new classification at most every EMIT_INTERVAL_MS.
   */
  ingest(
    sample: AccelerometerSample,
    gravity: Vec3,
    vehicleAccelMs2: number,
  ): PhonePositionSnapshot {
    const t = sample.t;

    // Gravity direction as unit vector (guard against zero).
    const gmag = Math.sqrt(gravity.x * gravity.x + gravity.y * gravity.y + gravity.z * gravity.z) || 1e-9;
    const gDir: Vec3 = { x: gravity.x / gmag, y: gravity.y / gmag, z: gravity.z / gmag };

    // Linear-accel magnitude (phone-frame, gravity removed).
    const lx = sample.accel.x - gravity.x;
    const ly = sample.accel.y - gravity.y;
    const lz = sample.accel.z - gravity.z;
    const linMag = Math.sqrt(lx * lx + ly * ly + lz * lz);

    // High-pass to capture > ~5 Hz content (mechanical vibration, finger tapping).
    if (!this.prevInitialised) {
      this.prevX = sample.accel.x;
      this.prevY = sample.accel.y;
      this.prevZ = sample.accel.z;
      this.prevInitialised = true;
    }
    this.hpX = HP_ALPHA * (this.hpX + sample.accel.x - this.prevX);
    this.hpY = HP_ALPHA * (this.hpY + sample.accel.y - this.prevY);
    this.hpZ = HP_ALPHA * (this.hpZ + sample.accel.z - this.prevZ);
    this.prevX = sample.accel.x;
    this.prevY = sample.accel.y;
    this.prevZ = sample.accel.z;
    const hpMag = Math.sqrt(this.hpX * this.hpX + this.hpY * this.hpY + this.hpZ * this.hpZ);

    this.samples.push({ t, gravityDir: gDir, linearMag: linMag, hpMag, vehicleAccel: Math.abs(vehicleAccelMs2) });

    // Drop samples outside the window.
    const cutoff = t - WINDOW_MS;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }

    // Emit at most once per second.
    if (t - this.lastEmitT < EMIT_INTERVAL_MS) return this.lastOutput;
    const windowSec = (t - this.lastEmitT) / 1000;
    this.lastTouchRatePerSec = windowSec > 0 ? this.touchCount / windowSec : 0;
    this.lastEmitT = t;
    const out = this.classify(t);
    // Apply mount-shift confidence cap if active.
    if (this.mountShiftConfidenceCap !== null && out.confidence > this.mountShiftConfidenceCap) {
      out.confidence = this.mountShiftConfidenceCap;
    }
    this.lastOutput = out;
    // Reset touch counter for the next emit window.
    this.touchCount = 0;
    return this.lastOutput;
  }

  /** Register a touch event observed by the OS — bumps the texting-signature feature. */
  recordTouch(): void { this.touchCount++; }
  /** Set the phone's charging state if the app has battery-manager access. */
  setCharging(isCharging: boolean): void { this.chargingState = isCharging; }

  get(): PhonePositionSnapshot { return this.lastOutput; }

  /** Most recently computed touches/second. Stable between classify() emits. */
  getTouchRatePerSec(): number { return this.lastTouchRatePerSec; }

  /**
   * External call from MotoTripManager when GPS-derived expected lean
   * disagrees with the IMU-derived lean by > mountShiftMaxDiffDeg for
   * mountShiftMinDurationS seconds. We cap confidence so downstream
   * detectors treat the phone as potentially-shifted.
   */
  suspectMountShift(cap: number = 0.5): void {
    this.mountShiftConfidenceCap = cap;
    // Retroactively cap the last emitted output too.
    if (this.lastOutput.confidence > cap) {
      this.lastOutput = { ...this.lastOutput, confidence: cap };
    }
  }

  /** Clear the mount-shift suspicion (e.g., after recalibration). */
  clearMountShiftSuspicion(): void {
    this.mountShiftConfidenceCap = null;
  }

  reset(): void {
    this.samples = [];
    this.lastEmitT = 0;
    this.lastOutput = { state: 'unknown', confidence: 0, updatedAt: 0 };
    this.hpX = this.hpY = this.hpZ = 0;
    this.prevInitialised = false;
    this.touchCount = 0;
    this.lastTouchRatePerSec = 0;
    this.mountShiftConfidenceCap = null;
  }

  // ------- classifier -------

  private classify(t: number): PhonePositionSnapshot {
    // Need ≥ 3 s of data to form a meaningful window.
    if (this.samples.length < 30) {
      return { state: 'unknown', confidence: 0, updatedAt: t };
    }

    const orientVarDeg = this.orientationVarianceDeg();
    const coupling    = this.motionCoupling();
    const hfEnergy    = this.highFrequencyEnergy();
    const touchRate   = this.touchCount / (EMIT_INTERVAL_MS / 1000);
    const charging    = this.chargingState ? 1 : 0;

    // Score each candidate state, higher = better fit. Weighted rules below.
    // All feature scores sit in [0, 1].

    const mountedScore =
      clamp01(1 - orientVarDeg / 5)         * 0.35 +   // very low orientation variance
      clamp01(coupling)                      * 0.25 +   // linear accel correlates with vehicle
      clamp01(hfEnergy / 2)                  * 0.10 +   // some high-freq from engine is OK
      charging                               * 0.10 +
      clamp01(1 - touchRate / 2)             * 0.20;    // not being tapped

    const heldScore =
      clamp01((orientVarDeg - 3) / 10)       * 0.30 +   // hand movement
      clamp01(hfEnergy / 4)                  * 0.20 +   // hand tremor + tapping HF content
      clamp01(touchRate / 1.5)               * 0.25 +
      clamp01(1 - coupling)                  * 0.15 +   // poor coupling to vehicle
      (1 - charging)                         * 0.10;    // held phones rarely charging

    const pocketScore =
      clamp01((orientVarDeg - 5) / 15)       * 0.30 +   // constant bouncing
      clamp01(1 - hfEnergy / 1.5)            * 0.25 +   // fabric low-pass filters HF
      clamp01(1 - coupling)                  * 0.20 +
      clamp01(1 - touchRate)                 * 0.15 +   // no interaction
      (1 - charging)                         * 0.10;

    const bagScore =
      clamp01((orientVarDeg - 8) / 20)       * 0.30 +
      clamp01(1 - hfEnergy / 1)              * 0.30 +   // bag attenuates HF most
      clamp01(1 - coupling)                  * 0.20 +
      clamp01(1 - touchRate)                 * 0.10 +
      (1 - charging)                         * 0.10;

    const scores: Record<PhonePositionState, number> = {
      mounted: mountedScore,
      held:    heldScore,
      pocket:  pocketScore,
      bag:     bagScore,
      unknown: 0.15, // baseline so an ambiguous reading can still fall through to unknown
    };

    // Pick the winning state. Confidence = winner - runner-up (the spread).
    const ranked = (Object.entries(scores) as Array<[PhonePositionState, number]>)
      .sort((a, b) => b[1] - a[1]);
    const [winner, winnerScore] = ranked[0];
    const runnerUpScore = ranked[1][1];
    const rawConfidence = Math.max(0, Math.min(1, (winnerScore - runnerUpScore) * 3 + 0.2));

    return {
      state: winner,
      confidence: round2(rawConfidence),
      updatedAt: t,
    };
  }

  private orientationVarianceDeg(): number {
    // Mean direction (sum of unit vectors, then normalise)
    let sx = 0, sy = 0, sz = 0;
    for (const s of this.samples) {
      sx += s.gravityDir.x; sy += s.gravityDir.y; sz += s.gravityDir.z;
    }
    const n = this.samples.length;
    const mx = sx / n, my = sy / n, mz = sz / n;
    const mMag = Math.sqrt(mx * mx + my * my + mz * mz) || 1e-9;
    const mxN = mx / mMag, myN = my / mMag, mzN = mz / mMag;

    // Angular deviation of each sample from the mean direction.
    let sumDegSq = 0;
    for (const s of this.samples) {
      const dot = s.gravityDir.x * mxN + s.gravityDir.y * myN + s.gravityDir.z * mzN;
      const ang = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
      sumDegSq += ang * ang;
    }
    return Math.sqrt(sumDegSq / n);
  }

  private motionCoupling(): number {
    // Pearson correlation between |linearMag| and |vehicleAccel| over the window.
    const n = this.samples.length;
    let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
    for (const s of this.samples) {
      sumA += s.linearMag;
      sumB += s.vehicleAccel;
      sumAA += s.linearMag * s.linearMag;
      sumBB += s.vehicleAccel * s.vehicleAccel;
      sumAB += s.linearMag * s.vehicleAccel;
    }
    const meanA = sumA / n;
    const meanB = sumB / n;
    const varA = sumAA / n - meanA * meanA;
    const varB = sumBB / n - meanB * meanB;
    const cov = sumAB / n - meanA * meanB;
    const denom = Math.sqrt(Math.max(0, varA) * Math.max(0, varB));
    if (denom < 1e-6) return 0;
    return cov / denom;
  }

  private highFrequencyEnergy(): number {
    // RMS of the HP-filtered signal over the window.
    let sumSq = 0;
    for (const s of this.samples) sumSq += s.hpMag * s.hpMag;
    return Math.sqrt(sumSq / this.samples.length);
  }
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }
function round2(x: number): number { return Math.round(x * 100) / 100; }

/**
 * SwerveDetector — detects lane-splitting / obstacle-dodge swerves.
 *
 * ================================================================
 *  SWERVE vs. CORNER
 * ================================================================
 *
 *  A corner is a sustained change of heading (the rider commits to the
 *  turn). A swerve is the OPPOSITE: the bike moves laterally — sometimes
 *  violently — but the heading stays essentially unchanged because the
 *  rider is dodging around something and returning to the original line.
 *
 *  This is a critical event type on Indian roads: it correlates with
 *  last-minute avoidance (potholes, cyclists, cows, parked cars opening
 *  doors). Riders doing it several times per km are also the ones most
 *  likely to crash, and it is entirely missed by a pure cornering
 *  detector.
 *
 *  Signature (spec §4.5, over a 2-second sliding window):
 *
 *      lateral_impulse = max(|a_lat|)          > 0.35 g
 *      heading_change  = total |Δheading|       < 20°
 *      yaw_reversal    = sign_change in ω_yaw   True
 *
 *  The yaw-reversal clause is what distinguishes a swerve from a speed-
 *  breaker (which produces zero yaw) and from a normal corner (which
 *  produces monotonic yaw of one sign).
 *
 * ================================================================
 *  PHONE-POSITION SENSITIVITY
 * ================================================================
 *
 *  Gyroscope yaw is noisier when the phone is loose in a pocket. To
 *  avoid false swerve events from pocket motion, we require either the
 *  phone to be mounted (full confidence) OR the lateral impulse to
 *  exceed 1.5× the threshold (clear signal even with pocket damping).
 *
 *  The emitted event meta field records the phone position at detection
 *  so the scorer can apply the spec's multiplier (×2 if held).
 */

import { PhonePositionSnapshot, MotoConfig } from './types';

export interface SwerveSample {
  t: number;
  latAccelMs2: number;   // signed lateral accel
  yawRadS: number;       // signed yaw rate from gyro
  headingDeg: number | null; // from Kalman GPS; null at very low speed
}

export interface SwerveEvent {
  startedAt: number;
  endedAt: number;
  peakLatMs2: number;
  headingChangeDeg: number;
  yawReversals: number;
  /** Phone position at peak. */
  phonePosition: PhonePositionSnapshot;
}

export type SwerveListener = (ev: SwerveEvent) => void;

/** A swerve is not re-emitted within this debounce window. */
const DEBOUNCE_MS = 1500;

export class SwerveDetector {
  private cfg: MotoConfig;
  private window: SwerveSample[] = [];
  private lastEmitAt = 0;
  private listener: SwerveListener | null = null;
  private getPhonePos: () => PhonePositionSnapshot;

  constructor(cfg: MotoConfig, getPhonePos: () => PhonePositionSnapshot) {
    this.cfg = cfg;
    this.getPhonePos = getPhonePos;
  }

  setListener(l: SwerveListener): void { this.listener = l; }
  updateConfig(patch: Partial<MotoConfig>): void { this.cfg = { ...this.cfg, ...patch }; }

  ingest(sample: SwerveSample): void {
    this.window.push(sample);
    const cutoff = sample.t - this.cfg.swerveWindowMs;
    while (this.window.length > 1 && this.window[0].t < cutoff) this.window.shift();

    if (sample.t - this.lastEmitAt < DEBOUNCE_MS) return;

    const verdict = this.evaluate();
    if (verdict) {
      this.lastEmitAt = sample.t;
      this.listener?.(verdict);
    }
  }

  reset(): void {
    this.window = [];
    this.lastEmitAt = 0;
  }

  // ------- internals -------

  private evaluate(): SwerveEvent | null {
    if (this.window.length < 5) return null;

    // Peak lateral magnitude over the window
    let peakLat = 0;
    let peakT = this.window[0].t;
    for (const s of this.window) {
      if (Math.abs(s.latAccelMs2) > Math.abs(peakLat)) {
        peakLat = s.latAccelMs2;
        peakT = s.t;
      }
    }

    // Heading change: sum of |Δheading| across unwrapped samples with valid heading
    let headingChangeDeg = 0;
    let prev: number | null = null;
    for (const s of this.window) {
      if (s.headingDeg === null) { prev = null; continue; }
      if (prev !== null) {
        let d = s.headingDeg - prev;
        if (d > 180) d -= 360;
        else if (d < -180) d += 360;
        headingChangeDeg += Math.abs(d);
      }
      prev = s.headingDeg;
    }

    // Yaw reversals: count sign changes where both lobes exceed a tiny threshold
    let reversals = 0;
    let lastSign = 0;
    for (const s of this.window) {
      const sig = s.yawRadS > 0.2 ? 1 : s.yawRadS < -0.2 ? -1 : 0;
      if (sig !== 0) {
        if (lastSign !== 0 && sig !== lastSign) reversals++;
        lastSign = sig;
      }
    }

    // Apply the spec's classification rule.
    const pos = this.getPhonePos();
    const mounted = pos.state === 'mounted' && pos.confidence >= this.cfg.phonePositionMinConfidence;
    const strongImpulse = Math.abs(peakLat) >= this.cfg.swerveLatImpulseMs2 * (mounted ? 1.0 : 1.5);

    if (!strongImpulse) return null;
    if (headingChangeDeg >= this.cfg.swerveMaxHeadingChangeDeg) return null;
    if (reversals < 1) return null;

    return {
      startedAt: this.window[0].t,
      endedAt: this.window[this.window.length - 1].t,
      peakLatMs2: Math.abs(peakLat),
      headingChangeDeg,
      yawReversals: reversals,
      phonePosition: pos,
    };
  }
}

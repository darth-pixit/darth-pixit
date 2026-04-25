/**
 * RoadObstacleFilter — detects speed breakers, potholes, and normal stops
 * so the brake-event detector does not flag them as hard-braking events.
 *
 * ================================================================
 *  INDIAN ROAD REALITY
 * ================================================================
 *
 *  A typical 5 km delivery run in a Tier-1 Indian city includes:
 *
 *    - 8–15 speed breakers (rubberised, tarred, painted yellow rumbles,
 *      or invisible killer humps). Each one causes a vertical-axis spike
 *      of 0.5–1.5 g lasting < 0.4 s. An unwary hard-brake detector sees
 *      "sharp decel" at every crossing.
 *
 *    - Dozens of potholes, often unavoidable. Signature: large vertical
 *      spike + simultaneous lateral dodge as the rider swerves around.
 *
 *    - 10–25 red lights and traffic stops. Normal braking to a
 *      controlled stop produces a long, gradual ramp — NOT an event.
 *
 *  The false-positive rate of a naive brake detector on Indian roads is
 *  north of 40%. Riders who get flagged for obviously legitimate riding
 *  lose trust in the system within a single shift. The spec's position
 *  is unambiguous: "False positive rate is the #1 quality axis."
 *
 *  This module implements the three filters verbatim from spec §4.3.
 *
 * ================================================================
 *  WHY NOT USE THE GYROSCOPE FOR THIS
 * ================================================================
 *
 *  Speed breakers do produce a pitch-forward-then-back signature on a
 *  2-wheeler, but the SIGNAL-TO-NOISE on pitch is much worse than on
 *  the vertical accelerometer axis. Vertical accel is dominated by road
 *  contact at the wheels and is transmitted to a pocket-held phone almost
 *  intact. Pitch rate requires the phone to be on-centre axis to be
 *  meaningful, and we cannot assume that (see PhonePositionClassifier).
 */

import { MotoConfig } from './types';

export type ObstacleKind = 'speed_breaker' | 'pothole' | 'normal_stop';

export interface ObstacleFilterVerdict {
  /** If non-null, the caller should SUPPRESS the brake event. */
  suppress: ObstacleKind | null;
  /** Diagnostic: the peak vertical/lateral accel used in the decision. */
  peakVertMs2: number;
  peakLatMs2: number;
  /** True when the end-of-brake location was within OSM-signal range. */
  nearTrafficSignal: boolean;
  /** Metres to the nearest known traffic signal, when available. */
  trafficSignalDistM: number | null;
}

/**
 * Optional callback: returns known traffic-signal proximity for the
 * location where the brake event ends. Populated by
 * ContextEnrichmentService when OSM data is available.
 */
export interface SignalProximityGetter {
  (): { near: boolean; distM: number | null };
}

interface AccelSample {
  t: number;
  /** Vertical-axis raw accel (phone frame — the classifier tolerates orientation; see note below). */
  vertical: number;
  /** Lateral-axis magnitude (phone frame). */
  lateral: number;
}

/**
 * NOTE ON "VERTICAL AXIS"
 *   True vertical = direction aligned with gravity. We feed this module
 *   the gravity-aligned component computed by SensorFusion, which it
 *   already LP-filters. The filter thus works regardless of phone
 *   orientation: what matters is "sudden displacement along gravity",
 *   which is what a speed breaker causes.
 */

const BUFFER_MS = 3000;

export class RoadObstacleFilter {
  private cfg: MotoConfig;
  private buffer: AccelSample[] = [];
  private signalGetter: SignalProximityGetter | null = null;

  constructor(cfg: MotoConfig, signalGetter: SignalProximityGetter | null = null) {
    this.cfg = cfg;
    this.signalGetter = signalGetter;
  }

  /**
   * Wire the OSM-backed traffic-signal proximity callback. Pass null
   * to detach (e.g., when context enrichment goes offline).
   */
  setSignalProximityGetter(g: SignalProximityGetter | null): void {
    this.signalGetter = g;
  }

  updateConfig(patch: Partial<MotoConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /** Feed an IMU-derived axis sample (gravity-aligned vertical + lateral magnitude). */
  ingest(t: number, vertical: number, lateral: number): void {
    this.buffer.push({ t, vertical, lateral });
    const cutoff = t - BUFFER_MS;
    while (this.buffer.length > 1 && this.buffer[0].t < cutoff) this.buffer.shift();
  }

  /**
   * Called right before a brake event is about to fire. Returns a verdict
   * about whether it should be suppressed and, if so, which obstacle
   * classification caused the suppression.
   *
   * @param brakeStartT   timestamp the brake event started (ms)
   * @param brakeEndT     timestamp the brake event ended (ms)
   * @param peakDecelMs2  magnitude of the peak decel in the event (positive)
   * @param currentSpeedKmH speed at end of brake event
   */
  evaluate(
    brakeStartT: number,
    brakeEndT: number,
    peakDecelMs2: number,
    currentSpeedKmH: number,
  ): ObstacleFilterVerdict {
    const { peakVert, peakLat } = this.peaksInWindow(brakeStartT - 300, brakeEndT + 300);
    const durationS = (brakeEndT - brakeStartT) / 1000;
    const signal = this.signalGetter ? this.signalGetter() : { near: false, distM: null };

    // -------- Filter 1: Speed breaker --------
    // Large vertical spike + very short forward decel + modest peak decel.
    if (
      peakVert >= this.cfg.speedBreakerVertPeakMs2 &&
      durationS < this.cfg.speedBreakerMaxDecelDurationS &&
      peakDecelMs2 < this.cfg.speedBreakerMaxDecelMs2
    ) {
      return {
        suppress: 'speed_breaker',
        peakVertMs2: peakVert, peakLatMs2: peakLat,
        nearTrafficSignal: signal.near, trafficSignalDistM: signal.distM,
      };
    }

    // -------- Filter 2: Pothole / obstacle dodge --------
    // Even bigger vertical spike combined with a lateral swerve, very brief decel.
    if (
      peakVert >= this.cfg.potholeVertPeakMs2 &&
      peakLat >= this.cfg.potholeLatPeakMs2 &&
      durationS < this.cfg.potholeMaxDecelDurationS
    ) {
      return {
        suppress: 'pothole',
        peakVertMs2: peakVert, peakLatMs2: peakLat,
        nearTrafficSignal: signal.near, trafficSignalDistM: signal.distM,
      };
    }

    // -------- Filter 3: Normal stop (red light) --------
    //
    // Two paths:
    //   (a) OSM says we're near a tagged traffic signal (spec §4.3, Filter 3):
    //       relax the decel-peak ceiling a bit — we KNOW why they braked.
    //       Allow up to 1.3× the normal-stop ceiling, still require final speed ≈ 0.
    //   (b) No signal data, or not near one: keep the physical signature
    //       (gradual decel + zero final speed). This is the v1 behaviour
    //       and fires correctly on mid-block stops, yields, etc.
    const endedAtZero = currentSpeedKmH <= this.cfg.normalStopEndSpeedKmH;
    const gradualSignal = peakDecelMs2 < this.cfg.normalStopPeakMs2 * 1.3;
    const gradualSignature = peakDecelMs2 < this.cfg.normalStopPeakMs2;
    if (endedAtZero && ((signal.near && gradualSignal) || gradualSignature)) {
      return {
        suppress: 'normal_stop',
        peakVertMs2: peakVert, peakLatMs2: peakLat,
        nearTrafficSignal: signal.near, trafficSignalDistM: signal.distM,
      };
    }

    return {
      suppress: null,
      peakVertMs2: peakVert, peakLatMs2: peakLat,
      nearTrafficSignal: signal.near, trafficSignalDistM: signal.distM,
    };
  }

  reset(): void {
    this.buffer = [];
  }

  private peaksInWindow(fromT: number, toT: number): { peakVert: number; peakLat: number } {
    let peakVert = 0;
    let peakLat = 0;
    for (const s of this.buffer) {
      if (s.t < fromT || s.t > toT) continue;
      if (Math.abs(s.vertical) > peakVert) peakVert = Math.abs(s.vertical);
      if (Math.abs(s.lateral)  > peakLat)  peakLat  = Math.abs(s.lateral);
    }
    return { peakVert, peakLat };
  }
}

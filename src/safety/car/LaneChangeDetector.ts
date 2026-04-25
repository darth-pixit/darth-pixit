/**
 * LaneChangeDetector — S-shape lateral acceleration pattern detection.
 *
 * A lane change produces a characteristic S-curve in lateral acceleration:
 *   Phase 1: Driver turns the wheel → lat accel pushes car sideways.
 *   Phase 2: Driver straightens wheel → lat accel reverses to settle.
 *
 * Detection criteria (all must be met within laneChangeWindowMs):
 *   1. Two lateral accel phases with opposite signs, each above
 *      laneChangePeakLatMs2.
 *   2. Net heading change < laneChangeMaxHeadingChangeDeg (not a turn).
 *   3. Total duration between laneChangeMinDurationS and laneChangeMaxDurationS.
 *
 * We use a sliding window: every sample is appended; samples older than
 * the window are discarded. On each append we attempt to detect the S-shape.
 *
 * Why this isn't trivially a GPS-heading approach:
 *   Lane changes on motorways at 100 km/h produce only 1–3° of heading
 *   change. GPS heading at 1 Hz would not reliably capture this. The IMU
 *   lateral channel at 50+ Hz resolves the signature clearly.
 */

import { CarConfig } from './types';

export interface LaneChangeEvent {
  startedAt: number;
  endedAt: number;
  peakLatMs2: number;
  /** Heading delta across the manoeuvre; small = likely lane change. */
  netHeadingChangeDeg: number;
  severity: 1 | 2 | 3 | 4 | 5;
  meta: Record<string, number | string | boolean>;
}

export type LaneChangeListener = (ev: LaneChangeEvent) => void;

interface LatSample {
  t: number;
  latMs2: number;
  headingDeg: number | null;
}

export class LaneChangeDetector {
  private cfg: CarConfig;
  private listener: LaneChangeListener | null = null;
  private window: LatSample[] = [];
  /**
   * Cooldown timestamp: after emitting an event, suppress new detections
   * for `laneChangeMaxDurationS` to avoid double-counting the same manoeuvre.
   */
  private suppressUntilT = 0;

  constructor(cfg: CarConfig) {
    this.cfg = cfg;
  }

  setListener(l: LaneChangeListener): void { this.listener = l; }

  updateConfig(patch: Partial<CarConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  reset(): void {
    this.window = [];
    this.suppressUntilT = 0;
  }

  ingest(t: number, latMs2: number, headingDeg: number | null): void {
    const windowMs = this.cfg.laneChangeWindowMs;
    this.window.push({ t, latMs2, headingDeg });

    // Trim samples older than the detection window.
    const cutoff = t - windowMs;
    while (this.window.length > 1 && this.window[0].t < cutoff) {
      this.window.shift();
    }

    if (t < this.suppressUntilT) return;
    this.tryDetect(t);
  }

  private tryDetect(now: number): void {
    const { laneChangePeakLatMs2, laneChangeMinDurationS, laneChangeMaxDurationS,
      laneChangeMaxHeadingChangeDeg } = this.cfg;

    const minDurMs = laneChangeMinDurationS * 1000;
    const maxDurMs = laneChangeMaxDurationS * 1000;
    const n = this.window.length;
    if (n < 4) return;

    // Scan for a sign-flipped two-phase pattern starting at each sample.
    for (let i = 0; i < n - 2; i++) {
      const phase1Start = this.window[i];

      // Find phase-1 peak: the first exceedance of threshold in one direction.
      let phase1Peak = 0;
      let phase1PeakIdx = -1;
      for (let j = i; j < n; j++) {
        const v = this.window[j].latMs2;
        if (Math.abs(v) >= laneChangePeakLatMs2) {
          if (phase1PeakIdx === -1 || Math.abs(v) > Math.abs(phase1Peak)) {
            phase1Peak = v;
            phase1PeakIdx = j;
          }
        }
        // Only look until we leave the threshold band in either direction.
        if (j > i + 2 && Math.abs(v) < laneChangePeakLatMs2 * 0.3 && phase1PeakIdx !== -1) {
          break;
        }
      }

      if (phase1PeakIdx === -1) continue;
      const phase1Sign = phase1Peak > 0 ? 1 : -1;

      // Find zero-crossing after the phase-1 peak.
      let crossIdx = -1;
      for (let j = phase1PeakIdx + 1; j < n; j++) {
        if (this.window[j].latMs2 * phase1Sign < 0) {
          crossIdx = j;
          break;
        }
      }
      if (crossIdx === -1) continue;

      // Find phase-2 peak after the crossing (opposite sign, above threshold).
      let phase2Peak = 0;
      let phase2EndIdx = -1;
      for (let j = crossIdx; j < n; j++) {
        const v = this.window[j].latMs2;
        if (v * phase1Sign < -laneChangePeakLatMs2 * 0.8 &&
            Math.abs(v) > Math.abs(phase2Peak)) {
          phase2Peak = v;
          phase2EndIdx = j;
        }
        // Stop scanning if we see another sign flip — that's a different event.
        if (j > crossIdx + 1 && v * phase1Sign > laneChangePeakLatMs2 * 0.5) {
          break;
        }
      }

      if (phase2EndIdx === -1 || Math.abs(phase2Peak) < laneChangePeakLatMs2 * 0.8) continue;

      const startT = phase1Start.t;
      const endT   = this.window[phase2EndIdx].t;
      const durMs  = endT - startT;

      if (durMs < minDurMs || durMs > maxDurMs) continue;

      // Heading constraint: net change must be small.
      const headingStart = phase1Start.headingDeg;
      const headingEnd   = this.window[phase2EndIdx].headingDeg;
      let netHeading = 0;
      if (headingStart !== null && headingEnd !== null) {
        netHeading = shortestAngularDelta(headingStart, headingEnd);
        if (netHeading > laneChangeMaxHeadingChangeDeg) continue;
      }

      const peak = Math.max(Math.abs(phase1Peak), Math.abs(phase2Peak));
      const severity = severityFromPeak(peak, laneChangePeakLatMs2);

      this.listener?.({
        startedAt: startT,
        endedAt: endT,
        peakLatMs2: peak,
        netHeadingChangeDeg: netHeading,
        severity,
        meta: {
          phase1PeakMs2: round2(phase1Peak),
          phase2PeakMs2: round2(phase2Peak),
          durationMs: durMs,
        },
      });

      // Suppress for maxDuration after this event to avoid double-counting.
      this.suppressUntilT = now + maxDurMs;
      // Advance window past this detection.
      this.window = this.window.slice(phase2EndIdx + 1);
      return;
    }
  }
}

function shortestAngularDelta(a: number, b: number): number {
  const d = Math.abs(b - a) % 360;
  return d > 180 ? 360 - d : d;
}

function severityFromPeak(peakMs2: number, threshold: number): 1 | 2 | 3 | 4 | 5 {
  const ratio = peakMs2 / threshold;
  if (ratio >= 3.5) return 5;
  if (ratio >= 2.5) return 4;
  if (ratio >= 2.0) return 3;
  if (ratio >= 1.5) return 2;
  return 1;
}

function round2(x: number): number { return Math.round(x * 100) / 100; }

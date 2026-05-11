/**
 * EventDetector — turns a stream of (longitudinal, lateral, speed,
 * heading, AppState) updates into discrete SafetyEvent objects.
 *
 * =============================================================
 *  Thresholds and WHY they are set where they are
 * =============================================================
 *
 * Hard Acceleration: 3.0 m/s^2 (~0.30 g)
 *   - Damoov/Cambridge Mobile Telematics / Octo all converge at 2.7–3.1
 *     m/s^2 after decades of claims data. Below 2.5 you get thousands of
 *     false positives from normal highway on-ramps; above 3.5 you miss
 *     most urban "jackrabbit starts" that correlate with accident risk.
 *   - CRITIQUE: Context matters. Full-throttle highway merge from
 *     60→100 km/h across 4 s is ~2.8 m/s^2 and is *safer* than a slow
 *     merge. I mitigate this two ways:
 *       (a) Severity scaling — a borderline event is severity 1 and
 *           barely penalized;
 *       (b) The "min duration 0.6 s" window filters instantaneous
 *           accelerometer spikes and keeps sustained pedal-to-floor
 *           events.
 *   - A nicer v2 would scale the threshold up at highway speeds:
 *     accel-to-merge is less dangerous than accel-in-school-zone. I've
 *     left a hook (speedContextScale) for that.
 *
 * Hard Braking: 3.2 m/s^2 (~0.33 g)
 *   - Slightly above accel because the human baseline for braking is
 *     already harder than for accel (pedal ergonomics + weight transfer).
 *     Industry data agrees: asymmetric thresholds match observed risk.
 *   - BIG CRITIQUE: Emergency braking to avoid a collision is GOOD
 *     behavior, but raw physics can't distinguish it from the habit of
 *     "tailgate, then slam brakes". Two partial mitigations:
 *       (a) Minimum 0.6 s duration filters out brief panic stops — a
 *           true emergency stop is usually >0.6 s to a halt. (This is
 *           imperfect — some emergencies are 0.3 s taps.)
 *       (b) We tag meta.precededByHardAccel; if a hard brake comes
 *           right after a hard accel, the scorer treats it as a habit
 *           event, not emergency avoidance. You'll see that in
 *           SafetyScorer.ts.
 *
 * Hard Cornering: 4.2 m/s^2 (~0.43 g lateral)
 *   - Tire-limit cornering on dry pavement for a passenger car is
 *     ~0.8–1.0 g. 0.43 g is well clear of comfortable cruising but well
 *     below the limit — it's the "I'm pushing it" regime.
 *   - CRITIQUE: Same threshold at 30 km/h and 100 km/h is not quite
 *     right — 0.43 g at 100 is a dramatically tighter turning radius in
 *     a worse environment. I do NOT speed-scale this threshold because
 *     the centripetal formula a = v * ω already encodes speed: at 100
 *     km/h a 4.2 m/s^2 corner only needs 0.15 rad/s of heading rate,
 *     which is exactly what you'd hope would trigger. It works out.
 *
 * Overspeeding: absolute 130 km/h + zone limit + 5 km/h grace, 3 s min
 *   - Without a mapping API we cannot know the posted limit. Two layers:
 *       (a) Absolute: >130 km/h is illegal almost everywhere and
 *           dangerous anywhere (autobahns excepted — user can raise).
 *       (b) Zone: user-settable current zone limit — a city-mode
 *           toggle, a future BLE-beacon tie-in, or a route-based
 *           geofence can set this live.
 *   - 5 km/h grace matches the tolerance most enforcement uses.
 *   - 3 s minimum duration avoids flagging a brief crest over a
 *     downhill where you ease off.
 *
 * Distracted Driving: AppState background >3 s while moving >10 km/h
 *   - Damoov uses a trained ML model on accel+gyro+screen. We don't
 *     have screen state without a native module and we don't have an
 *     ML model, so we use the strongest available signal: the app went
 *     to background while the car was moving. That means the user is
 *     actively in another app — navigation, messaging, something.
 *   - CRITIQUE: This misses (a) passenger handling the phone — we'd
 *     flag a passenger typing as the driver distracted, (b) looking at
 *     a mounted phone without touching it (still distraction), and (c)
 *     voice-driven app use (which is arguably safe).
 *   - We also watch for "phone picked up" motion signatures via the
 *     accelerometer — a sustained non-trivial linearMag (>0.7 m/s^2 for
 *     >2 s) that doesn't correlate with vehicle accel is a good proxy
 *     for "phone was manipulated in the hand". This is a weak signal and
 *     I keep its severity low.
 *
 * =============================================================
 *  Event combination rules (from Damoov docs, verified sensible):
 *     - Min event duration 0.6 s for hard accel/brake/corner
 *     - Max gap between events of the same type 3 s (merge if closer)
 *   Rationale: a single "hard stop" at a light is often two brake
 *   pulses 0.5 s apart. Merging avoids double-penalizing the same
 *   physical event.
 * =============================================================
 */

import {
  SafetyEvent,
  SafetyEventType,
  SafetyConfig,
  DEFAULT_SAFETY_CONFIG,
} from './types';

export type EventListener = (ev: SafetyEvent) => void;

interface OpenEvent {
  type: SafetyEventType;
  startedAt: number;
  lastOverT: number;
  peak: number;
  peakLocation: { lat: number; lng: number } | null;
  meta: Record<string, number | string | boolean>;
}

interface LocationGetter {
  (): { lat: number; lng: number } | null;
}

export class EventDetector {
  private cfg: SafetyConfig;
  private locationGetter: LocationGetter;
  private listener: EventListener | null = null;

  private openAccel: OpenEvent | null = null;
  private openBrake: OpenEvent | null = null;
  private openCorner: OpenEvent | null = null;
  private openOverspeed: OpenEvent | null = null;
  private openDistracted: OpenEvent | null = null;

  /** Track previous hard-accel end time so we can tag following-brake context. */
  private lastHardAccelEnd = 0;

  /** Current speed (km/h) — updated each tick, used across all detectors. */
  private currentSpeedKmH = 0;

  /**
   * App background timestamp. Non-zero = app is in background.
   * Updated from the outside by onAppBackground/Foreground hooks.
   */
  private appBackgroundedAt = 0;

  private appIsBackground = false;

  /** Debounce for linearMag-based distraction motion detection. */
  private phoneHandledSinceMs = 0;

  private eventIdCounter = 0;

  constructor(
    locationGetter: LocationGetter,
    cfg: SafetyConfig = DEFAULT_SAFETY_CONFIG,
  ) {
    this.locationGetter = locationGetter;
    this.cfg = cfg;
  }

  setListener(l: EventListener): void {
    this.listener = l;
  }

  updateConfig(patch: Partial<SafetyConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /**
   * Tick from the fusion layer. Call once per sensor update (driven by
   * whichever of OBD speed / GPS / accelerometer arrives).
   */
  tick(input: {
    longitudinal: number;
    lateral: number;
    speedKmH: number;
    linearMag: number;
    t: number;
  }): void {
    this.currentSpeedKmH = input.speedKmH;

    // Hard acceleration
    this.updateDirectional(
      'hard_acceleration',
      input.longitudinal,
      this.cfg.hardAccelThreshold,
      input.t,
      (peak) => ({ peak_m_s2: peak, speedKmH: input.speedKmH }),
    );

    // Hard braking (negative longitudinal)
    this.updateDirectional(
      'hard_braking',
      -input.longitudinal,
      this.cfg.hardBrakeThreshold,
      input.t,
      (peak) => ({
        peak_m_s2: peak,
        speedKmH: input.speedKmH,
        // Did a hard accel end within the last 5 s? If so this brake is
        // likely part of an aggressive-driving pattern, not emergency
        // avoidance. The scorer uses this to weight severity.
        precededByHardAccel: this.lastHardAccelEnd > 0 &&
          input.t - this.lastHardAccelEnd < 5000,
      }),
    );

    // Hard cornering (magnitude of lateral)
    this.updateDirectional(
      'hard_cornering',
      Math.abs(input.lateral),
      this.cfg.hardCornerThreshold,
      input.t,
      (peak) => ({
        peak_m_s2: peak,
        speedKmH: input.speedKmH,
        direction: input.lateral > 0 ? 'right' : 'left',
      }),
    );

    // Overspeeding
    this.updateOverspeeding(input.speedKmH, input.t);

    // Distracted driving: AppState-based
    this.updateAppStateDistraction(input.speedKmH, input.t);

    // Distracted driving: phone-handling motion signature
    this.updatePhoneHandlingMotion(
      input.linearMag,
      Math.abs(input.longitudinal),
      input.speedKmH,
      input.t,
    );
  }

  onAppBackground(t: number): void {
    this.appIsBackground = true;
    this.appBackgroundedAt = t;
  }

  onAppForeground(t: number): void {
    this.appIsBackground = false;
    // If a distraction event is open, close it now — foreground = attention back.
    if (this.openDistracted) {
      this.closeEvent(this.openDistracted, t);
      this.openDistracted = null;
    }
  }

  /**
   * Close all open events at trip end.
   *
   * Applies the same minEventDurationS guard as updateDirectional so a
   * sub-threshold event that started a few milliseconds before the trip
   * ended doesn't inflate event counts and scoring.
   * Overspeeding and distraction events are not subject to this guard
   * (they have their own duration checks inline).
   */
  flush(t: number): void {
    const minMs = this.cfg.minEventDurationS * 1000;
    for (const [open, clear] of [
      [this.openAccel,   (v: OpenEvent | null) => { this.openAccel   = v; }] as const,
      [this.openBrake,   (v: OpenEvent | null) => { this.openBrake   = v; }] as const,
      [this.openCorner,  (v: OpenEvent | null) => { this.openCorner  = v; }] as const,
    ]) {
      if (open) {
        if (t - open.startedAt >= minMs) this.closeEvent(open, t);
        clear(null);
      }
    }
    if (this.openOverspeed) {
      const dur = this.openOverspeed.lastOverT - this.openOverspeed.startedAt;
      if (dur >= this.cfg.minOverspeedDurationS * 1000) {
        this.closeEvent(this.openOverspeed, this.openOverspeed.lastOverT);
      }
      this.openOverspeed = null;
    }
    if (this.openDistracted) {
      const dur = this.openDistracted.lastOverT - this.openDistracted.startedAt;
      if (dur >= this.cfg.distractedMinDurationS * 1000) {
        this.closeEvent(this.openDistracted, this.openDistracted.lastOverT);
      }
      this.openDistracted = null;
    }
  }

  reset(): void {
    this.openAccel = this.openBrake = this.openCorner = null;
    this.openOverspeed = this.openDistracted = null;
    this.lastHardAccelEnd = 0;
    this.currentSpeedKmH = 0;
    this.appIsBackground = false;
    this.appBackgroundedAt = 0;
    this.phoneHandledSinceMs = 0;
  }

  // ---------- internals ----------

  private updateDirectional(
    type: SafetyEventType,
    signedValue: number,
    threshold: number,
    t: number,
    metaFn: (peak: number) => Record<string, number | string | boolean>,
  ): void {
    const current = this.getOpen(type);
    const over = signedValue >= threshold;

    if (over) {
      if (!current) {
        const open: OpenEvent = {
          type,
          startedAt: t,
          lastOverT: t,
          peak: signedValue,
          peakLocation: this.locationGetter(),
          meta: metaFn(signedValue),
        };
        this.setOpen(type, open);
      } else {
        current.lastOverT = t;
        if (signedValue > current.peak) {
          current.peak = signedValue;
          current.peakLocation = this.locationGetter();
          current.meta = metaFn(signedValue);
        }
      }
    } else if (current) {
      const gapMs = t - current.lastOverT;
      if (gapMs > this.cfg.maxEventGapS * 1000) {
        // Close — but only emit if minimum duration met.
        const durationMs = current.lastOverT - current.startedAt;
        if (durationMs >= this.cfg.minEventDurationS * 1000) {
          this.closeEvent(current, current.lastOverT);
          if (type === 'hard_acceleration') this.lastHardAccelEnd = current.lastOverT;
        }
        this.setOpen(type, null);
      }
      // else: inside merge window — keep it open, wait for resumption or close.
    }
  }

  private updateOverspeeding(speedKmH: number, t: number): void {
    const zoneLimit = this.cfg.zoneSpeedLimitKmH;
    const absoluteLimit = this.cfg.absoluteSpeedLimitKmH;
    const grace = this.cfg.overspeedBufferKmH;

    let effectiveLimit = absoluteLimit;
    if (zoneLimit !== null && zoneLimit + grace < effectiveLimit) {
      effectiveLimit = zoneLimit + grace;
    } else {
      effectiveLimit = absoluteLimit + grace;
    }

    const excess = speedKmH - effectiveLimit;

    if (excess > 0) {
      if (!this.openOverspeed) {
        this.openOverspeed = {
          type: 'overspeeding',
          startedAt: t,
          lastOverT: t,
          peak: excess,
          peakLocation: this.locationGetter(),
          meta: { speedKmH, limitKmH: effectiveLimit, excessKmH: excess },
        };
      } else {
        this.openOverspeed.lastOverT = t;
        if (excess > this.openOverspeed.peak) {
          this.openOverspeed.peak = excess;
          this.openOverspeed.peakLocation = this.locationGetter();
          this.openOverspeed.meta = { speedKmH, limitKmH: effectiveLimit, excessKmH: excess };
        }
      }
    } else if (this.openOverspeed) {
      const durationMs = this.openOverspeed.lastOverT - this.openOverspeed.startedAt;
      if (durationMs >= this.cfg.minOverspeedDurationS * 1000) {
        this.closeEvent(this.openOverspeed, this.openOverspeed.lastOverT);
      }
      this.openOverspeed = null;
    }
  }

  private updateAppStateDistraction(speedKmH: number, t: number): void {
    const movingFastEnough = speedKmH >= this.cfg.distractedMinSpeedKmH;

    if (this.appIsBackground && movingFastEnough) {
      const sinceBgMs = t - this.appBackgroundedAt;
      if (sinceBgMs >= this.cfg.distractedMinDurationS * 1000) {
        if (!this.openDistracted) {
          this.openDistracted = {
            type: 'distracted_driving',
            startedAt: this.appBackgroundedAt,
            lastOverT: t,
            peak: sinceBgMs / 1000,
            peakLocation: this.locationGetter(),
            meta: { source: 'app_background', speedKmH },
          };
        } else {
          this.openDistracted.lastOverT = t;
          this.openDistracted.peak = sinceBgMs / 1000;
        }
      }
    }
    // Foreground transition closes the event in onAppForeground().
  }

  /**
   * Weak secondary signal: sustained non-trivial linear accel that
   * does *not* correlate with vehicle accel. If the phone is mounted
   * and the car is cruising, linearMag stays <~0.3 m/s^2 (road noise).
   * If someone picks it up and starts tapping, linearMag spikes to
   * 0.7–2+ m/s^2 continuously.
   */
  private updatePhoneHandlingMotion(
    linearMag: number,
    vehicleLongitudinalMag: number,
    speedKmH: number,
    t: number,
  ): void {
    const MOTION_THRESHOLD = 0.7; // m/s^2 — above road-noise floor
    const CORRELATION_GAP = 0.4;  // m/s^2 — how much above vehicle accel
    const handled = linearMag > MOTION_THRESHOLD
      && linearMag - vehicleLongitudinalMag > CORRELATION_GAP
      && speedKmH >= this.cfg.distractedMinSpeedKmH;

    if (handled) {
      if (this.phoneHandledSinceMs === 0) this.phoneHandledSinceMs = t;
      const durMs = t - this.phoneHandledSinceMs;
      if (durMs >= 2000 && !this.openDistracted) {
        // Only open a motion-based distraction if we don't already have
        // an AppState-based one (that one is stronger signal).
        this.openDistracted = {
          type: 'distracted_driving',
          startedAt: this.phoneHandledSinceMs,
          lastOverT: t,
          peak: durMs / 1000,
          peakLocation: this.locationGetter(),
          meta: { source: 'phone_motion', speedKmH },
        };
      } else if (this.openDistracted && this.openDistracted.meta.source === 'phone_motion') {
        this.openDistracted.lastOverT = t;
        this.openDistracted.peak = (t - this.openDistracted.startedAt) / 1000;
      }
    } else {
      if (this.phoneHandledSinceMs !== 0 && t - this.phoneHandledSinceMs > 2000) {
        this.phoneHandledSinceMs = 0;
      }
      if (this.openDistracted && this.openDistracted.meta.source === 'phone_motion') {
        const durMs = this.openDistracted.lastOverT - this.openDistracted.startedAt;
        if (durMs >= this.cfg.distractedMinDurationS * 1000) {
          this.closeEvent(this.openDistracted, this.openDistracted.lastOverT);
        }
        this.openDistracted = null;
        this.phoneHandledSinceMs = 0;
      }
    }
  }

  private getOpen(type: SafetyEventType): OpenEvent | null {
    switch (type) {
      case 'hard_acceleration': return this.openAccel;
      case 'hard_braking': return this.openBrake;
      case 'hard_cornering': return this.openCorner;
      default: return null;
    }
  }

  private setOpen(type: SafetyEventType, ev: OpenEvent | null): void {
    switch (type) {
      case 'hard_acceleration': this.openAccel = ev; return;
      case 'hard_braking': this.openBrake = ev; return;
      case 'hard_cornering': this.openCorner = ev; return;
    }
  }

  private closeEvent(open: OpenEvent, endT: number): void {
    const severity = computeSeverity(open.type, open.peak, this.cfg);
    const ev: SafetyEvent = {
      id: `ev_${Date.now()}_${++this.eventIdCounter}`,
      type: open.type,
      startedAt: open.startedAt,
      endedAt: endT,
      peak: open.peak,
      severity,
      location: open.peakLocation,
      meta: open.meta,
    };
    this.listener?.(ev);
  }
}

/**
 * Severity mapping. 5 buckets based on ratio of peak-to-threshold.
 * For overspeeding and distraction the "peak" is excess km/h or
 * duration in seconds and the scale is different.
 *
 * Rationale for exponential bucket boundaries (1.0, 1.3, 1.6, 2.0, 2.5×):
 *   - 1.0–1.3× threshold: borderline. Could be a comfortable merge.
 *   - 1.3–1.6× threshold: clearly aggressive.
 *   - 1.6–2.0× threshold: risky.
 *   - 2.0–2.5× threshold: dangerous.
 *   - >2.5× threshold: emergency or reckless.
 */
function computeSeverity(
  type: SafetyEventType,
  peak: number,
  cfg: SafetyConfig,
): 1 | 2 | 3 | 4 | 5 {
  let ratio: number;
  switch (type) {
    case 'hard_acceleration': ratio = peak / cfg.hardAccelThreshold; break;
    case 'hard_braking':      ratio = peak / cfg.hardBrakeThreshold; break;
    case 'hard_cornering':    ratio = peak / cfg.hardCornerThreshold; break;
    case 'overspeeding':
      // peak is excess km/h over effective limit.
      if (peak < 5)  return 1;
      if (peak < 10) return 2;
      if (peak < 20) return 3;
      if (peak < 30) return 4;
      return 5;
    case 'distracted_driving':
      // peak is duration in seconds.
      if (peak < 5)  return 1;
      if (peak < 15) return 2;
      if (peak < 30) return 3;
      if (peak < 60) return 4;
      return 5;
    default: return 1;
  }

  if (ratio < 1.3) return 1;
  if (ratio < 1.6) return 2;
  if (ratio < 2.0) return 3;
  if (ratio < 2.5) return 4;
  return 5;
}

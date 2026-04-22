/**
 * RecoveryTracker — post-incident recovery bonus.
 *
 * =============================================================
 *  Concept
 * =============================================================
 *
 *  When a driver has a hard event (accel, brake, corner, or speeding),
 *  a 10-minute "recovery window" opens. If no further events of the
 *  same type occur within that window, the driver gets a 20% penalty
 *  reduction on the triggering event.
 *
 *  This rewards:
 *    - Awareness ("I was too aggressive there, let me settle down")
 *    - Self-correction after an incident
 *    - Drivers who have one mistake in an otherwise clean trip vs.
 *      those who repeat the same behaviour
 *
 * =============================================================
 *  Design choices and critique
 * =============================================================
 *
 *  WHY same-type only?
 *    A hard brake followed by hard cornering might both be symptoms
 *    of aggressive driving in a sequence. But a hard brake followed
 *    by 10 clean minutes followed by hard cornering on a different
 *    road might be two unrelated events. We track per-type to keep
 *    the logic granular.
 *
 *  WHY 10 minutes?
 *    The typical commute segment between traffic lights is 2–5 minutes.
 *    10 minutes ensures the driver has had enough opportunities to
 *    re-offend. Too short (< 5 min) and every event "recovers" even
 *    on a congested motorway; too long (> 20 min) and events from
 *    the first half of a long trip can never recover.
 *
 *  WHY 20% reduction instead of full forgiveness?
 *    The event still happened and still represents a real risk. Full
 *    forgiveness would allow gaming ("be perfect after each event").
 *    20% is modest enough to feel fair but not enough to make habitual
 *    bad driving look good.
 *
 *  CRITIQUE: This tracker cannot know whether the "clean" window was
 *  genuinely effort-driven or just that the driver hit no situations
 *  that would have triggered the event again (e.g., straight motorway
 *  after a hard corner on an exit ramp). We accept this imprecision
 *  because the alternative (requiring an equivalent opportunity to
 *  "prove" improvement) is computationally difficult to define.
 *
 *  CRITIQUE 2: Recovery windows are evaluated at trip end, not in real
 *  time, because future events are not known at event-fire time. This
 *  means the live trip score does NOT reflect recovery bonuses — only
 *  the final score does. The UI should note this.
 */

import { SafetyEvent, SafetyEventType, SafetyConfig, DEFAULT_SAFETY_CONFIG } from './types';

export class RecoveryTracker {
  private cfg: SafetyConfig;

  constructor(cfg: SafetyConfig = DEFAULT_SAFETY_CONFIG) {
    this.cfg = cfg;
  }

  updateConfig(patch: Partial<SafetyConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /**
   * At trip end, scan all events and return the set of event IDs that
   * earned the recovery bonus.
   *
   * An event earns the bonus if no event of the same type fires within
   * recoveryWindowMinutes after it ended.
   *
   * We exclude crash events (severity 5 is too serious for a bonus) and
   * severity >= 3 events (see rationale: grace for borderline events only).
   */
  computeRecoveredIds(events: SafetyEvent[]): Set<string> {
    const windowMs = this.cfg.recoveryWindowMinutes * 60_000;
    const recovered = new Set<string>();

    for (const ev of events) {
      // No recovery bonus for crashes or high-severity events.
      if (ev.type === 'crash' || ev.severity >= 3) continue;

      const windowEnd = ev.endedAt + windowMs;
      const hadRepeat = events.some(
        (other) =>
          other.id !== ev.id &&
          other.type === ev.type &&
          other.startedAt > ev.endedAt &&
          other.startedAt < windowEnd,
      );
      if (!hadRepeat) recovered.add(ev.id);
    }

    return recovered;
  }
}

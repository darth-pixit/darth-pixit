/**
 * Alert mapping shared by the in-app Driver screen and the fleet web dashboard.
 *
 * Severity → traffic light:
 *   1–2  → green   (informational, driver coaching)
 *   3    → yellow  (notable event, watch-list)
 *   4–5  → red     (critical, immediate attention or follow-up)
 *
 * Crash always overrides to red regardless of event severity field.
 *
 * The dashboard imports the JS-compiled equivalent at dashboard/alerts.js — the
 * two files MUST stay in sync. If you change thresholds here, mirror them there.
 */

import { SafetyEvent, SafetyEventType, WearSignal, WearSignalType } from './types';

export type AlertLevel = 'green' | 'yellow' | 'red';

export interface Alert {
  id: string;
  level: AlertLevel;
  title: string;
  detail: string;
  /** Source event/signal type, useful for grouping. */
  source: SafetyEventType | WearSignalType | 'crash';
  /** ms epoch — when the underlying event was detected. */
  at: number;
}

const EVENT_TITLE: Record<SafetyEventType, string> = {
  hard_acceleration: 'Hard acceleration',
  hard_braking: 'Hard braking',
  hard_cornering: 'Hard cornering',
  overspeeding: 'Overspeeding',
  distracted_driving: 'Phone in hand',
  drowsy_driving: 'Drowsiness signs',
  crash: 'Crash detected',
};

const WEAR_TITLE: Record<WearSignalType, string> = {
  sustained_high_load: 'Sustained high engine load',
  coolant_spike: 'Coolant temperature spike',
  high_rpm_ratio: 'Engine near redline',
  seatbelt_off: 'Seatbelt unfastened',
  tpms_low: 'Tire pressure low',
};

export function levelForSeverity(severity: 1 | 2 | 3 | 4 | 5): AlertLevel {
  if (severity >= 4) return 'red';
  if (severity === 3) return 'yellow';
  return 'green';
}

export const ALERT_COLORS: Record<AlertLevel, string> = {
  green: '#22C55E',
  yellow: '#F59E0B',
  red: '#EF4444',
};

/** Map a 0–100 safety score to the same traffic-light bands the alerts use. */
export function levelForScore(score: number): AlertLevel {
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  return 'red';
}

export function colorForScore(score: number): string {
  return ALERT_COLORS[levelForScore(score)];
}

export function alertFromEvent(e: SafetyEvent): Alert {
  const isCrash = e.type === 'crash';
  return {
    id: e.id,
    level: isCrash ? 'red' : levelForSeverity(e.severity),
    title: EVENT_TITLE[e.type],
    detail: detailForEvent(e),
    source: e.type,
    at: e.endedAt,
  };
}

export function alertFromWear(w: WearSignal): Alert {
  return {
    id: `wear-${w.type}-${w.detectedAt}`,
    level: levelForSeverity(w.severity),
    title: WEAR_TITLE[w.type],
    detail: `Value ${w.value.toFixed(0)} (threshold ${w.threshold.toFixed(0)}) for ${Math.round(w.durationS)}s`,
    source: w.type,
    at: w.detectedAt,
  };
}

function detailForEvent(e: SafetyEvent): string {
  switch (e.type) {
    case 'hard_acceleration':
    case 'hard_braking':
    case 'hard_cornering':
      return `Peak ${e.peak.toFixed(1)} m/s² · severity ${e.severity}/5`;
    case 'overspeeding':
      return `Excess ${e.peak.toFixed(0)} km/h over limit · severity ${e.severity}/5`;
    case 'distracted_driving':
    case 'drowsy_driving':
      return `Sustained ${Math.round(e.peak)}s · severity ${e.severity}/5`;
    case 'crash':
      return `Peak impact ${e.peak.toFixed(1)} m/s² — emergency review required`;
  }
}

/** Roll up a list of alerts into the worst level present. Returns 'green' if empty. */
export function worstLevel(alerts: Alert[]): AlertLevel {
  if (alerts.some((a) => a.level === 'red')) return 'red';
  if (alerts.some((a) => a.level === 'yellow')) return 'yellow';
  return 'green';
}

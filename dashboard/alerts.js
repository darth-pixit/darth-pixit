/**
 * Mirror of src/safety/alerts.ts in plain JS for the dashboard's Node server
 * and browser code. If you change thresholds in the TS module, change them here.
 *
 *   1–2 → green   (informational)
 *   3   → yellow  (notable)
 *   4–5 → red     (critical)
 *   crash → red   (always)
 */

const ALERT_COLORS = { green: '#22C55E', yellow: '#F59E0B', red: '#EF4444' };

const EVENT_TITLE = {
  hard_acceleration: 'Hard acceleration',
  hard_braking: 'Hard braking',
  hard_cornering: 'Hard cornering',
  overspeeding: 'Overspeeding',
  distracted_driving: 'Phone in hand',
  drowsy_driving: 'Drowsiness signs',
  crash: 'Crash detected',
};

const WEAR_TITLE = {
  sustained_high_load: 'Sustained high engine load',
  coolant_spike: 'Coolant temperature spike',
  high_rpm_ratio: 'Engine near redline',
  seatbelt_off: 'Seatbelt unfastened',
  tpms_low: 'Tire pressure low',
};

function levelForSeverity(s) {
  if (s >= 4) return 'red';
  if (s === 3) return 'yellow';
  return 'green';
}

function detailForEvent(e) {
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
  return '';
}

function alertFromEvent(e) {
  return {
    id: e.id,
    level: e.type === 'crash' ? 'red' : levelForSeverity(e.severity),
    title: EVENT_TITLE[e.type] || e.type,
    detail: detailForEvent(e),
    source: e.type,
    at: e.endedAt || e.startedAt,
  };
}

function alertFromWear(w) {
  return {
    id: `wear-${w.type}-${w.detectedAt}`,
    level: levelForSeverity(w.severity),
    title: WEAR_TITLE[w.type] || w.type,
    detail: `Value ${w.value.toFixed(0)} (threshold ${w.threshold.toFixed(0)}) for ${Math.round(w.durationS)}s`,
    source: w.type,
    at: w.detectedAt,
  };
}

function worstLevel(alerts) {
  if (alerts.some((a) => a.level === 'red')) return 'red';
  if (alerts.some((a) => a.level === 'yellow')) return 'yellow';
  return 'green';
}

module.exports = {
  ALERT_COLORS,
  levelForSeverity,
  alertFromEvent,
  alertFromWear,
  worstLevel,
};

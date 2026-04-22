// ─────────────────────────────────────────────────────────────────────────────
// Severity levels and scenario catalog for production alerting.
//
// How to read:
//   Severity    → Sentry event level → expected response
//   CRITICAL    → fatal  → page on-call immediately (#incidents)
//   HIGH        → error  → Slack alert within minutes (#alerts)
//   MEDIUM      → warning→ alert only when error rate threshold is crossed (#monitoring)
//   LOW         → info   → captured for debugging only; no alert rule
//
// "When to fire" is expressed as an error-rate percentage, not a raw count,
// so thresholds stay meaningful as traffic scales. Two flavours:
//
//   rateThreshold      — alert when errors exceed `pct` % of `of`-type events
//                        within a rolling `windowMinutes` window.
//   crashFreeRateBelow — alert when Sentry's crash_free_rate(sessions) metric
//                        drops below this %. Mobile industry baselines:
//                          ≥ 99.5 % = healthy
//                          < 99.5 % = degraded  (HIGH)
//                          < 99.0 % = critical  (CRITICAL)
//
// See the "Sentry alert rule cheatsheet" at the bottom of this file for exact
// Sentry UI configuration steps.
// ─────────────────────────────────────────────────────────────────────────────

export enum Severity {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

/** Maps our severity to the corresponding Sentry event level. */
export const SENTRY_LEVEL: Record<Severity, 'fatal' | 'error' | 'warning' | 'info'> = {
  [Severity.CRITICAL]: 'fatal',
  [Severity.HIGH]: 'error',
  [Severity.MEDIUM]: 'warning',
  [Severity.LOW]: 'info',
};

export interface RateThreshold {
  /**
   * Alert fires when this percentage of the denominator events fail.
   * e.g. pct: 2 means "more than 2 % of connection attempts errored".
   */
  pct: number;
  /**
   * Denominator that defines what the percentage is calculated against.
   *   sessions            → % of user sessions affected (use crash_free_rate or custom)
   *   connection_attempts → % of OBD connect() calls that resulted in error
   *   auth_attempts       → % of sendOTP / confirmOTP calls that errored
   *   events              → % of raw captured events (for noisy signals)
   */
  of: 'sessions' | 'connection_attempts' | 'auth_attempts' | 'events';
  /** Rolling window over which the rate is measured. */
  windowMinutes: number;
}

export interface AlertPolicy {
  /** True → fire a notification the moment the first event arrives. */
  notifyImmediately: boolean;
  /** Slack/PagerDuty channel to target in your Sentry alert rule. */
  slackChannel?: string;
  /**
   * Percentage-based trigger. Omit for CRITICAL scenarios that should fire
   * on the first occurrence regardless of rate.
   */
  rateThreshold?: RateThreshold;
  /**
   * Session-level crash health gate. Alert when Sentry's crash_free_rate(sessions)
   * drops below this value. Only meaningful for CRITICAL scenarios that represent
   * complete session failures (app crash, total connection loss).
   */
  crashFreeRateBelow?: number;
}

export interface AlertScenario {
  id: string;
  severity: Severity;
  title: string;
  /** One-line explanation of what went wrong and why it matters. */
  description: string;
  alertPolicy: AlertPolicy;
}

// ─── CRITICAL ────────────────────────────────────────────────────────────────
// The app or a core feature is completely broken. Page someone now.

export const SCENARIO_APP_CRASH: AlertScenario = {
  id: 'app_crash',
  severity: Severity.CRITICAL,
  title: 'App crash — unhandled exception in render tree',
  description:
    'React ErrorBoundary caught a fatal exception. The user sees a blank/error screen and cannot use the app.',
  alertPolicy: {
    notifyImmediately: true,
    slackChannel: '#incidents',
    // Alert the moment crash-free sessions drop below the healthy baseline.
    crashFreeRateBelow: 99.5,
  },
};

export const SCENARIO_OBD_ADAPTER_NOT_FOUND: AlertScenario = {
  id: 'obd_adapter_not_found',
  severity: Severity.CRITICAL,
  title: 'OBD adapter not found after BLE scan',
  description:
    'A 15-second BLE scan completed without finding a compatible OBD adapter. The core app feature is unavailable.',
  alertPolicy: {
    notifyImmediately: true,
    slackChannel: '#incidents',
    // > 2 % of connection attempts failing in 15 min = systemic BLE issue, not user error.
    rateThreshold: { pct: 2.0, of: 'connection_attempts', windowMinutes: 15 },
  },
};

export const SCENARIO_OBD_CONNECTION_EXHAUSTED: AlertScenario = {
  id: 'obd_connection_exhausted',
  severity: Severity.CRITICAL,
  title: 'OBD connection exhausted — all retries failed',
  description:
    'All 8 exponential-backoff reconnect attempts failed. The user is stuck on the error screen with no automatic recovery.',
  alertPolicy: {
    notifyImmediately: true,
    slackChannel: '#incidents',
    // Any session that reaches this state is fully lost. Alert below the critical threshold.
    crashFreeRateBelow: 99.0,
  },
};

// ─── HIGH ────────────────────────────────────────────────────────────────────
// Significant user impact. Alert within a few minutes.

export const SCENARIO_ECU_NOT_RESPONDING: AlertScenario = {
  id: 'ecu_not_responding',
  severity: Severity.HIGH,
  title: 'ECU not responding after OBD probe',
  description:
    'Connected to the OBD adapter but two consecutive ECU probe attempts (0100) failed. '
    + 'Likely causes: ignition is off, wrong OBD protocol, or broken vehicle wiring.',
  alertPolicy: {
    notifyImmediately: false,
    slackChannel: '#alerts',
    // 3 % failure is the ceiling for "user had ignition off"; above that is a protocol bug.
    rateThreshold: { pct: 3.0, of: 'connection_attempts', windowMinutes: 30 },
  },
};

export const SCENARIO_OBD_KEEPALIVE_FAILED: AlertScenario = {
  id: 'obd_keepalive_failed',
  severity: Severity.HIGH,
  title: 'OBD keepalive (ATI) timed out',
  description:
    'The periodic ATI keepalive command timed out during active polling, forcing a reconnect cycle. '
    + 'Indicates an unstable BLE link or adapter firmware issue.',
  alertPolicy: {
    notifyImmediately: false,
    slackChannel: '#alerts',
    // > 2 % of active sessions hitting keepalive failure in 15 min = BLE regression.
    rateThreshold: { pct: 2.0, of: 'sessions', windowMinutes: 15 },
  },
};

export const SCENARIO_AUTH_SEND_OTP_FAILED: AlertScenario = {
  id: 'auth_send_otp_failed',
  severity: Severity.HIGH,
  title: 'OTP send failed',
  description:
    'Firebase could not dispatch an OTP SMS. New users cannot sign in. '
    + 'Check Firebase Auth console and SMS quota.',
  alertPolicy: {
    notifyImmediately: false,
    slackChannel: '#alerts',
    // 5 % of SMS dispatch attempts failing = Firebase quota or network issue.
    rateThreshold: { pct: 5.0, of: 'auth_attempts', windowMinutes: 10 },
  },
};

export const SCENARIO_AUTH_VERIFY_OTP_FAILED: AlertScenario = {
  id: 'auth_verify_otp_failed',
  severity: Severity.HIGH,
  title: 'OTP verification rejected by Firebase',
  description:
    'The user submitted a code that Firebase rejected. May be an expired token, wrong code, '
    + 'or a Firebase Auth service issue if the rate is elevated.',
  alertPolicy: {
    notifyImmediately: false,
    slackChannel: '#alerts',
    // 10 % threshold: wrong codes are expected from real users; only a spike signals
    // a Firebase Auth outage or a broken verification flow.
    rateThreshold: { pct: 10.0, of: 'auth_attempts', windowMinutes: 10 },
  },
};

// ─── MEDIUM ──────────────────────────────────────────────────────────────────
// Degraded state that is self-recoverable. Alert only if the rate spikes.

export const SCENARIO_OBD_RECONNECTING: AlertScenario = {
  id: 'obd_reconnecting',
  severity: Severity.MEDIUM,
  title: 'OBD reconnect attempt started',
  description:
    'The BLE device disconnected unexpectedly and the app is retrying with exponential backoff. '
    + 'A handful of these per session is normal; a sustained spike is not.',
  alertPolicy: {
    notifyImmediately: false,
    slackChannel: '#monitoring',
    // BLE reconnects happen on phone-lock, brief signal drops, etc. 20 % over an hour
    // is the threshold where it becomes a firmware or driver regression signal.
    rateThreshold: { pct: 20.0, of: 'sessions', windowMinutes: 60 },
  },
};

export const SCENARIO_AUTH_RESEND_OTP_FAILED: AlertScenario = {
  id: 'auth_resend_otp_failed',
  severity: Severity.MEDIUM,
  title: 'OTP resend failed',
  description:
    'The user tapped "Resend OTP" but Firebase returned an error. '
    + 'Could be a rate-limit or transient network issue.',
  alertPolicy: {
    notifyImmediately: false,
    slackChannel: '#monitoring',
    // 10 % of resend attempts failing in 30 min suggests a Firebase rate-limit.
    rateThreshold: { pct: 10.0, of: 'auth_attempts', windowMinutes: 30 },
  },
};

// ─── LOW ─────────────────────────────────────────────────────────────────────
// Minor issues captured for debugging. No alert rule; visible in Sentry dashboards only.

export const SCENARIO_OBD_CACHED_DEVICE_MISS: AlertScenario = {
  id: 'obd_cached_device_miss',
  severity: Severity.LOW,
  title: 'Cached device ID miss — fell back to BLE scan',
  description:
    'The stored OBD device ID failed to connect so the app ran a fresh BLE scan. '
    + 'Normal after adapter power cycles; a high rate may indicate ID churn.',
  alertPolicy: {
    notifyImmediately: false,
    // No rateThreshold — captured for debugging dashboards, not for alerting.
  },
};

export const SCENARIO_OBD_PID_TIMEOUT: AlertScenario = {
  id: 'obd_pid_timeout',
  severity: Severity.LOW,
  title: 'OBD PID command timed out (non-fatal)',
  description:
    'A single PID request (e.g. RPM, MAF) timed out. The poll loop skips and continues; '
    + 'one-off timeouts are harmless. A sustained rate signals link degradation.',
  alertPolicy: {
    notifyImmediately: false,
    // No rateThreshold — individual timeouts are noise; visible in Sentry dashboards only.
  },
};

// ─── Catalog ─────────────────────────────────────────────────────────────────

export const ALL_SCENARIOS: AlertScenario[] = [
  SCENARIO_APP_CRASH,
  SCENARIO_OBD_ADAPTER_NOT_FOUND,
  SCENARIO_OBD_CONNECTION_EXHAUSTED,
  SCENARIO_ECU_NOT_RESPONDING,
  SCENARIO_OBD_KEEPALIVE_FAILED,
  SCENARIO_AUTH_SEND_OTP_FAILED,
  SCENARIO_AUTH_VERIFY_OTP_FAILED,
  SCENARIO_OBD_RECONNECTING,
  SCENARIO_AUTH_RESEND_OTP_FAILED,
  SCENARIO_OBD_CACHED_DEVICE_MISS,
  SCENARIO_OBD_PID_TIMEOUT,
];

// ─────────────────────────────────────────────────────────────────────────────
// Sentry alert rule cheatsheet
//
// In your Sentry project go to Alerts → Create Alert → Metric Alert.
//
// ── CRITICAL: crash-free session rate (app_crash, obd_connection_exhausted) ─
//   Metric:    crash_free_rate(sessions)
//   Condition: is below <crashFreeRateBelow>%
//   Window:    1 hour  (rolling)
//   Action:    notify #incidents + PagerDuty
//
// ── CRITICAL / HIGH / MEDIUM: error rate (all rateThreshold scenarios) ──────
//   Metric:    percentage(event.count(), sessions)  ← or custom transaction metric
//   Filter:    tag:scenario_id = "<scenario.id>"
//   Condition: is above <rateThreshold.pct>%
//   Window:    <rateThreshold.windowMinutes> minutes
//   Action:    notify the channel in slackChannel
//
//   Note: Sentry's free-tier Metric Alerts support session-based metrics.
//   For `connection_attempts` and `auth_attempts` denominators you need to emit
//   a custom metric counter (e.g. Sentry.metrics.increment('obd.connect.attempt'))
//   at each attempt site, then build the alert as
//   "percentage(errors, obd.connect.attempt) > pct".
//
// ── LOW scenarios ────────────────────────────────────────────────────────────
//   No alert rules. Add scenario_id as a filter in Sentry's Issues or
//   Discover dashboards for ad-hoc debugging.
// ─────────────────────────────────────────────────────────────────────────────

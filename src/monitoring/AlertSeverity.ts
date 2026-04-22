// ─────────────────────────────────────────────────────────────────────────────
// Severity levels and scenario catalog for production alerting.
//
// How to read:
//   Severity    → Sentry event level → expected response
//   CRITICAL    → fatal  → page on-call immediately (#incidents)
//   HIGH        → error  → Slack alert within minutes (#alerts)
//   MEDIUM      → warning→ alert only when frequency threshold is crossed (#monitoring)
//   LOW         → info   → captured for debugging; daily digest at most
//
// For each scenario, alertPolicy.frequencyThreshold describes the Sentry alert
// rule you should configure: "alert if N events occur within M minutes".
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

export interface AlertPolicy {
  /** True → fire a notification the moment the first event arrives. */
  notifyImmediately: boolean;
  /** Slack/PagerDuty channel to target in your Sentry alert rule. */
  slackChannel?: string;
  /**
   * Fire an alert when `count` events occur within `windowMinutes`.
   * Omit for CRITICAL — those always alert on the first occurrence.
   */
  frequencyThreshold?: { count: number; windowMinutes: number };
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
    // Alert immediately on first occurrence; if it spikes it signals a wider BLE issue.
    frequencyThreshold: { count: 5, windowMinutes: 60 },
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
    frequencyThreshold: { count: 5, windowMinutes: 30 },
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
    frequencyThreshold: { count: 5, windowMinutes: 15 },
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
    frequencyThreshold: { count: 3, windowMinutes: 10 },
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
    // Individual user mistakes are expected; alert only on a spike.
    frequencyThreshold: { count: 10, windowMinutes: 10 },
  },
};

// ─── MEDIUM ──────────────────────────────────────────────────────────────────
// Degraded state that is self-recoverable. Alert only if volume spikes.

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
    frequencyThreshold: { count: 20, windowMinutes: 60 },
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
    frequencyThreshold: { count: 5, windowMinutes: 30 },
  },
};

// ─── LOW ─────────────────────────────────────────────────────────────────────
// Minor issues captured for debugging. No immediate notification needed.

export const SCENARIO_OBD_CACHED_DEVICE_MISS: AlertScenario = {
  id: 'obd_cached_device_miss',
  severity: Severity.LOW,
  title: 'Cached device ID miss — fell back to BLE scan',
  description:
    'The stored OBD device ID failed to connect so the app ran a fresh BLE scan. '
    + 'Normal after adapter power cycles; a high rate may indicate ID churn.',
  alertPolicy: {
    notifyImmediately: false,
    slackChannel: '#monitoring',
    frequencyThreshold: { count: 50, windowMinutes: 60 },
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
    frequencyThreshold: { count: 100, windowMinutes: 5 },
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

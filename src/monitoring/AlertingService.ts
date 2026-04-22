import * as Sentry from '@sentry/react-native';
import { Severity, SENTRY_LEVEL, AlertScenario } from './AlertSeverity';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
//
// 1. Create a project at https://sentry.io and copy the DSN.
// 2. Set SENTRY_DSN in your CI/CD environment or a .env file loaded via
//    react-native-config / babel-plugin-transform-inline-environment-variables.
// 3. Run `npx @sentry/wizard@latest -i reactNative` to finish native setup
//    (uploads source maps, patches android/ios build files).
// ─────────────────────────────────────────────────────────────────────────────

// Replace with your real DSN or inject via build environment.
const SENTRY_DSN = '__YOUR_SENTRY_DSN__';

export function initAlerting() {
  if (!SENTRY_DSN || SENTRY_DSN === '__YOUR_SENTRY_DSN__') {
    console.warn('[Alerting] Sentry DSN not configured — crash reporting disabled.');
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    // Capture 10 % of sessions for performance monitoring.
    tracesSampleRate: 0.1,
    // Attach JS/native stack traces to every event.
    attachStacktrace: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Core alert function
// ─────────────────────────────────────────────────────────────────────────────

export type AlertContext = Record<string, string | number | boolean | undefined | null>;

/**
 * Report a production scenario to Sentry with the correct severity level and
 * metadata so alert rules and dashboards can filter by scenario ID.
 *
 * Usage:
 *   alert(SCENARIO_ECU_NOT_RESPONDING, error, { attempt: 2 });
 *   alert(SCENARIO_OBD_RECONNECTING);
 */
export function alert(
  scenario: AlertScenario,
  error?: Error | unknown,
  ctx?: AlertContext,
): void {
  const level = SENTRY_LEVEL[scenario.severity];

  Sentry.withScope((scope) => {
    scope.setLevel(level);
    scope.setTag('scenario_id', scenario.id);
    scope.setTag('severity', scenario.severity);
    if (scenario.alertPolicy.slackChannel) {
      scope.setTag('slack_channel', scenario.alertPolicy.slackChannel);
    }
    scope.setExtra('alert_policy', scenario.alertPolicy);
    scope.setExtra('scenario_title', scenario.title);

    if (ctx) {
      Object.entries(ctx).forEach(([k, v]) => scope.setExtra(k, v));
    }

    if (error instanceof Error) {
      Sentry.captureException(error);
    } else if (error !== undefined) {
      // Wrap non-Error throwables so Sentry can display them.
      Sentry.captureException(new Error(String(error)));
    } else {
      Sentry.captureMessage(scenario.title, level);
    }
  });

  // Mirror to the console so dev builds always have visibility.
  const logFn =
    scenario.severity === Severity.CRITICAL || scenario.severity === Severity.HIGH
      ? console.error
      : console.warn;

  logFn(
    `[${scenario.severity.toUpperCase()}] ${scenario.id}: ${scenario.title}`,
    ctx ?? '',
  );
}

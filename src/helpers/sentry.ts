import * as Sentry from '@sentry/react';

/** The build-time values that configure Sentry, read from `import.meta.env` by `initSentry`. */
export type SentryEnvironment = {
  /** `import.meta.env.VITE_SENTRY_DSN`. Without it, Sentry stays off. */
  dsn?: string;
  /** `import.meta.env.DEV`. */
  isDev: boolean;
  /** `import.meta.env.VITE_SENTRY_ENVIRONMENT`, falling back to `import.meta.env.MODE`. */
  environment: string;
  /** `import.meta.env.VITE_SENTRY_RELEASE`. */
  release?: string;
  /**
   * `import.meta.env.VITE_SENTRY_TUNNEL`: the URL of the relay that forwards events to Sentry, which ad blockers
   * do not block as they block Sentry's own hosts. Without it, events go to Sentry directly, which the CSP of the
   * production hosts does not allow.
   */
  tunnel?: string;
};

/** The SDK's default integration that records each `console` call as a breadcrumb. */
const CONSOLE_INTEGRATION_NAME = 'Console';

/** The sample rate for traces: every trace on a development build, 10% otherwise. */
export const DEV_TRACES_SAMPLE_RATE = 1.0;
export const PRODUCTION_TRACES_SAMPLE_RATE = 0.1;

/**
 * The options for `Sentry.init`, or `undefined` when no DSN is configured. Local runs, tests and fork builds
 * set no DSN, so they send nothing.
 *
 * Nothing is redacted: errors, breadcrumbs and traces can carry wallet addresses, ENS names and transaction
 * hashes, which are public on chain and needed to debug a report.
 */
export function buildSentryOptions({
  dsn,
  isDev,
  environment,
  release,
  tunnel,
}: SentryEnvironment): Sentry.BrowserOptions | undefined {
  if (!dsn) {
    return undefined;
  }
  return {
    dsn,
    environment,
    release: release || undefined,
    tunnel: tunnel || undefined,
    // Console output is not sent as breadcrumbs. The app logs whole wallet, screening and RPC errors, which
    // say more than an error report needs.
    integrations: (defaultIntegrations) => [
      ...defaultIntegrations.filter((integration) => integration.name !== CONSOLE_INTEGRATION_NAME),
      Sentry.browserTracingIntegration(),
    ],
    tracesSampleRate: isDev ? DEV_TRACES_SAMPLE_RATE : PRODUCTION_TRACES_SAMPLE_RATE,
    // Add no trace headers to outgoing requests. The API, RPC and screening hosts are cross-origin, and an
    // unexpected header fails their CORS preflight.
    tracePropagationTargets: [],
    // Keep the app's own fetch errors unchanged. Wallet error handling reads their messages.
    enhanceFetchErrorMessages: 'report-only',
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
    },
  };
}

let sentryEnabled = false;

/** Whether `initSentry` started Sentry. `main.tsx` adds React's error hooks only when it did. */
export function isSentryEnabled(): boolean {
  return sentryEnabled;
}

/** Starts Sentry from the build's `VITE_SENTRY_*` values. Does nothing when `VITE_SENTRY_DSN` is unset. */
export function initSentry(): void {
  const options = buildSentryOptions({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    isDev: Boolean(import.meta.env.DEV),
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE || 'production',
    release: import.meta.env.VITE_SENTRY_RELEASE,
    tunnel: import.meta.env.VITE_SENTRY_TUNNEL,
  });
  if (!options) {
    return;
  }
  Sentry.init(options);
  sentryEnabled = true;
}

/**
 * The `createRoot` options that report React's errors to Sentry, or none when Sentry is off. Each handler
 * still logs to the console, as React's default handlers do.
 */
export function sentryRootOptions() {
  if (!sentryEnabled) {
    return undefined;
  }
  return {
    onUncaughtError: Sentry.reactErrorHandler((error, errorInfo) => {
      console.error('Uncaught error', error, errorInfo.componentStack);
    }),
    onCaughtError: Sentry.reactErrorHandler((error, errorInfo) => {
      console.error('Caught error', error, errorInfo.componentStack);
    }),
    onRecoverableError: Sentry.reactErrorHandler((error) => {
      console.error('Recoverable error', error);
    }),
  };
}

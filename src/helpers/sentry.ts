import * as Sentry from '@sentry/react';

/**
 * Hex strings of 40 or more digits after `0x`: wallet and contract addresses (40), transaction hashes (64),
 * signatures and calldata. Calldata encodes addresses, so every long hex string is redacted, not only
 * addresses and hashes.
 */
const HEX_PATTERN = /0x[0-9a-fA-F]{40,}/g;

/** ENS names such as `alice.eth` or `pay.alice.eth`. */
const ENS_PATTERN = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth\b/gi;

/** Objects nested deeper than this are replaced, so that a cyclic or huge payload cannot stall the app. */
const MAX_REDACTION_DEPTH = 20;

function redactHex(hex: string): string {
  const digitCount = hex.length - 2;
  if (digitCount === 40) {
    return '0x[address]';
  }
  if (digitCount === 64) {
    return '0x[hash]';
  }
  return '0x[hex]';
}

/** Replaces wallet identity in a string: addresses, hashes, other long hex data and ENS names. */
export function redactWalletIdentityText(text: string): string {
  return text.replace(HEX_PATTERN, redactHex).replace(ENS_PATTERN, '[ens]');
}

function redactValue(value: unknown, depth: number, visited: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactWalletIdentityText(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_REDACTION_DEPTH || visited.has(value)) {
    return '[redacted]';
  }
  visited.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, visited));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Sentry payloads are plain data. Anything else, such as an Error or a class instance, is reduced to its
    // redacted text rather than walked.
    return redactWalletIdentityText(String(value));
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[redactWalletIdentityText(key)] = redactValue(item, depth + 1, visited);
  }
  return redacted;
}

/**
 * Returns a copy of a Sentry payload with wallet identity removed from every string and object key.
 *
 * The app collects no wallet identity data (see `docs/anchorage-release-runbook.md`). Wallet, viem and RPC
 * errors, request URLs and console breadcrumbs routinely carry addresses, transaction hashes and calldata, so
 * every event, transaction and breadcrumb passes through this before it leaves the browser.
 */
export function redactWalletIdentity<T>(payload: T): T {
  return redactValue(payload, 0, new WeakSet()) as T;
}

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
};

/** The sample rate for traces: every trace on a development build, 10% otherwise. */
export const DEV_TRACES_SAMPLE_RATE = 1.0;
export const PRODUCTION_TRACES_SAMPLE_RATE = 0.1;

/**
 * The options for `Sentry.init`, or `undefined` when no DSN is configured. Local runs, tests and fork builds
 * set no DSN, so they send nothing.
 */
export function buildSentryOptions({
  dsn,
  isDev,
  environment,
  release,
}: SentryEnvironment): Sentry.BrowserOptions | undefined {
  if (!dsn) {
    return undefined;
  }
  return {
    dsn,
    environment,
    release: release || undefined,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: isDev ? DEV_TRACES_SAMPLE_RATE : PRODUCTION_TRACES_SAMPLE_RATE,
    // Add no trace headers to outgoing requests. The API, RPC and screening hosts are cross-origin, and an
    // unexpected header would fail their CORS preflight.
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
    beforeSend: (event) => redactWalletIdentity(event),
    beforeSendTransaction: (event) => redactWalletIdentity(event),
    beforeBreadcrumb: (breadcrumb) => redactWalletIdentity(breadcrumb),
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

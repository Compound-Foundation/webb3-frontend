import * as Sentry from '@sentry/react';

/**
 * Hex strings of 40 or more digits after `0x`: wallet and contract addresses (40), transaction hashes (64),
 * signatures and calldata. Calldata encodes addresses, so every long hex string is redacted, not only
 * addresses and hashes.
 */
const PREFIXED_HEX_PATTERN = /0x[0-9a-fA-F]{40,}/g;

/** Runs of 40 or more hex digits without `0x`, as some wallet libraries print addresses and hashes. */
const BARE_HEX_PATTERN = /(?<![0-9a-zA-Z])[0-9a-fA-F]{40,}(?![0-9a-zA-Z])/g;

/**
 * A character of an ENS label. ENS allows `$` and an apostrophe besides letters, digits, `_` and `-`. Any
 * non-ASCII character counts, so that accents, joined emoji, flags and
 * keycaps are redacted whole. Unicode properties would miss some of them.
 */
const ENS_LABEL_CHARACTER = String.raw`(?:[a-z0-9_$'-]|[#*]\uFE0F?\u20E3|[^\s\x00-\x7F])`;

/**
 * ENS names in any case, such as `alice.eth`, `pay.alice.eth`, `Alice.ETH` or `🇺🇸.eth`. A name may be followed
 * by punctuation, such as a closing quote, but not by a letter or digit: `alice.ethereum` is not a name.
 */
const ENS_PATTERN = new RegExp(
  `(?<!${ENS_LABEL_CHARACTER})(?:${ENS_LABEL_CHARACTER}+\\.)+eth(?![\\p{L}\\p{N}\\p{M}_-])`,
  'giu'
);

/** An address is 20 bytes, so a shorter run of bytes cannot hold one. */
const MIN_REDACTED_BYTE_COUNT = 20;

/** Bytes printed as decimal numbers, as `String()` prints a typed array: `82,144,132` and so on. */
const DECIMAL_BYTES_PATTERN = new RegExp(
  `(?<![\\d.])(?:\\d{1,3},\\s?){${MIN_REDACTED_BYTE_COUNT - 1},}\\d{1,3}(?![\\d.])`,
  'g'
);

/** Objects nested deeper than this are replaced, so that a huge payload cannot stall the app. */
const MAX_REDACTION_DEPTH = 20;

/** Keys or items an object or array keeps. The rest are dropped, for the same reason. */
const MAX_REDACTION_BREADTH = 1000;

function redactPrefixedHex(hex: string): string {
  const digitCount = hex.length - 2;
  if (digitCount === 40) {
    return '0x[address]';
  }
  if (digitCount === 64) {
    return '0x[hash]';
  }
  return '0x[hex]';
}

/** Replaces wallet identity in a string: addresses, hashes, other long hex data, byte lists and ENS names. */
export function redactWalletIdentityText(text: string): string {
  return text
    .replace(PREFIXED_HEX_PATTERN, redactPrefixedHex)
    .replace(BARE_HEX_PATTERN, '[hex]')
    .replace(DECIMAL_BYTES_PATTERN, '[bytes]')
    .replace(ENS_PATTERN, '[ens]');
}

function isByte(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255;
}

/** Whether the values are bytes that could hold an address. */
function isByteList(values: unknown[]): boolean {
  return values.length >= MIN_REDACTED_BYTE_COUNT && values.every(isByte);
}

/**
 * Whether an object lists bytes under the keys `0`, `1`, `2` and so on. The SDK turns a typed array into
 * such an object before the app can see it.
 */
function isIndexedByteList(value: object): boolean {
  const entries = Object.entries(value);
  return entries.every(([key], index) => key === String(index)) && isByteList(entries.map(([, item]) => item));
}

type Redaction = {
  /** The build's release name. A commit SHA looks like bare hex, and must reach Sentry unchanged. */
  release?: string;
  /** The objects that contain the value being redacted, so that a cycle ends. */
  ancestors: WeakSet<object>;
};

function redactValue(value: unknown, depth: number, redaction: Redaction): unknown {
  if (typeof value === 'string') {
    return value === redaction.release ? value : redactWalletIdentityText(value);
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    // JSON has no form for these, so the SDK would drop them too.
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // Raw bytes can hold an address, and `String()` would print them as decimal numbers.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return '[bytes]';
  }
  const { ancestors } = redaction;
  if (depth >= MAX_REDACTION_DEPTH || ancestors.has(value)) {
    return '[redacted]';
  }
  if ('toJSON' in value && typeof value.toJSON === 'function') {
    // Redact what the SDK would serialize. A copy that kept `toJSON` would serialize the original instead.
    ancestors.add(value);
    const redacted = redactValue(value.toJSON(), depth + 1, redaction);
    ancestors.delete(value);
    return redacted;
  }
  if (Array.isArray(value)) {
    if (isByteList(value)) {
      return '[bytes]';
    }
    ancestors.add(value);
    const redacted = value.slice(0, MAX_REDACTION_BREADTH).map((item) => redactValue(item, depth + 1, redaction));
    ancestors.delete(value);
    return redacted;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Sentry payloads are plain data. Anything else, such as an Error or a class instance, is reduced to its
    // redacted text rather than walked.
    return redactWalletIdentityText(String(value));
  }
  if (isIndexedByteList(value)) {
    return '[bytes]';
  }
  ancestors.add(value);
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_REDACTION_BREADTH)) {
    redacted[redactWalletIdentityText(key)] = redactValue(item, depth + 1, redaction);
  }
  ancestors.delete(value);
  return redacted;
}

/**
 * Returns a copy of a Sentry payload with wallet identity removed from every string and object key. A string
 * equal to `release` is kept.
 *
 * The app collects no wallet identity data (see `docs/anchorage-release-runbook.md`). Wallet, viem and RPC
 * errors, request URLs and console breadcrumbs often carry addresses, hashes and calldata. Everything Sentry
 * sends therefore passes through this function before it leaves the browser.
 */
export function redactWalletIdentity<T>(payload: T, release?: string): T {
  return redactValue(payload, 0, { release, ancestors: new WeakSet() }) as T;
}

/** The `transport` option of `Sentry.init`: a function that makes the object that sends envelopes. */
export type SentryTransportFactory = NonNullable<Sentry.BrowserOptions['transport']>;

/**
 * Wraps a transport so that it redacts each envelope, headers included, before sending it.
 *
 * Redaction happens here and not in `beforeSend`, `beforeSendSpan` or `beforeBreadcrumb`, because the SDK
 * adds data after those hooks run. One example is the root span's name in a span envelope's `trace` header.
 * An envelope that cannot be redacted is not sent: the SDK drops an envelope when `send` rejects.
 */
export function redactingTransport(makeTransport: SentryTransportFactory, release?: string): SentryTransportFactory {
  return (transportOptions) => {
    const transport = makeTransport(transportOptions);
    return {
      ...transport,
      send: async (envelope) => transport.send(redactWalletIdentity(envelope, release)),
    };
  };
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
 * set no DSN, so they send nothing. `makeTransport` makes the transport that sends the redacted envelopes.
 */
export function buildSentryOptions(
  { dsn, isDev, environment, release }: SentryEnvironment,
  makeTransport: SentryTransportFactory = Sentry.makeFetchTransport
): Sentry.BrowserOptions | undefined {
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
    transport: redactingTransport(makeTransport, release || undefined),
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

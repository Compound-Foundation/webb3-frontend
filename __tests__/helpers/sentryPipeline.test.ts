import * as Sentry from '@sentry/react';

import { buildSentryOptions, type SentryTransportFactory } from '../../src/helpers/sentry';

// Runs the real SDK with the app's options. The transport the app would wrap around `fetch` wraps a recorder
// here instead, so each test checks what would leave the browser, envelope headers included.
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const ADDRESS_PATTERN = /52908400098527886E0F7030069857D2E4169EE7/i;
const ADDRESS_BYTES = Uint8Array.from(Buffer.from(ADDRESS.slice(2), 'hex'));
const URL_WITH_ADDRESS = `https://api.example/account/${ADDRESS}/rewards`;
// CI names the release after the commit, and a commit SHA has as many hex digits as an address.
const RELEASE = 'c793fd76f0cce3f8cc29edb6c5f3188c623a8577';

const envelopes: string[] = [];

const recordingTransport: SentryTransportFactory = () => ({
  send: async (envelope) => {
    envelopes.push(JSON.stringify(envelope));
    return {};
  },
  flush: async () => true,
});

function sentText(): string {
  return envelopes.join('\n');
}

const consoleInfo = console.info;

beforeAll(() => {
  // Silence `console.info` before the SDK wraps it, so that a test can log through the wrapper.
  console.info = () => undefined;
  // jsdom has no Performance Timeline, which the SDK's web vitals read.
  if (typeof performance.getEntriesByType !== 'function') {
    Object.assign(performance, { getEntriesByType: () => [], getEntriesByName: () => [] });
  }
  const options = buildSentryOptions(
    { dsn: 'https://public@o0.ingest.us.sentry.io/0', isDev: true, environment: 'test', release: RELEASE },
    recordingTransport
  );
  Sentry.init(options ?? {});
});

afterAll(async () => {
  await Sentry.close();
  console.info = consoleInfo;
});

beforeEach(() => {
  envelopes.length = 0;
});

test('an error leaves the browser with its address redacted', async () => {
  Sentry.captureException(new Error(`Supply failed for ${ADDRESS}`));
  await Sentry.flush(2000);

  expect(sentText()).toContain('Supply failed for 0x[address]');
  expect(sentText()).not.toMatch(ADDRESS_PATTERN);
});

test('a span leaves the browser with the address redacted from its name and attributes', async () => {
  Sentry.startSpan({ name: `GET ${URL_WITH_ADDRESS}`, attributes: { 'url.full': URL_WITH_ADDRESS } }, () => undefined);
  await Sentry.flush(2000);

  expect(sentText()).toContain('https://api.example/account/0x[address]/rewards');
  expect(sentText()).not.toMatch(ADDRESS_PATTERN);
});

test('a root span leaves the browser with the address redacted from the envelope header too', async () => {
  // The SDK copies a root span's name into the envelope's `trace.transaction` header after `beforeSendSpan`.
  Sentry.withActiveSpan(null, () => Sentry.startSpan({ name: `GET ${URL_WITH_ADDRESS}` }, () => undefined));
  await Sentry.flush(2000);

  expect(sentText()).toContain('"transaction":"GET https://api.example/account/0x[address]/rewards"');
  expect(sentText()).not.toMatch(ADDRESS_PATTERN);
});

test('an address written with a capital 0X prefix leaves the browser redacted', async () => {
  Sentry.captureException(new Error(`Supply failed for 0X${ADDRESS.slice(2)}`));
  await Sentry.flush(2000);

  expect(sentText()).toContain('Supply failed for 0x[address]');
  expect(sentText()).not.toMatch(ADDRESS_PATTERN);
});

test('console output does not leave the browser as a breadcrumb', async () => {
  // Call through the SDK's wrapper of `console.info`, which is how the app's own logging reaches the SDK.
  console.info('Screening failed', new Error('lookup refused'));
  Sentry.captureMessage('after the console output');
  await Sentry.flush(2000);

  expect(sentText()).toContain('after the console output');
  expect(sentText()).not.toContain('Screening failed');
  expect(sentText()).not.toContain('lookup refused');
  expect(sentText()).not.toContain('"Console"');
});

test('a breadcrumb leaves the browser with its address redacted', async () => {
  Sentry.addBreadcrumb({ category: 'console', message: `connected ${ADDRESS}`, data: { arguments: [ADDRESS] } });
  Sentry.captureMessage('after the breadcrumb');
  await Sentry.flush(2000);

  expect(sentText()).toContain('connected 0x[address]');
  expect(sentText()).not.toMatch(ADDRESS_PATTERN);
});

test('a thrown object leaves the browser without the bytes of an address it holds', async () => {
  // The SDK turns the typed array into an object of numbers before any hook sees the event.
  Sentry.captureException({ message: 'wallet error', data: ADDRESS_BYTES });
  await Sentry.flush(2000);

  expect(sentText()).toContain('"__serialized__":{"message":"wallet error","data":"[bytes]"}');
  expect(sentText()).not.toContain('"0":82,"1":144');
});

test('a breadcrumb leaves the browser without the bytes of an address it holds', async () => {
  Sentry.addBreadcrumb({ category: 'console', message: String(ADDRESS_BYTES), data: { arguments: [ADDRESS_BYTES] } });
  Sentry.captureMessage('after the bytes');
  await Sentry.flush(2000);

  expect(sentText()).toContain('"message":"[bytes]"');
  expect(sentText()).not.toContain('82,144,132');
  expect(sentText()).not.toContain('"0":82,"1":144');
});

test('ENS names in capitals, with combining marks or made of joined emoji leave the browser redacted', async () => {
  Sentry.addBreadcrumb({ category: 'console', message: 'resolved Alice.ETH' });
  Sentry.captureException(new Error('No resolver for é.eth, 🇺🇸.eth, 1️⃣.eth or 👨‍👩‍👧‍👦.eth'));
  await Sentry.flush(2000);

  expect(sentText()).toContain('resolved [ens]');
  expect(sentText()).toContain('No resolver for [ens], [ens], [ens] or [ens]');
  expect(sentText()).not.toMatch(/\.eth/i);
});

test('an ENS name with a dollar sign leaves the browser redacted', async () => {
  Sentry.captureException(new Error('No resolver for cash$.eth'));
  await Sentry.flush(2000);

  expect(sentText()).toContain('No resolver for [ens]');
  expect(sentText()).not.toContain('cash$');
});

test('errors, sessions and spans keep the commit SHA as their release', async () => {
  Sentry.captureException(new Error('release check'));
  Sentry.withActiveSpan(null, () => Sentry.startSpan({ name: 'release check' }, () => undefined));
  await Sentry.flush(2000);

  expect(sentText()).toContain(`"release":"${RELEASE}"`);
  expect(sentText()).toContain(`"sentry.release":{"value":"${RELEASE}","type":"string"}`);
  expect(sentText()).not.toContain('[hex]');
});

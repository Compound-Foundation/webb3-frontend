import * as Sentry from '@sentry/react';

import { buildSentryOptions } from '../../src/helpers/sentry';

// Runs the real SDK with the app's options and a transport that records each envelope, so the test checks what
// would leave the browser rather than calling the hooks directly.
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const ADDRESS_PATTERN = /52908400098527886E0F7030069857D2E4169EE7/i;
const URL_WITH_ADDRESS = `https://api.example/account/${ADDRESS}/rewards`;

const envelopes: string[] = [];

type Transport = ReturnType<NonNullable<Sentry.BrowserOptions['transport']>>;

function recordingTransport(): Transport {
  return {
    send: async (envelope) => {
      envelopes.push(JSON.stringify(envelope));
      return {};
    },
    flush: async () => true,
  };
}

beforeAll(() => {
  // jsdom has no Performance Timeline, which the SDK's web vitals read.
  if (typeof performance.getEntriesByType !== 'function') {
    Object.assign(performance, { getEntriesByType: () => [], getEntriesByName: () => [] });
  }
  const options = buildSentryOptions({
    dsn: 'https://public@o0.ingest.us.sentry.io/0',
    isDev: true,
    environment: 'test',
  });
  Sentry.init({ ...options, transport: recordingTransport });
});

afterAll(async () => {
  await Sentry.close();
});

beforeEach(() => {
  envelopes.length = 0;
});

test('an error leaves the browser with its address redacted', async () => {
  Sentry.captureException(new Error(`Supply failed for ${ADDRESS}`));
  await Sentry.flush(2000);

  const sent = envelopes.join('\n');
  expect(sent).toContain('Supply failed for 0x[address]');
  expect(sent).not.toMatch(ADDRESS_PATTERN);
});

test('a span leaves the browser with the address redacted from its name and attributes', async () => {
  Sentry.startSpan({ name: `GET ${URL_WITH_ADDRESS}`, attributes: { 'url.full': URL_WITH_ADDRESS } }, () => undefined);
  await Sentry.flush(2000);

  const sent = envelopes.join('\n');
  expect(sent).toContain('https://api.example/account/0x[address]/rewards');
  expect(sent).not.toMatch(ADDRESS_PATTERN);
});

test('a breadcrumb leaves the browser with its address redacted', async () => {
  Sentry.addBreadcrumb({ category: 'console', message: `connected ${ADDRESS}`, data: { arguments: [ADDRESS] } });
  Sentry.captureMessage('after the breadcrumb');
  await Sentry.flush(2000);

  const sent = envelopes.join('\n');
  expect(sent).toContain('connected 0x[address]');
  expect(sent).not.toMatch(ADDRESS_PATTERN);
});

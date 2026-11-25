import * as Sentry from '@sentry/react';

import { buildSentryOptions } from '../../src/helpers/sentry';

// Runs the real SDK with the app's options and a transport that records what would leave the browser.
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const TX_HASH = '0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b';
// CI names the release after the commit.
const RELEASE = 'c793fd76f0cce3f8cc29edb6c5f3188c623a8577';

const envelopes: string[] = [];
const consoleInfo = console.info;

function sentText(): string {
  return envelopes.join('\n');
}

beforeAll(() => {
  // jsdom has no Performance Timeline, which the SDK's web vitals read.
  if (typeof performance.getEntriesByType !== 'function') {
    Object.assign(performance, { getEntriesByType: () => [], getEntriesByName: () => [] });
  }
  // Silence `console.info` before the SDK wraps it, so that a test can log through the wrapper.
  console.info = () => undefined;
  const options = buildSentryOptions({
    dsn: 'https://public@o0.ingest.us.sentry.io/0',
    isDev: true,
    environment: 'test',
    release: RELEASE,
  });
  Sentry.init({
    ...options,
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  });
});

afterAll(async () => {
  await Sentry.close();
  console.info = consoleInfo;
});

beforeEach(() => {
  envelopes.length = 0;
});

test('an error leaves the browser with its address, ENS name and transaction hash intact', async () => {
  Sentry.captureException(new Error(`Supply failed for ${ADDRESS} (alice.eth) in ${TX_HASH}`));
  await Sentry.flush(2000);

  expect(sentText()).toContain(`Supply failed for ${ADDRESS} (alice.eth) in ${TX_HASH}`);
  expect(sentText()).toContain(`"release":"${RELEASE}"`);
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

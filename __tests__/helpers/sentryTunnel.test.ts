import * as Sentry from '@sentry/react';

import { buildSentryOptions, type SentryTransportFactory } from '../../src/helpers/sentry';

// Runs the real SDK with a tunnel set. The relay forwards an envelope only when its header names the
// project's DSN, so the DSN must survive redaction unchanged while wallet identity is still removed.
const DSN = 'https://abc123def4567890abc123def4567890@o0.ingest.us.sentry.io/0';
const TUNNEL = 'https://relay.compound.xyz/';
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const ADDRESS_PATTERN = /52908400098527886E0F7030069857D2E4169EE7/i;

const transportUrls: string[] = [];
const envelopes: string[] = [];

const recordingTransport: SentryTransportFactory = (transportOptions) => {
  transportUrls.push(transportOptions.url);
  return {
    send: async (envelope) => {
      envelopes.push(JSON.stringify(envelope));
      return {};
    },
    flush: async () => true,
  };
};

beforeAll(() => {
  // jsdom has no Performance Timeline, which the SDK's web vitals read.
  if (typeof performance.getEntriesByType !== 'function') {
    Object.assign(performance, { getEntriesByType: () => [], getEntriesByName: () => [] });
  }
  const options = buildSentryOptions(
    { dsn: DSN, isDev: true, environment: 'test', tunnel: TUNNEL },
    recordingTransport
  );
  Sentry.init(options ?? {});
});

afterAll(async () => {
  await Sentry.close();
});

test('the SDK sends to the tunnel instead of Sentry', () => {
  expect(transportUrls).toEqual([TUNNEL]);
});

test('an error sent through the tunnel names the DSN in its header and has its address redacted', async () => {
  Sentry.captureException(new Error(`Supply failed for ${ADDRESS}`));
  await Sentry.flush(2000);

  const errorEnvelope = envelopes.find((envelope) => envelope.includes('Supply failed for 0x[address]'));
  expect(errorEnvelope).toBeDefined();
  const [header] = JSON.parse(errorEnvelope ?? '[]') as [{ dsn?: string }];
  expect(header.dsn).toBe(DSN);
  expect(envelopes.join('\n')).not.toMatch(ADDRESS_PATTERN);
});

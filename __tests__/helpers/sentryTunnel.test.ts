import * as Sentry from '@sentry/react';

import { buildSentryOptions } from '../../src/helpers/sentry';

// Runs the real SDK with a tunnel set. The relay forwards an envelope only when its header names the
// project's DSN, so the header must carry the DSN unchanged.
const DSN = 'https://abc123def4567890abc123def4567890@o0.ingest.us.sentry.io/0';
const TUNNEL = 'https://relay.compound.xyz/';

const transportUrls: string[] = [];
const envelopes: string[] = [];

beforeAll(() => {
  // jsdom has no Performance Timeline, which the SDK's web vitals read.
  if (typeof performance.getEntriesByType !== 'function') {
    Object.assign(performance, { getEntriesByType: () => [], getEntriesByName: () => [] });
  }
  const options = buildSentryOptions({ dsn: DSN, isDev: true, environment: 'test', tunnel: TUNNEL });
  Sentry.init({
    ...options,
    transport: (transportOptions) => {
      transportUrls.push(transportOptions.url);
      return {
        send: async (envelope) => {
          envelopes.push(JSON.stringify(envelope));
          return {};
        },
        flush: async () => true,
      };
    },
  });
});

afterAll(async () => {
  await Sentry.close();
});

test('the SDK sends to the tunnel instead of Sentry', () => {
  expect(transportUrls).toEqual([TUNNEL]);
});

test('an error sent through the tunnel names the DSN in its header', async () => {
  Sentry.captureException(new Error('Supply failed'));
  await Sentry.flush(2000);

  const errorEnvelope = envelopes.find((envelope) => envelope.includes('Supply failed'));
  expect(errorEnvelope).toBeDefined();
  const [header] = JSON.parse(errorEnvelope ?? '[]') as [{ dsn?: string }];
  expect(header.dsn).toBe(DSN);
});

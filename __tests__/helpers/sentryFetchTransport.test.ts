import * as Sentry from '@sentry/react';

import { buildSentryOptions } from '../../src/helpers/sentry';

// Runs the real SDK with the app's default transport, and records the bodies it hands to `fetch`.
const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';

const bodies: string[] = [];

beforeAll(() => {
  // jsdom has no Performance Timeline, which the SDK's web vitals read.
  if (typeof performance.getEntriesByType !== 'function') {
    Object.assign(performance, { getEntriesByType: () => [], getEntriesByName: () => [] });
  }
  window.fetch = jest.fn(async (_url, init) => {
    bodies.push(String(init?.body));
    return { status: 200, headers: { get: () => null } } as unknown as Response;
  });
  Sentry.init(
    buildSentryOptions({ dsn: 'https://public@o0.ingest.us.sentry.io/0', isDev: false, environment: 'test' }) ?? {}
  );
});

afterAll(async () => {
  await Sentry.close();
});

test('the default transport posts an error to Sentry with its address redacted', async () => {
  Sentry.captureException(new Error(`Supply failed for ${ADDRESS}`));
  await Sentry.flush(2000);

  expect(window.fetch).toHaveBeenCalledWith(
    expect.stringContaining('https://o0.ingest.us.sentry.io/api/0/envelope/'),
    expect.anything()
  );
  expect(bodies.join('\n')).toContain('Supply failed for 0x[address]');
  expect(bodies.join('\n')).not.toMatch(/52908400098527886E0F7030069857D2E4169EE7/i);
});

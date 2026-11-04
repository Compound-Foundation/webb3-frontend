/**
 * @jest-environment node
 */
// The browser suite's scheduling: Playwright spreads each spec file's tests across the workers, and a failed
// test is never run again.
import type { PlaywrightTestConfig } from '@playwright/test';

const SET_BY_CONFIG = ['BROWSER_TEST_WORKERS', 'BROWSER_HARNESS_RUN_ID', 'BROWSER_HARNESS_CONCURRENCY'] as const;

/** The configuration, loaded with an explicit worker count so the machine is not sampled. */
function loadConfig(): PlaywrightTestConfig {
  const saved = Object.fromEntries(SET_BY_CONFIG.map((name) => [name, process.env[name]]));
  for (const name of SET_BY_CONFIG) delete process.env[name];
  process.env.BROWSER_TEST_WORKERS = '1';
  try {
    let config: PlaywrightTestConfig | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      config = require('../../playwright.config').default;
    });
    return config as PlaywrightTestConfig;
  } finally {
    for (const name of SET_BY_CONFIG) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test('runs the tests of a spec file in parallel, with no retries', () => {
  const config = loadConfig();
  expect(config.fullyParallel).toBe(true);
  expect(config.retries).toBe(0);
});

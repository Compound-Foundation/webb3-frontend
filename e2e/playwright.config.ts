// The browser integration suite: `yarn test:browser`. See docs/browser-fork-wallet.md.
//
// Each worker has its own fork lane. Playwright schedules each test on its own (`fullyParallel: true`), so the
// tests of one spec file can run at once in different workers. Before each test, the worker's wallet and fork
// reset and the test gets a new browser context. A test therefore starts with none of another test's
// accounts, fork changes or browser storage. The proxies' counters and the lane list are shared across the
// run, so a test that reads them must not depend on which tests ran before it.
//
// The worker count is an estimate for this machine (`harness/concurrency.ts`), unless BROWSER_TEST_WORKERS or
// `--workers` sets it. There are no retries, so a flaky case shows as a failure.
import path from 'node:path';

import { defineConfig } from '@playwright/test';

import { estimateWorkers, readSignals, type WorkerSelection } from './harness/concurrency';
import { RUNS_DIR } from './harness/paths';

// The run ID and the worker count are set once, in the runner, and the workers inherit them: each worker loads
// this file again, and must not sample the machine again or choose another count.
process.env.BROWSER_HARNESS_RUN_ID ??= `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
process.env.BROWSER_HARNESS_CONCURRENCY ??= JSON.stringify(
  estimateWorkers(process.env, () => readSignals(process.env))
);
const selection = JSON.parse(process.env.BROWSER_HARNESS_CONCURRENCY) as WorkerSelection;
const runDir = path.join(RUNS_DIR, process.env.BROWSER_HARNESS_RUN_ID);
const isInteractive = process.env.BROWSER_WALLET_INTERACTIVE === '1';

export default defineConfig({
  testDir: './specs',
  globalSetup: './harness/globalSetup.ts',
  workers: selection.workers,
  fullyParallel: true,
  retries: 0,
  forbidOnly: true,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  outputDir: path.join(runDir, 'playwright'),
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.join(runDir, 'html') }],
    ['./harness/summaryReporter.ts', { runDir }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // An interactive session is headed, unless BROWSER_WALLET_HEADLESS=1 (for agents without a display).
    headless: !isInteractive || process.env.BROWSER_WALLET_HEADLESS === '1',
    viewport: { width: 1440, height: 1000 },
  },
  projects: isInteractive
    ? [{ name: 'interactive', testMatch: /interactive\.session\.ts/, timeout: 0 }]
    : [
        { name: 'dev', testMatch: /\.spec\.ts$/, testIgnore: /(prod-build|bundle)\.spec\.ts$/ },
        { name: 'prod-build', testMatch: /(prod-build|bundle)\.spec\.ts$/ },
      ],
});

// The browser integration suite: `yarn test:browser`. See docs/browser-fork-wallet.md.
//
// Each worker has its own fork lane, so workers run spec files side by side. The worker count is an estimate
// for this machine (`harness/concurrency.ts`), unless BROWSER_TEST_WORKERS or `--workers` sets it. A spec
// file runs in one worker (`fullyParallel: false`), and there are no retries, so a flaky case shows as a
// failure.
import path from 'node:path';

import { defineConfig } from '@playwright/test';

import { readSignals, selectWorkers, type WorkerSelection } from './harness/concurrency';
import { REPO_ROOT, RUNS_DIR } from './harness/paths';

// The run ID and the worker count are set once, in the runner, and the workers inherit them: each worker loads
// this file again, and must not sample the machine again or choose another count.
process.env.BROWSER_HARNESS_RUN_ID ??= `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
process.env.BROWSER_HARNESS_CONCURRENCY ??= JSON.stringify(
  selectWorkers(readSignals(process.env, path.join(REPO_ROOT, 'e2e/specs')), process.env)
);
const selection = JSON.parse(process.env.BROWSER_HARNESS_CONCURRENCY) as WorkerSelection;
const runDir = path.join(RUNS_DIR, process.env.BROWSER_HARNESS_RUN_ID);
const isInteractive = process.env.BROWSER_WALLET_INTERACTIVE === '1';

export default defineConfig({
  testDir: './specs',
  globalSetup: './harness/globalSetup.ts',
  workers: selection.workers,
  fullyParallel: false,
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

// The browser integration suite: `yarn test:browser`. See docs/browser-fork-wallet.md.
//
// One worker, because every test shares one fork, and no retries, so a flaky case shows as a failure.
import path from 'node:path';

import { defineConfig } from '@playwright/test';

import { RUNS_DIR } from './harness/paths';

// The run ID is set once, in the runner, and the workers inherit it.
process.env.BROWSER_HARNESS_RUN_ID ??= `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const runDir = path.join(RUNS_DIR, process.env.BROWSER_HARNESS_RUN_ID);
const isInteractive = process.env.BROWSER_WALLET_INTERACTIVE === '1';

export default defineConfig({
  testDir: './specs',
  globalSetup: './harness/globalSetup.ts',
  workers: 1,
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

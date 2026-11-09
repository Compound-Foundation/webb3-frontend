// Playwright's global setup: starts the harness's services for the run, and returns their teardown.
import fs from 'node:fs';
import path from 'node:path';

import type { FullConfig } from '@playwright/test';

import { browserPoolCountOf } from './browserPool';
import { workersText, type WorkerSelection } from './concurrency';
import { REPO_ROOT } from './paths';
import { startServices } from './services';

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  if (!fs.existsSync(path.join(REPO_ROOT, 'e2e/playwright.config.ts'))) {
    throw new Error('Run the browser harness from the repository root: yarn test:browser.');
  }
  const runId = process.env.BROWSER_HARNESS_RUN_ID as string;
  const isInteractive = process.env.BROWSER_WALLET_INTERACTIVE === '1';
  // The projects this run selected with --project. Playwright sets `filteredProjects` before the global
  // setup; `projects` always lists every project.
  const selected = (config as FullConfig & { filteredProjects?: FullConfig['projects'] }).filteredProjects;
  const projects = (selected ?? config.projects).map((project) => project.name);
  const skipProduction = isInteractive
    ? 'interactive session'
    : process.env.BROWSER_TEST_SKIP_PROD === '1'
    ? 'BROWSER_TEST_SKIP_PROD=1 (a scoped run)'
    : !projects.includes('prod-build')
    ? 'the run does not include the prod-build project'
    : undefined;
  // The selection the configuration made, and the count Playwright runs with, which `--workers` can change.
  // Each worker can lease one fork lane.
  const selection = process.env.BROWSER_HARNESS_CONCURRENCY
    ? (JSON.parse(process.env.BROWSER_HARNESS_CONCURRENCY) as WorkerSelection)
    : undefined;
  const workers = isInteractive ? 1 : config.workers;
  if (
    browserPoolCountOf(process.env, workers, isInteractive) > 0 &&
    config.projects.some((project) => project.use.headless === false)
  ) {
    throw new Error('BROWSER_TEST_BROWSER_POOL requires headless browsers; remove --headed or disable the pool.');
  }
  const isCliOverride = selection !== undefined && workers !== selection.workers;
  process.stdout.write(`Browser harness: workers ${workersText({ workers, selection, isCliOverride })}\n`);
  const services = await startServices({
    runId,
    isInteractive,
    skipProduction,
    laneCount: workers,
    concurrency: { workers, selection, isCliOverride },
  });
  return async () => {
    const errors = await services.stop();
    if (errors.length > 0) throw new Error(`The harness did not stop cleanly: ${errors.join('; ')}`);
  };
}

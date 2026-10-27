// Playwright's global setup: starts the harness's services for the run, and returns their teardown.
import fs from 'node:fs';
import path from 'node:path';

import type { FullConfig } from '@playwright/test';

import { REPO_ROOT } from './paths';
import { startServices } from './services';

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  if (!fs.existsSync(path.join(REPO_ROOT, 'e2e/playwright.config.ts'))) {
    throw new Error('Run the browser harness from the repository root: yarn test:browser.');
  }
  const runId = process.env.BROWSER_HARNESS_RUN_ID as string;
  const interactive = process.env.BROWSER_WALLET_INTERACTIVE === '1';
  // The projects this run selected with --project. Playwright sets `filteredProjects` before the global
  // setup; `projects` always lists every project.
  const selected = (config as FullConfig & { filteredProjects?: FullConfig['projects'] }).filteredProjects;
  const projects = (selected ?? config.projects).map((project) => project.name);
  const skipProduction = interactive
    ? 'interactive session'
    : process.env.BROWSER_TEST_SKIP_PROD === '1'
    ? 'BROWSER_TEST_SKIP_PROD=1 (a scoped run)'
    : !projects.includes('prod-build')
    ? 'the run does not include the prod-build project'
    : undefined;
  const services = await startServices({ runId, interactive, skipProduction });
  return async () => {
    const errors = await services.stop();
    if (errors.length > 0) throw new Error(`The harness did not stop cleanly: ${errors.join('; ')}`);
  };
}

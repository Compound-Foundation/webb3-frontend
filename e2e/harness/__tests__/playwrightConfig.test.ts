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

// Playwright refuses to load twice in one process, so the tests share one load.
const config = loadConfig();

test('runs the tests of a spec file in parallel, with no retries', () => {
  expect(config.fullyParallel).toBe(true);
  expect(config.retries).toBe(0);
});

test('runs the dev-server probe in its own project, after every other dev-server test', () => {
  const projects = config.projects ?? [];
  const matches = (pattern: unknown, file: string) => pattern instanceof RegExp && pattern.test(file);
  const projectsOf = (file: string) =>
    projects
      .filter((project) => matches(project.testMatch, file) && !matches(project.testIgnore, file))
      .map((project) => project.name);
  expect(projectsOf('dev-server-security.spec.ts')).toEqual(['dev-server-security']);
  expect(projectsOf('harness-security.spec.ts')).toEqual(['dev']);
  expect(projectsOf('bundle.spec.ts')).toEqual(['prod-build']);
  expect(projectsOf('prod-build.spec.ts')).toEqual(['prod-build']);
  expect(projects.find((project) => project.name === 'dev-server-security')?.dependencies).toEqual(['dev']);
  expect(projects.find((project) => project.name === 'prod-build')?.dependencies).toBeUndefined();
});

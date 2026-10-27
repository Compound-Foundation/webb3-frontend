/**
 * @jest-environment node
 */
// The summary's verdict: PASS only for a run of the whole suite. A run that selected fewer tests, by any
// means, is INCOMPLETE even when every spec file is represented and every selected test passed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FullConfig, Suite, TestCase, TestResult } from '@playwright/test/reporter';

import SummaryReporter from '../summaryReporter';

/** A test case as the reporter reads one. */
const testCase = (project: string, file: string, title: string) =>
  ({
    title,
    titlePath: () => ['', project, file, 'suite', title],
    parent: { project: () => ({ name: project }) },
    annotations: [],
    tags: ['@AC2'],
    location: { file: `/repo/e2e/specs/${file}`, line: 1, column: 1 },
  } as unknown as TestCase);

const passed = { status: 'passed', duration: 10, annotations: [], errors: [] } as unknown as TestResult;

const FULL = [
  ['dev', 'connect.spec.ts', 'first'],
  ['dev', 'connect.spec.ts', 'second'],
  ['dev', 'signing.spec.ts', 'first'],
  ['prod-build', 'bundle.spec.ts', 'only'],
] as const;
const id = ([project, file, title]: readonly string[]) => `${project} › ${file} › suite › ${title}`;

/** The parts of a run's manifest the summary reads. */
const MANIFEST = {
  fork: { number: 26244888, mode: 'pinned', hash: '0x00', endpoint: 'test' },
  tools: { node: 'v22' },
  git: { head: 'abc', dirty: false },
  production: {
    skipped: false,
    missingEndpoint: { resolved: { DEV: false, PROD: true } },
    allowed: { resolved: { DEV: false, PROD: true } },
  },
  app: { devResolved: { DEV: true } },
  tls: { mode: 'node-trusts-harness-certificate' },
  v3Api: { label: 'not configured' },
  contracts: { usdcImplementation: '0x00' },
};

async function summaryOf(selected: readonly (readonly string[])[], inventory: () => string[]) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-summary-'));
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(MANIFEST));
  const reporter = new SummaryReporter({ runDir, inventory });
  const tests = selected.map(([project, file, title]) => testCase(project, file, title));
  reporter.onBegin({ projects: [] } as unknown as FullConfig, { allTests: () => tests } as unknown as Suite);
  for (const each of tests) reporter.onTestEnd(each, passed);
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await reporter.onEnd({ status: 'passed' } as never);
  } finally {
    process.stdout.write = write;
  }
  const summary = fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8');
  fs.rmSync(runDir, { recursive: true, force: true });
  return summary;
}

test('a run of the whole suite, every test passed, gives PASS', async () => {
  expect(await summaryOf(FULL, () => FULL.map(id))).toContain('Verdict: **PASS**');
});

test('a title-filtered run that represents every spec file but omits tests is INCOMPLETE', async () => {
  const selected = FULL.filter(([, , title]) => title !== 'second');
  const summary = await summaryOf(selected, () => FULL.map(id));
  expect(summary).toContain('Verdict: **INCOMPLETE**');
  expect(summary).toContain('1 of 4 tests in the full suite were not selected');
  expect(summary).toContain('dev › connect.spec.ts › suite › second');
  expect(summary).toMatch(/\| AC2 \| INCOMPLETE \|/);
});

test('a run whose harness did not start is not a PASS', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-summary-'));
  const reporter = new SummaryReporter({ runDir, inventory: () => [] });
  reporter.onBegin({ projects: [] } as unknown as FullConfig, { allTests: () => [] } as unknown as Suite);
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  await reporter.onEnd({ status: 'passed' } as never).finally(() => (process.stdout.write = write));
  expect(fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8')).toContain('Verdict: **INCOMPLETE**');
  fs.rmSync(runDir, { recursive: true, force: true });
});

test('a run whose full inventory cannot be listed is INCOMPLETE', async () => {
  const summary = await summaryOf(FULL, () => {
    throw new Error('no list');
  });
  expect(summary).toContain('Verdict: **INCOMPLETE**');
  expect(summary).toContain('could not list the full suite');
});

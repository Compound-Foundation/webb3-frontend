/**
 * @jest-environment node
 */
// The summary's verdict: PASS only for a run of the whole suite. A run that selected fewer tests, by any
// means, is INCOMPLETE even when every spec file is represented and every selected test passed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FullConfig, Suite, TestCase, TestResult } from '@playwright/test/reporter';

import SummaryReporter, { testId } from '../summaryReporter';

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
  git: { head: 'abc', isDirty: false },
  production: {
    isSkipped: false,
    missingEndpoint: { resolved: { DEV: false, PROD: true } },
    allowed: { resolved: { DEV: false, PROD: true } },
  },
  app: { devResolved: { DEV: true } },
  tls: { mode: 'node-trusts-harness-certificate' },
  v3Api: { label: 'not configured' },
  contracts: { usdcImplementation: '0x00' },
};

async function summaryOf(
  selected: readonly (readonly string[])[],
  inventory: () => string[],
  manifest: object = MANIFEST,
  stats?: object
) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-summary-'));
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest));
  if (stats !== undefined) fs.writeFileSync(path.join(runDir, 'stats.json'), JSON.stringify(stats));
  // The synthetic inventory holds none of the real required cases, which the last tests below cover.
  const reporter = new SummaryReporter({ runDir, inventory, requiredCases: [] });
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

test('a known acceptance case that is not executed makes its criterion and the acceptance INCOMPLETE', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-summary-'));
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(MANIFEST));
  const ran = testCase('prod-build', 'prod-build.spec.ts', 'fails closed');
  const known = {
    ...testCase('prod-build', 'prod-build.spec.ts', 'a NODE_ENV=development build'),
    annotations: [{ type: 'fixme', description: 'not executed: the product fix is a follow-up' }],
  } as unknown as TestCase;
  for (const each of [ran, known]) (each as unknown as { tags: string[] }).tags = ['@AC7'];
  const reporter = new SummaryReporter({ runDir, inventory: () => [testId(ran), testId(known)] });
  reporter.onBegin({ projects: [] } as unknown as FullConfig, { allTests: () => [ran, known] } as unknown as Suite);
  reporter.onTestEnd(ran, passed);
  reporter.onTestEnd(known, { status: 'skipped', duration: 0, annotations: [], errors: [] } as unknown as TestResult);
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  await reporter.onEnd({ status: 'passed' } as never).finally(() => (process.stdout.write = write));
  const summary = fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8');
  fs.rmSync(runDir, { recursive: true, force: true });
  expect(summary).toContain('Verdict: **INCOMPLETE**');
  expect(summary).toContain('All implemented tests passed: yes (1 passed, 0 failed).');
  expect(summary).toMatch(/\| AC7 \| INCOMPLETE \|/);
  expect(summary).toContain('not executed: the product fix is a follow-up');
});

test('a required acceptance case missing from the full suite makes its criterion and the acceptance INCOMPLETE', async () => {
  // The placeholder was deleted: the run and the full inventory agree, and every test passed, but the
  // independent list of required cases still names it.
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-summary-'));
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(MANIFEST));
  const ran = testCase('prod-build', 'prod-build.spec.ts', 'fails closed');
  (ran as unknown as { tags: string[] }).tags = ['@AC7'];
  const required = {
    criterion: 'AC7',
    id: 'prod-build › prod-build.spec.ts › suite › a NODE_ENV=development build',
    why: 'test',
  };
  const reporter = new SummaryReporter({ runDir, inventory: () => [testId(ran)], requiredCases: [required] });
  reporter.onBegin({ projects: [] } as unknown as FullConfig, { allTests: () => [ran] } as unknown as Suite);
  reporter.onTestEnd(ran, passed);
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  await reporter.onEnd({ status: 'passed' } as never).finally(() => (process.stdout.write = write));
  const summary = fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8');
  fs.rmSync(runDir, { recursive: true, force: true });
  expect(summary).toContain('Verdict: **INCOMPLETE**');
  expect(summary).toContain('All implemented tests passed: yes (1 passed, 0 failed).');
  expect(summary).toMatch(/\| AC7 \| INCOMPLETE \|/);
  expect(summary).toContain(`required acceptance case missing from the suite: ${required.id}`);
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

test("the run section gives the fork cache's state, trust class and directory, with the home directory as ~", async () => {
  const withCache = (cache: object) => ({ ...MANIFEST, fork: { ...MANIFEST.fork, cache } });
  expect(
    await summaryOf(
      FULL,
      () => FULL.map(id),
      withCache({ state: 'warm', trust: 'public', directory: '/data/fork-cache' })
    )
  ).toContain('- Fork cache: warm (public), /data/fork-cache');
  expect(
    await summaryOf(
      FULL,
      () => FULL.map(id),
      withCache({ state: 'cold', trust: 'private', directory: path.join(os.homedir(), '.cache/cf-browser-fork') })
    )
  ).toContain('- Fork cache: cold (private), ~/.cache/cf-browser-fork');
  expect(await summaryOf(FULL, () => FULL.map(id), withCache({ state: 'off' }))).toContain('- Fork cache: off');
  expect(
    await summaryOf(FULL, () => FULL.map(id), withCache({ state: 'off', reason: 'port 18546 is in use' }))
  ).toContain('- Fork cache: off (port 18546 is in use)');
  // A manifest written before the cache existed.
  expect(await summaryOf(FULL, () => FULL.map(id))).toContain('- Fork cache: not recorded');
});

test('the proxies section says whether the run promoted its fork cache, and why not', async () => {
  const STATS = {
    rpcProxy: { forwarded: {}, refused: {}, unserved: {} },
    upstream: { methods: {}, refused: {}, failures: 0, errorAnswers: 0 },
    cleanupErrors: [],
  };
  const promoted = { ...STATS, forkCachePromotion: { isPromoted: true, reason: 'promoted' } };
  expect(await summaryOf(FULL, () => FULL.map(id), MANIFEST, promoted)).toContain(
    '- Fork cache after the run: promoted to the shared cache'
  );
  const refused = { ...STATS, forkCachePromotion: { isPromoted: false, reason: 'the fork was sent anvil_setRpcUrl' } };
  expect(await summaryOf(FULL, () => FULL.map(id), MANIFEST, refused)).toContain(
    '- Fork cache after the run: not promoted (the fork was sent anvil_setRpcUrl)'
  );
  expect(await summaryOf(FULL, () => FULL.map(id), MANIFEST, STATS)).not.toContain('Fork cache after the run');
});

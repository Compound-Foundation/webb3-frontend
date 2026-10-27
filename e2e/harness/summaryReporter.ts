// Writes `summary.md` for a run, after every other reporter has finished:
// - each test as passed, failed, or INCOMPLETE (skipped, interrupted or not run), with its reason
// - each acceptance criterion, from the tests' `@ACn` tags, as passed, failed or INCOMPLETE
// - the fork, the tool versions, the production builds' resolved DEV and PROD, and the proxies' counts
// - the scan of every output of the run for the run's secrets. A secret found fails the run.
//
// The verdict is PASS only for a run of the whole suite. The reporter lists the full suite with
// `playwright test --list` and compares it, test by test, with the tests this run selected, so a run that
// selected fewer by any means (a title filter, an inverted one, a file or line, a project, a shard) is
// INCOMPLETE, and the summary names the tests it left out.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

import { REPO_ROOT } from './paths';
import { findSecrets, outputsUnder, registeredSecretCount } from './secrets';

type Row = { title: string; project: string; tags: string[]; status: string; reason: string; durationMs: number };

const firstLine = (text: string | undefined) =>
  (text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split('\n')
    .find((line) => line.trim() !== '')
    ?.trim()
    .slice(0, 240) ?? '';

/** A test's identity across runs: its project and its title path from the spec file down. */
export const testId = (test: TestCase) => `${test.parent.project()?.name} › ${test.titlePath().slice(2).join(' › ')}`;

type ListedSuite = {
  title: string;
  specs?: { title: string; tests?: { projectName: string }[] }[];
  suites?: ListedSuite[];
};

/**
 * Every test of the full suite, as `testId` names them, from `playwright test --list` with the same
 * configuration and no filter. The listing loads the specs only: it runs no global setup and no test.
 */
export function listFullSuite(configFile: string): string[] {
  const output = execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'node_modules/@playwright/test/cli.js'),
      'test',
      '-c',
      configFile,
      '--list',
      '--reporter=json',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, BROWSER_WALLET_INTERACTIVE: '' } }
  );
  const ids: string[] = [];
  const walk = (suite: ListedSuite, titles: string[]) => {
    for (const spec of suite.specs ?? []) {
      for (const each of spec.tests ?? []) ids.push(`${each.projectName} › ${[...titles, spec.title].join(' › ')}`);
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const file of (JSON.parse(output) as { suites: ListedSuite[] }).suites) walk(file, [file.title]);
  return ids;
}

export default class SummaryReporter implements Reporter {
  readonly #runDir: string;
  #tests: TestCase[] = [];
  readonly #results = new Map<TestCase, TestResult>();
  readonly #output: string[] = [];
  #startedAt = Date.now();
  readonly #inventory: (() => string[]) | undefined;
  #configFile: string | undefined;

  constructor({ runDir, inventory }: { runDir: string; inventory?: () => string[] }) {
    this.#runDir = runDir;
    this.#inventory = inventory;
  }

  printsToStdio() {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite) {
    this.#tests = suite.allTests();
    this.#startedAt = Date.now();
    this.#configFile = config.configFile;
  }

  /** The tests of the full suite this run did not select, or why the full suite could not be listed. */
  #notSelected(): { missing: string[]; total: number } | { problem: string } {
    if (process.env.BROWSER_WALLET_INTERACTIVE === '1')
      return { problem: 'an interactive session is not an acceptance run' };
    let inventory: string[];
    try {
      const configFile = this.#configFile;
      inventory = this.#inventory?.() ?? (configFile === undefined ? [] : listFullSuite(configFile));
    } catch (error) {
      return { problem: `the reporter could not list the full suite (${firstLine((error as Error)?.message)})` };
    }
    if (inventory.length === 0) return { problem: 'the reporter could not list the full suite (no tests listed)' };
    const selected = new Set(this.#tests.map(testId));
    return { missing: inventory.filter((each) => !selected.has(each)), total: inventory.length };
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this.#results.set(test, result);
  }

  onStdOut(chunk: string | Buffer) {
    this.#output.push(chunk.toString());
  }

  onStdErr(chunk: string | Buffer) {
    this.#output.push(chunk.toString());
  }

  onError(error: { message?: string }) {
    this.#output.push(`runner error: ${error.message ?? ''}`);
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    fs.mkdirSync(this.#runDir, { recursive: true });
    fs.writeFileSync(path.join(this.#runDir, 'test-output.log'), this.#output.join(''));
    const rows: Row[] = this.#tests.map((test) => {
      const outcome = this.#results.get(test);
      const incomplete = test.annotations.find((annotation) => annotation.type === 'incomplete');
      let status: string;
      let reason = '';
      if (outcome === undefined) {
        status = 'INCOMPLETE';
        reason = 'not run';
      } else if (outcome.status === 'passed' && incomplete === undefined) {
        status = 'passed';
      } else if (outcome.status === 'passed') {
        status = 'INCOMPLETE';
        reason = incomplete?.description ?? '';
      } else if (outcome.status === 'skipped') {
        status = 'INCOMPLETE';
        // A `test.fixme` is a known acceptance case the suite does not execute yet, and stays INCOMPLETE.
        const fixme = test.annotations.find((annotation) => annotation.type === 'fixme');
        reason = fixme
          ? `known case not executed: ${fixme.description ?? 'no reason given'}`
          : `skipped: ${
              test.annotations.find((annotation) => annotation.type === 'skip')?.description ?? 'no reason given'
            }`;
      } else if (outcome.status === 'interrupted') {
        status = 'INCOMPLETE';
        reason = 'interrupted';
      } else {
        status = 'FAILED';
        reason = firstLine(outcome.error?.message);
      }
      const notes = [...(outcome?.annotations ?? []), ...test.annotations]
        .filter((annotation) => ['attempted action', 'bypass text in bundle'].includes(annotation.type))
        .map((annotation) => `${annotation.type}: ${annotation.description}`);
      if (status === 'passed' && notes.length > 0) reason = [...new Set(notes)].join('; ');
      return {
        title: test.titlePath().slice(2).join(' › '),
        project: test.parent.project()?.name ?? '',
        tags: test.tags,
        status,
        reason,
        durationMs: outcome?.duration ?? 0,
      };
    });

    const read = (name: string) => {
      const file = path.join(this.#runDir, name);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
    };
    const manifest = read('manifest.json');
    const stats = read('stats.json');

    // The scan runs last, over every output of the run, after the HTML report and the traces are written.
    const leaks = findSecrets([
      ...outputsUnder([this.#runDir]),
      { file: 'test stdout and stderr', content: this.#output.join('') },
    ]);

    const criteria = new Map<string, Row[]>();
    for (const row of rows)
      for (const tag of row.tags.filter((each) => /^@AC\d+$/.test(each))) {
        criteria.set(tag, [...(criteria.get(tag) ?? []), row]);
      }
    const criterionStatus = (list: Row[]) =>
      list.some((row) => row.status === 'FAILED')
        ? 'FAILED'
        : list.some((row) => row.status === 'INCOMPLETE')
        ? 'INCOMPLETE'
        : 'passed';
    const isProductionSkipped = manifest?.production?.isSkipped === true;
    const bundleLeaks: { file: string; secret: string }[] = stats?.bundleSecretScan?.leaks ?? [];
    const selection = this.#notSelected();
    const isKnownCase = (row: Row) => row.reason.startsWith('known case not executed');
    const hasEveryImplementedTestPassed =
      result.status === 'passed' && rows.filter((row) => !isKnownCase(row)).every((row) => row.status === 'passed');
    const counts = (status: string) => rows.filter((row) => row.status === status).length;
    const verdict =
      result.status !== 'passed' || counts('FAILED') > 0 || leaks.length > 0 || bundleLeaks.length > 0
        ? 'FAIL'
        : counts('INCOMPLETE') > 0 ||
          isProductionSkipped ||
          rows.length === 0 ||
          manifest === undefined ||
          'problem' in selection ||
          selection.missing.length > 0
        ? 'INCOMPLETE'
        : 'PASS';

    const lines = [
      `# Browser fork wallet run ${path.basename(this.#runDir)}`,
      '',
      `Verdict: **${verdict}** (acceptance; Playwright: ${result.status}). ${counts('passed')} passed, ${counts(
        'FAILED'
      )} failed, ${counts('INCOMPLETE')} incomplete, in ${Math.round((Date.now() - this.#startedAt) / 1000)} s.`,
      '',
      // Separate from the acceptance verdict, which a known case not executed keeps INCOMPLETE.
      `All implemented tests passed: ${hasEveryImplementedTestPassed ? 'yes' : 'no'} (${counts(
        'passed'
      )} passed, ${counts('FAILED')} failed).`,
      '',
    ];
    if (isProductionSkipped) {
      lines.push(
        `**AC7 production coverage INCOMPLETE:** the production builds were skipped (${manifest.production.reason}).`,
        ''
      );
    }
    if ('problem' in selection) {
      lines.push(`**Not an acceptance run, INCOMPLETE:** ${selection.problem}.`, '');
    } else if (selection.missing.length > 0) {
      lines.push(
        `**Scoped run, INCOMPLETE:** ${selection.missing.length} of ${selection.total} tests in the full suite were not selected:`,
        '',
        ...selection.missing.map((each) => `- ${each}`),
        ''
      );
    }
    if (manifest === undefined)
      lines.push('The harness did not start: see startup-failure.txt and the test output.', '');
    lines.push('## Acceptance criteria', '', '| Criterion | Status | Tests |', '| --- | --- | --- |');
    for (const [tag, list] of [...criteria].sort(([a], [b]) => Number(a.slice(3)) - Number(b.slice(3)))) {
      // A criterion cannot pass on a scoped run: the tests the run left out may be its own.
      const status = criterionStatus(list);
      const isScoped = 'problem' in selection || selection.missing.length > 0;
      lines.push(`| ${tag.slice(1)} | ${status === 'passed' && isScoped ? 'INCOMPLETE' : status} | ${list.length} |`);
    }
    lines.push(
      '',
      '## Tests',
      '',
      '| Project | Test | Status | Seconds | Reason or notes |',
      '| --- | --- | --- | --- | --- |'
    );
    for (const row of rows) {
      lines.push(
        `| ${row.project} | ${row.title.replace(/\|/g, '/')} | ${row.status} | ${Math.round(
          row.durationMs / 1000
        )} | ${row.reason.replace(/\|/g, '/')} |`
      );
    }
    lines.push('', '## Secret scan', '');
    lines.push(
      leaks.length === 0
        ? `No secret found. ${registeredSecretCount()} secrets were registered, and ${
            outputsUnder([this.#runDir]).length
          } files and trace members were scanned, with the test output.`
        : `**${leaks.length} secret(s) found:** ${leaks
            .map((leak) => `${leak.secret} in ${path.relative(this.#runDir, leak.file) || leak.file}`)
            .join('; ')}`
    );
    if (stats?.bundleSecretScan !== undefined) {
      lines.push(
        '',
        bundleLeaks.length === 0
          ? `Production bundles (${stats.bundleSecretScan.roots.join(', ') || 'none built'}): no secret found in ${
              stats.bundleSecretScan.files
            } files.`
          : `**Production bundles hold ${bundleLeaks.length} secret(s):** ${bundleLeaks
              .map((leak) => `${leak.secret} in ${leak.file}`)
              .join('; ')}`
      );
    }
    if (manifest !== undefined) {
      const production = manifest.production.isSkipped
        ? `skipped (${manifest.production.reason})`
        : `no endpoint: DEV=${manifest.production.missingEndpoint.resolved.DEV}, PROD=${manifest.production.missingEndpoint.resolved.PROD}; allowed control: DEV=${manifest.production.allowed.resolved.DEV}, PROD=${manifest.production.allowed.resolved.PROD}`;
      lines.push(
        '',
        '## Run',
        '',
        `- Fork: block ${manifest.fork.number} (${manifest.fork.mode}), hash ${manifest.fork.hash}, from ${manifest.fork.endpoint}`,
        `- Tools: ${Object.entries(manifest.tools)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => `${name} ${value}`)
          .join(', ')}`,
        `- Git: ${manifest.git.head ?? 'unknown'}${manifest.git.isDirty ? ' (dirty tree)' : ''}`,
        `- Production builds: ${production}`,
        `- Dev server resolved DEV=${manifest.app.devResolved.DEV}; HTTPS trust: ${manifest.tls.mode}`,
        `- v3 API: ${manifest.v3Api.label}`,
        `- USDC implementation at the fork: ${manifest.contracts.usdcImplementation}`
      );
    }
    if (stats !== undefined) {
      lines.push(
        '',
        '## Proxies',
        '',
        `- App RPC proxy forwarded to the fork: ${JSON.stringify(stats.rpcProxy.forwarded)}`,
        `- App RPC proxy refused: ${JSON.stringify(
          stats.rpcProxy.refused
        )}; other chains answered unserved: ${JSON.stringify(stats.rpcProxy.unserved)}`,
        `- Upstream proxy forwarded: ${JSON.stringify(stats.upstream.methods)}; refused: ${JSON.stringify(
          stats.upstream.refused
        )}; upstream failures ${stats.upstream.failures}, error answers ${stats.upstream.errorAnswers}`,
        `- Cleanup: ${stats.cleanupErrors.length === 0 ? 'every service stopped' : stats.cleanupErrors.join('; ')}`
      );
    }
    fs.writeFileSync(path.join(this.#runDir, 'summary.md'), `${lines.join('\n')}\n`);
    process.stdout.write(
      `\nBrowser harness: ${verdict} (all implemented tests passed: ${
        hasEveryImplementedTestPassed ? 'yes' : 'no'
      }). Summary: ${path.join(this.#runDir, 'summary.md')}\n`
    );
    return leaks.length > 0 || bundleLeaks.length > 0 ? { status: 'failed' } : undefined;
  }
}

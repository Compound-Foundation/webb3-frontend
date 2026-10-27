// Writes `summary.md` for a run, after every other reporter has finished:
// - each test as passed, failed, or INCOMPLETE (skipped, interrupted or not run), with its reason
// - each acceptance criterion, from the tests' `@ACn` tags, as passed, failed or INCOMPLETE
// - the fork, the tool versions, the production builds' resolved DEV and PROD, and the proxies' counts
// - the scan of every output of the run for the run's secrets. A secret found fails the run.
import fs from 'node:fs';
import path from 'node:path';

import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

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

export default class SummaryReporter implements Reporter {
  readonly #runDir: string;
  #tests: TestCase[] = [];
  readonly #results = new Map<TestCase, TestResult>();
  readonly #output: string[] = [];
  #startedAt = Date.now();
  /** The project and spec files of the full suite that this run did not include. */
  readonly #leftOut: string[] = [];

  constructor({ runDir }: { runDir: string }) {
    this.#runDir = runDir;
  }

  printsToStdio() {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite) {
    this.#tests = suite.allTests();
    this.#startedAt = Date.now();
    // The full suite is every project and every spec file. A run filtered by project, file or title runs
    // less, and its summary says what it left out.
    const projects = config.projects.filter((project) => project.name !== 'interactive');
    const ran = new Set(
      this.#tests.map((test) => `${test.parent.project()?.name} ${path.basename(test.location.file)}`)
    );
    for (const project of projects) {
      const files = fs.readdirSync(project.testDir).filter((name) => {
        const included = [project.testMatch].flat().some((match) => match instanceof RegExp && match.test(name));
        const ignored = [project.testIgnore].flat().some((match) => match instanceof RegExp && match.test(name));
        return included && !ignored;
      });
      for (const file of files) if (!ran.has(`${project.name} ${file}`)) this.#leftOut.push(`${project.name}: ${file}`);
    }
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
        reason = `skipped: ${
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
    const productionSkipped = manifest?.production?.skipped === true;
    const bundleLeaks: { file: string; secret: string }[] = stats?.bundleSecretScan?.leaks ?? [];
    const counts = (status: string) => rows.filter((row) => row.status === status).length;
    const verdict =
      result.status !== 'passed' || counts('FAILED') > 0 || leaks.length > 0 || bundleLeaks.length > 0
        ? 'FAIL'
        : counts('INCOMPLETE') > 0 || productionSkipped || rows.length === 0 || this.#leftOut.length > 0
        ? 'INCOMPLETE'
        : 'PASS';

    const lines = [
      `# Browser fork wallet run ${path.basename(this.#runDir)}`,
      '',
      `Verdict: **${verdict}** (Playwright: ${result.status}). ${counts('passed')} passed, ${counts(
        'FAILED'
      )} failed, ${counts('INCOMPLETE')} incomplete, in ${Math.round((Date.now() - this.#startedAt) / 1000)} s.`,
      '',
    ];
    if (productionSkipped) {
      lines.push(
        `**AC7 production coverage INCOMPLETE:** the production builds were skipped (${manifest.production.reason}).`,
        ''
      );
    }
    if (this.#leftOut.length > 0) {
      lines.push(`**Scoped run, INCOMPLETE:** the run left out ${this.#leftOut.join(', ')}.`, '');
    }
    if (manifest === undefined)
      lines.push('The harness did not start: see startup-failure.txt and the test output.', '');
    lines.push('## Acceptance criteria', '', '| Criterion | Status | Tests |', '| --- | --- | --- |');
    for (const [tag, list] of [...criteria].sort(([a], [b]) => Number(a.slice(3)) - Number(b.slice(3)))) {
      lines.push(`| ${tag.slice(1)} | ${criterionStatus(list)} | ${list.length} |`);
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
      const production = manifest.production.skipped
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
        `- Git: ${manifest.git.head ?? 'unknown'}${manifest.git.dirty ? ' (dirty tree)' : ''}`,
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
    process.stdout.write(`\nBrowser harness: ${verdict}. Summary: ${path.join(this.#runDir, 'summary.md')}\n`);
    return leaks.length > 0 || bundleLeaks.length > 0 ? { status: 'failed' } : undefined;
  }
}

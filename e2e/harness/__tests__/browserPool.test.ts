/** @jest-environment node */
import { execFile, fork } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import type { FullConfig } from '@playwright/test';
import { chromium } from 'playwright-core';

import { server as mockServer } from '../../../handlers/server';
import { browserPoolCountOf, connectPoolBrowser, startBrowserPool } from '../browserPool';
import globalSetup from '../globalSetup';
import { REPO_ROOT } from '../paths';
import { findSecrets, outputsUnder, zipMembers } from '../secrets';
import { startServices } from '../services';
import { makeCertificate } from '../tls';

jest.mock('../services', () => ({ startServices: jest.fn() }));

it('rejects headed pooling and invalid counts before services start', async () => {
  const savedEnvironment = { ...process.env };
  try {
    process.env.BROWSER_WALLET_INTERACTIVE = '0';
    process.env.BROWSER_TEST_BROWSER_POOL = '1';
    const config = { workers: 2, projects: [{ name: 'dev', use: { headless: false } }] } as FullConfig;
    await expect(globalSetup(config)).rejects.toThrow(/requires headless browsers/);
    process.env.BROWSER_TEST_BROWSER_POOL = '3';
    await expect(globalSetup(config)).rejects.toThrow(/no greater than the worker count/);
    expect(startServices).not.toHaveBeenCalled();
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in savedEnvironment)) delete process.env[name];
    Object.assign(process.env, savedEnvironment);
  }
});

describe('browserPoolCountOf', () => {
  it('keeps one browser per worker unless a pool count is supplied', () => {
    for (const value of [undefined, '', '0']) {
      expect(browserPoolCountOf({ BROWSER_TEST_BROWSER_POOL: value }, 6, false)).toBe(0);
    }
    expect(browserPoolCountOf({ BROWSER_TEST_BROWSER_POOL: '4' }, 6, false)).toBe(4);
    expect(browserPoolCountOf({ BROWSER_TEST_BROWSER_POOL: '16' }, 16, false)).toBe(16);
  });

  it('rejects malformed counts, too many browsers, and interactive pooling', () => {
    for (const value of ['true', '-1', '1.5', '01', ' 1', '17', '7']) {
      expect(() => browserPoolCountOf({ BROWSER_TEST_BROWSER_POOL: value }, 6, false)).toThrow(
        /BROWSER_TEST_BROWSER_POOL/
      );
    }
    expect(() => browserPoolCountOf({ BROWSER_TEST_BROWSER_POOL: '1' }, 1, true)).toThrow(/interactive/);
    for (const debug of [{ DEBUG: 'pw:channel' }, { PWDEBUG: '1' }]) {
      expect(() => browserPoolCountOf({ BROWSER_TEST_BROWSER_POOL: '1', ...debug }, 1, false)).toThrow(/debug logging/);
      expect(browserPoolCountOf({ BROWSER_TEST_BROWSER_POOL: '0', ...debug }, 1, false)).toBe(0);
    }
  });
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function expectStopped(pids: number[]) {
  for (let attempt = 0; attempt < 50 && pids.some(isAlive); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(pids.filter(isAlive)).toEqual([]);
}

describe('the browser pool', () => {
  let privateDir: string;
  let certificate: ReturnType<typeof makeCertificate>;
  let pool: Awaited<ReturnType<typeof startBrowserPool>> | undefined;

  beforeEach(() => {
    mockServer.close();
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-pool-test-'));
    certificate = makeCertificate(privateDir);
  });

  afterEach(async () => {
    await pool?.stop();
    pool = undefined;
    fs.rmSync(privateDir, { recursive: true, force: true });
  });

  it('isolates connected clients and retains the document, snapshots and console in a trace', async () => {
    const server = https.createServer(certificate, (request, response) => {
      if (request.url === '/app.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end('console.log("pool trace console"); document.body.dataset.loaded = "yes";');
      } else {
        response.setHeader('content-type', 'text/html');
        response.end('<!doctype html><button>pool page</button><script src="/app.js"></script>');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      pool = await startBrowserPool({ count: 1, certificatePath: certificate.certPath, privateDir });
      expect(fs.statSync(pool.endpointsFile).mode & 0o777).toBe(0o600);
      expect(pool.info.servers[0].origin).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      const endpoints: string[] = JSON.parse(fs.readFileSync(pool.endpointsFile, 'utf8'));
      expect(findSecrets([{ file: 'manifest', content: JSON.stringify(pool.info) }])).toEqual([]);
      expect(findSecrets([{ file: 'private', content: endpoints[0] }])).toHaveLength(2);

      const first = await connectPoolBrowser(chromium, 0, pool.endpointsFile);
      const second = await connectPoolBrowser(chromium, 1, pool.endpointsFile);
      try {
        const firstContext = await first.newContext();
        const secondContext = await second.newContext();
        expect(first.contexts()).toEqual([firstContext]);
        expect(second.contexts()).toEqual([secondContext]);
        await secondContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
        await Promise.all(
          [firstContext, secondContext].map(async (context, index) => {
            await context.route('**', async (route) => route.fulfill({ response: await route.fetch() }));
            await context.exposeBinding('owner', () => index);
            await context.addCookies([{ name: 'owner', value: String(index), url: origin }]);
          })
        );
        const firstPage = await firstContext.newPage();
        const secondPage = await secondContext.newPage();
        await Promise.all([firstPage.goto(origin), secondPage.goto(origin)]);
        await firstPage.evaluate(() => localStorage.setItem('owner', 'first'));
        await secondPage.evaluate(() => localStorage.setItem('owner', 'second'));
        for (const [index, page] of [firstPage, secondPage].entries()) {
          expect(await page.evaluate(() => document.cookie)).toBe(`owner=${index}`);
          expect(await page.evaluate(() => (window as unknown as { owner: () => Promise<number> }).owner())).toBe(
            index
          );
          expect(await page.evaluate(() => localStorage.getItem('owner'))).toBe(index === 0 ? 'first' : 'second');
        }
        await first.close();
        expect(second.isConnected()).toBe(true);
        await secondPage.getByRole('button').click();
        expect(await secondPage.locator('body').getAttribute('data-loaded')).toBe('yes');
        const tracePath = path.join(privateDir, 'evidence', 'trace.zip');
        fs.mkdirSync(path.dirname(tracePath));
        await secondContext.tracing.stop({ path: tracePath });
        const members = zipMembers(fs.readFileSync(tracePath));
        const events = members
          .filter((member) => /trace\.(trace|network)$/.test(member.name))
          .flatMap((member) =>
            member.content
              .toString()
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line))
          );
        expect(events.some((event) => event.type === 'frame-snapshot')).toBe(true);
        expect(events.some((event) => event.type === 'screencast-frame')).toBe(true);
        expect(events.some((event) => event.type === 'console' && event.text === 'pool trace console')).toBe(true);
        for (const pathname of ['/']) {
          const resource = events.find(
            (event) => event.type === 'resource-snapshot' && event.snapshot.request.url === `${origin}${pathname}`
          );
          expect(resource.snapshot.response.status).toBe(200);
          expect(
            members.find((member) => member.name === resource.snapshot.response.content._file)?.content.length
          ).toBeGreaterThan(0);
        }
        expect(findSecrets(outputsUnder([path.dirname(tracePath)]))).toEqual([]);
      } finally {
        await first.close();
        await second.close();
      }
      const pids = pool.info.servers.flatMap((server) => [server.serverPid, server.browserPid]);
      await pool.stop();
      await expectStopped(pids);
      expect(fs.existsSync(pool.endpointsFile)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);

  it('rejects a certificate that belongs to another run', async () => {
    const otherDir = path.join(privateDir, 'other');
    fs.mkdirSync(otherDir);
    const otherCertificate = makeCertificate(otherDir);
    const server = https.createServer(otherCertificate, (_, response) => response.end('unexpected success'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      pool = await startBrowserPool({ count: 1, certificatePath: certificate.certPath, privateDir });
      const browser = await connectPoolBrowser(chromium, 0, pool.endpointsFile);
      try {
        const context = await browser.newContext();
        const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
        await expect(context.request.get(origin, { timeout: 3000 })).rejects.toThrow(/certificate/);
      } finally {
        await browser.close();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it('retains failed-test diagnostics and API response bodies through the Playwright runner', async () => {
    pool = await startBrowserPool({ count: 1, certificatePath: certificate.certPath, privateDir });
    const fixtureDir = path.join(privateDir, 'probe');
    fs.mkdirSync(fixtureDir);
    fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(fixtureDir, 'node_modules'), 'dir');
    const configFile = path.join(fixtureDir, 'playwright.config.ts');
    fs.writeFileSync(
      configFile,
      `
      export default {
        testDir: '.', testMatch: /failure.spec.ts/, workers: 1, retries: 0, timeout: 5000,
        reporter: [['json', { outputFile: './report.json' }]],
        outputDir: './results', use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
      };
    `
    );
    const server = https.createServer(certificate, (request, response) => {
      response.setHeader('content-type', request.url === '/app.js' ? 'text/javascript' : 'text/html');
      response.end(
        request.url === '/app.js'
          ? 'console.log("runner trace console"); document.body.dataset.loaded = "yes";'
          : '<button>actual text</button><script src="/app.js"></script>'
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    fs.writeFileSync(
      path.join(fixtureDir, 'failure.spec.ts'),
      `
      import { test as base, expect } from '@playwright/test';
      import { connectPoolBrowser } from ${JSON.stringify(path.join(REPO_ROOT, 'e2e/harness/browserPool'))};
      const test = base.extend({
        preparedPoolConnection: [async ({ playwright }, use) => {
          const browser = await connectPoolBrowser(playwright.chromium, 0, process.env.PROBE_POOL_FILE);
          try { await use(browser); } finally { await browser.close(); }
        }, { scope: 'worker', auto: true }],
        browser: [async ({ preparedPoolConnection }, use) => use(preparedPoolConnection), { scope: 'worker' }],
      });
      test('intentional diagnostic failure', async ({ page, context }) => {
        await context.route('**', async (route) => route.fulfill({ response: await route.fetch() }));
        await page.goto(${JSON.stringify(origin)});
        await expect(page.locator('body')).toHaveAttribute('data-loaded', 'yes');
        await expect(page.getByRole('button')).toHaveText('deliberately wrong text', { timeout: 100 });
      });
    `
    );
    try {
      const runProbe = (endpointsFile: string, debug?: string) =>
        new Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }>((resolve) => {
          execFile(
            process.execPath,
            [path.join(REPO_ROOT, 'node_modules/@playwright/test/cli.js'), 'test', '-c', configFile],
            {
              cwd: fixtureDir,
              env: { ...process.env, DEBUG: debug, JEST_WORKER_ID: undefined, PROBE_POOL_FILE: endpointsFile },
              timeout: 15_000,
            },
            (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr })
          );
        });
      const output = await runProbe(pool.endpointsFile);
      expect(output.code).toBe(1);
      const report = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'report.json'), 'utf8'));
      expect(report.errors).toEqual([]);
      const result = report.suites[0].specs[0].tests[0].results[0];
      expect(result.status).toBe('failed');
      expect(result.errors[0].message).toContain('deliberately wrong text');
      expect(result.attachments.map((attachment: { name: string }) => attachment.name)).toEqual(
        expect.arrayContaining(['screenshot', 'trace'])
      );
      const trace = result.attachments.find((attachment: { name: string }) => attachment.name === 'trace');
      const members = zipMembers(fs.readFileSync(trace.path));
      const evidence = members.map((member) => member.content.toString()).join('\n');
      expect(evidence).toContain('runner trace console');
      expect(evidence).toContain('deliberately wrong text');
      expect(members.some((member) => member.name.startsWith('src/'))).toBe(true);
      const network = members
        .filter((member) => member.name.endsWith('.network'))
        .flatMap((member) =>
          member.content
            .toString()
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        );
      for (const pathname of ['/', '/app.js']) {
        const resources = network.filter(
          (event) => event.type === 'resource-snapshot' && event.snapshot.request.url === `${origin}${pathname}`
        );
        expect(
          resources.some((event) =>
            members.some((member) => member.name === event.snapshot.response.content._file && member.content.length > 0)
          )
        ).toBe(true);
      }
      const outputs = outputsUnder([path.join(fixtureDir, 'results'), path.join(fixtureDir, 'report.json')]);
      expect(
        findSecrets([
          ...outputs,
          { file: 'stdout', content: output.stdout },
          { file: 'stderr', content: output.stderr },
        ])
      ).toEqual([]);
      const refusedDebug = await runProbe(pool.endpointsFile, 'pw:channel');
      expect(refusedDebug.code).toBe(1);
      expect(fs.readFileSync(path.join(fixtureDir, 'report.json'), 'utf8')).toContain(
        'debug logging can expose browser endpoints'
      );
      expect(
        findSecrets([
          ...outputsUnder([path.join(fixtureDir, 'results'), path.join(fixtureDir, 'report.json')]),
          { file: 'stdout', content: refusedDebug.stdout },
          { file: 'stderr', content: refusedDebug.stderr },
        ])
      ).toEqual([]);
      const staleFile = path.join(privateDir, 'stale-endpoints.json');
      fs.copyFileSync(pool.endpointsFile, staleFile);
      await pool.stop();
      const failedConnection = await runProbe(staleFile);
      expect(failedConnection.code).toBe(1);
      const failedReport = fs.readFileSync(path.join(fixtureDir, 'report.json'), 'utf8');
      expect(failedReport).toContain('could not connect to its browser pool server');
      expect(
        findSecrets([
          ...outputsUnder([path.join(fixtureDir, 'results'), path.join(fixtureDir, 'report.json')]),
          { file: 'stdout', content: failedConnection.stdout },
          { file: 'stderr', content: failedConnection.stderr },
        ])
      ).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 25_000);

  it('reports a connection failure without the private endpoint or its cause', async () => {
    const endpointsFile = path.join(privateDir, 'unreachable.json');
    const endpoint = 'ws://127.0.0.1:1/secret-browser-capability';
    fs.writeFileSync(endpointsFile, JSON.stringify([endpoint]));
    await expect(connectPoolBrowser(chromium, 3, endpointsFile)).rejects.toMatchObject({
      message: 'Worker 3 could not connect to its browser pool server.',
    });
    try {
      await connectPoolBrowser(chromium, 3, endpointsFile);
    } catch (error) {
      expect(String((error as Error).stack)).not.toContain('secret-browser-capability');
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  }, 10_000);

  it('stops sibling children before rejecting a startup failure', async () => {
    const workerFile = path.join(privateDir, 'failed-worker.mjs');
    const pidsFile = path.join(privateDir, 'children');
    fs.writeFileSync(
      workerFile,
      `
      import fs from 'node:fs';
      fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
      process.on('SIGTERM', () => process.exit(0));
      setTimeout(() => process.send({ kind: 'failed' }), 200);
    `
    );
    await expect(
      startBrowserPool({ count: 2, certificatePath: certificate.certPath, privateDir, workerFile })
    ).rejects.toThrow(/failed to start/);
    await expectStopped(fs.readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number));
    expect(fs.existsSync(path.join(privateDir, 'browser-pool-endpoints.json'))).toBe(false);
  }, 10_000);

  it('closes Chromium when the runner disappears and its IPC channel disconnects', async () => {
    const ownerFile = path.join(privateDir, 'owner.mjs');
    fs.writeFileSync(
      ownerFile,
      `
      import { fork } from 'node:child_process';
      const child = fork(${JSON.stringify(path.join(REPO_ROOT, 'e2e/harness/browserPoolWorker.mjs'))},
        [${JSON.stringify(certificate.certPath)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.on('message', (message) => {
        if (message.kind === 'ready') process.send({ browserPid: message.browserPid, serverPid: child.pid });
      });
    `
    );
    const owner = fork(ownerFile, { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try {
      const pids = await new Promise<{ browserPid: number; serverPid: number }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The fixture owner did not start.')), 10_000);
        owner.once('message', (message) => {
          clearTimeout(timeout);
          resolve(message as { browserPid: number; serverPid: number });
        });
      });
      owner.kill('SIGKILL');
      await expectStopped([pids.browserPid, pids.serverPid]);
    } finally {
      owner.kill('SIGKILL');
    }
  }, 20_000);
});

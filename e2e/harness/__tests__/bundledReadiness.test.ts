/** @jest-environment node */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright-core';
import type { Browser, BrowserContext } from 'playwright-core';

import { server as mockServer } from '../../../handlers/server';
import { applyEgress, DOCUMENT_POLICY, MAX_REDIRECTS } from '../egress';
import type { BlockedRequest } from '../egress';
import { LANE_HEADER } from '../laneHeader';
import { REPO_ROOT } from '../paths';
import { zipMembers } from '../secrets';

const fallbackHtml = `<!doctype html><html><head>
<script>globalThis.__vite_is_fallback_page__ = true</script>
</head><body><h1>Bundling in progress</h1></body></html>`;
const appHtml = '<!doctype html><body>Ready<script src="/app.js"></script></body>';

describe('bundled dev compiler readiness at the egress boundary', () => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  const servers: http.Server[] = [];

  beforeAll(async () => {
    mockServer.close();
    browser = await chromium.launch();
  });

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((context) => context.close()));
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          })
      )
    );
  });

  afterAll(async () => browser?.close());

  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  async function prepare(origin: string, readinessTimeoutMs = 2000, additionalOrigins: string[] = []) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    contexts.push(context);
    const blocked: BlockedRequest[] = [];
    await applyEgress(
      context,
      { http: new Set([origin, ...additionalOrigins]), webSocket: new Set() },
      blocked,
      { origins: new Set([origin]), value: '2' },
      { bundledDev: { origin, readinessTimeoutMs } }
    );
    return { context, blocked, page: await context.newPage() };
  }

  it('holds one browser navigation through two fallback documents with fresh cookies and the lane header', async () => {
    let documents = 0;
    const received: http.IncomingHttpHeaders[] = [];
    const origin = await serve((request, response) => {
      if (request.url === '/app.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end('document.body.dataset.ready = "yes"; console.log("real application marker");');
        return;
      }
      documents += 1;
      received.push(request.headers);
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('set-cookie', `compilation=${documents}; Path=/`);
      response.end(documents <= 2 ? fallbackHtml : appHtml);
    });
    const { blocked, page } = await prepare(origin);
    const navigations: string[] = [];
    const consoleMessages: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    page.on('console', (message) => consoleMessages.push(message.text()));
    const response = await page.goto(origin);
    expect(await page.locator('body').getAttribute('data-ready')).toBe('yes');
    expect(consoleMessages).toContain('real application marker');
    expect(navigations).toEqual([`${origin}/`]);
    expect(documents).toBe(3);
    expect(received.map((headers) => headers[LANE_HEADER])).toEqual(['2', '2', '2']);
    expect(received.map((headers) => headers.cookie)).toEqual([undefined, 'compilation=1', 'compilation=2']);
    expect(response?.headers()['content-security-policy']).toBe(DOCUMENT_POLICY);
    expect(blocked).toEqual([]);
  });

  it('retains intermediate fallback bodies in the browser runner trace before disposing the responses', async () => {
    let documents = 0;
    const origin = await serve((_, response) => {
      documents += 1;
      response.setHeader('content-type', 'text/html');
      response.end(documents <= 2 ? fallbackHtml : '<body>Application ready</body>');
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-readiness-trace-'));
    try {
      fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
      const configFile = path.join(directory, 'playwright.config.ts');
      fs.writeFileSync(
        configFile,
        `export default {
          testDir: '.', testMatch: /readiness.spec.ts/, workers: 1, retries: 0, timeout: 5000,
          reporter: [['json', { outputFile: './report.json' }]],
          outputDir: './results', use: { trace: 'on' },
        };`
      );
      fs.writeFileSync(
        path.join(directory, 'readiness.spec.ts'),
        `import { test, expect } from '@playwright/test';
        import { applyEgress } from ${JSON.stringify(path.join(REPO_ROOT, 'e2e/harness/egress'))};
        test('records compiler placeholders', async ({ context, page }) => {
          await applyEgress(context, { http: new Set([${JSON.stringify(
            origin
          )}]), webSocket: new Set() }, [], undefined,
            { bundledDev: { origin: ${JSON.stringify(origin)}, readinessTimeoutMs: 2000 } });
          await page.goto(${JSON.stringify(origin)});
          await expect(page.locator('body')).toHaveText('Application ready');
        });`
      );
      await new Promise<void>((resolve, reject) => {
        execFile(
          process.execPath,
          [path.join(REPO_ROOT, 'node_modules/@playwright/test/cli.js'), 'test', '-c', configFile],
          { cwd: directory, env: { ...process.env, JEST_WORKER_ID: undefined }, timeout: 12_000 },
          (error, stdout, stderr) => (error ? reject(new Error(`${stdout}\n${stderr}`)) : resolve())
        );
      });
      const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
      const result = report.suites[0].specs[0].tests[0].results[0];
      expect(result.status).toBe('passed');
      const trace = result.attachments.find((attachment: { name: string }) => attachment.name === 'trace');
      const members = zipMembers(fs.readFileSync(trace.path));
      const events = members
        .filter((member) => member.name.endsWith('.network'))
        .flatMap((member) =>
          member.content
            .toString()
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        );
      const documents = events.filter(
        (event) => event.type === 'resource-snapshot' && event.snapshot.request.url === `${origin}/`
      );
      const bodies = documents.map((event) =>
        members.find((member) => member.name === event.snapshot.response.content._file)?.content.toString()
      );
      expect(bodies.filter((body) => body === fallbackHtml)).toHaveLength(2);
      expect(bodies).toContain('<body>Application ready</body>');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it.each([
    ['normal HTML', 200, 'text/html', appHtml],
    ['compiler error', 500, 'text/html', '<h1>Compiler failed: syntax error</h1>'],
    ['fallback with an HTTP error', 500, 'text/html', fallbackHtml],
    [
      'ordinary marker text',
      200,
      'text/html',
      '<h1>Bundling in progress</h1><pre>globalThis.__vite_is_fallback_page__ = true</pre>',
    ],
    [
      'a script string',
      200,
      'text/html',
      '<h1>Bundling in progress</h1><script>const example = "globalThis.__vite_is_fallback_page__ = true";</script>',
    ],
    ['non-HTML content', 200, 'text/plain', fallbackHtml],
    ['an HTML comment', 200, 'text/html', `<!-- ${fallbackHtml} --><body>Ordinary application</body>`],
  ])('passes through %s once', async (_, status, contentType, body) => {
    let documents = 0;
    const origin = await serve((request, response) => {
      if (request.url === '/app.js') {
        response.setHeader('content-type', 'text/javascript');
        response.end('document.body.dataset.ready = "yes";');
        return;
      }
      documents += 1;
      response.writeHead(status, { 'content-type': contentType });
      response.end(body);
    });
    const { page, blocked } = await prepare(origin);
    const response = await page.goto(origin);
    expect(response?.status()).toBe(status);
    expect(await response?.text()).toBe(body);
    expect(documents).toBe(1);
    expect(blocked).toEqual([]);
  });

  it('passes through a compiler error reached after a fallback without retrying the error', async () => {
    let documents = 0;
    const origin = await serve((_, response) => {
      documents += 1;
      response.writeHead(documents === 1 ? 200 : 500, { 'content-type': 'text/html' });
      response.end(documents === 1 ? fallbackHtml : '<h1>Build failed: syntax error</h1>');
    });
    const { page, blocked } = await prepare(origin);
    const response = await page.goto(origin);
    expect(response?.status()).toBe(500);
    expect(await response?.text()).toContain('Build failed: syntax error');
    expect(documents).toBe(2);
    expect(blocked).toEqual([]);
  });

  it('leaves fallback documents unchanged when the gate is absent or the final origin differs', async () => {
    const requests: string[] = [];
    const otherOrigin = await serve((_, response) => {
      requests.push('other');
      response.setHeader('content-type', 'text/html');
      response.end(fallbackHtml);
    });
    const origin = await serve((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/redirect') {
        response.writeHead(302, { location: otherOrigin });
        response.end();
      } else {
        response.setHeader('content-type', 'text/html');
        response.end(fallbackHtml);
      }
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    contexts.push(context);
    await applyEgress(context, { http: new Set([origin]), webSocket: new Set() }, []);
    const ungatedPage = await context.newPage();
    expect(await (await ungatedPage.goto(origin))?.text()).toBe(fallbackHtml);
    const { page } = await prepare(origin, 2000, [otherOrigin]);
    expect(await (await page.goto(`${origin}/redirect`))?.text()).toBe(fallbackHtml);
    expect(requests).toEqual(['/', '/redirect', 'other']);
  });

  it('passes through fallback-shaped API, script, and POST document responses once', async () => {
    const requests: string[] = [];
    const origin = await serve((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'text/html');
      response.end(request.url === '/' ? '<body>Application</body>' : fallbackHtml);
    });
    const { page, blocked } = await prepare(origin);
    await page.goto(origin);
    expect(await page.evaluate(() => fetch('/api').then((response) => response.text()))).toBe(fallbackHtml);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const script = document.createElement('script');
          script.src = '/script';
          script.onload = script.onerror = () => resolve();
          document.body.append(script);
        })
    );
    await Promise.all([
      page.waitForNavigation(),
      page.evaluate(() => {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '/submit';
        document.body.append(form);
        form.submit();
      }),
    ]);
    expect(await page.content()).toContain('Bundling in progress');
    expect(requests).toEqual(['GET /', 'GET /api', 'GET /script', 'POST /submit']);
    expect(blocked).toEqual([]);
  });

  it('keeps the five-redirect limit for each poll while allowing more than five fallback responses', async () => {
    let documents = 0;
    let redirects = 0;
    const origin = await serve((request, response) => {
      if (request.url === '/document') {
        documents += 1;
        response.setHeader('content-type', 'text/html');
        response.end(documents <= MAX_REDIRECTS + 1 ? fallbackHtml : '<body>Application ready</body>');
      } else {
        redirects += 1;
        response.writeHead(302, { location: redirects < MAX_REDIRECTS ? `/hop/${redirects}` : '/document' });
        response.end();
      }
    });
    const { page, blocked } = await prepare(origin);
    await page.goto(origin);
    expect(await page.locator('body').textContent()).toBe('Application ready');
    expect(redirects).toBe(MAX_REDIRECTS);
    expect(documents).toBe(MAX_REDIRECTS + 2);
    expect(blocked).toEqual([]);
  });

  it('blocks a retry redirect chain after five hops', async () => {
    let requests = 0;
    const origin = await serve((request, response) => {
      requests += 1;
      if (requests === 1) {
        response.setHeader('content-type', 'text/html');
        response.end(fallbackHtml);
      } else {
        const hop = Number(request.url?.split('/').pop() ?? '') || 0;
        response.writeHead(302, { location: `/hop/${hop + 1}` });
        response.end();
      }
    });
    const { page, blocked } = await prepare(origin);
    await expect(page.goto(origin)).rejects.toThrow();
    expect(requests).toBe(MAX_REDIRECTS + 2);
    expect(blocked).toEqual([{ kind: 'redirect', url: `${origin}/hop/6`, from: `${origin}/hop/5`, method: 'GET' }]);
  });

  it('checks a fallback retry redirect before contacting a forbidden sink', async () => {
    let sinkRequests = 0;
    const sink = await serve((_, response) => {
      sinkRequests += 1;
      response.end('forbidden');
    });
    let documents = 0;
    const origin = await serve((_, response) => {
      documents += 1;
      if (documents === 1) {
        response.setHeader('content-type', 'text/html');
        response.end(fallbackHtml);
      } else {
        response.writeHead(302, { location: `${sink}/forbidden?secret=hidden` });
        response.end();
      }
    });
    const { page, blocked } = await prepare(origin);
    await expect(page.goto(origin)).rejects.toThrow();
    expect(documents).toBe(2);
    expect(sinkRequests).toBe(0);
    expect(blocked).toEqual([{ kind: 'redirect', url: `${sink}/forbidden`, from: `${origin}/`, method: 'GET' }]);
  });

  it('strips authorization and the lane header when a fallback poll redirects to another allowed origin', async () => {
    const received: http.IncomingHttpHeaders[] = [];
    const destination = await serve((request, response) => {
      received.push(request.headers);
      response.setHeader('content-type', 'text/html');
      response.end('<body>Allowed destination</body>');
    });
    let documents = 0;
    const origin = await serve((_, response) => {
      documents += 1;
      if (documents === 1) {
        response.setHeader('content-type', 'text/html');
        response.end(fallbackHtml);
      } else {
        response.writeHead(302, { location: destination });
        response.end();
      }
    });
    const { page, blocked } = await prepare(origin, 2000, [destination]);
    await page.setExtraHTTPHeaders({ authorization: 'Bearer local-test-only', [LANE_HEADER]: 'forged' });
    await page.goto(origin);
    expect(await page.locator('body').textContent()).toBe('Allowed destination');
    expect(documents).toBe(2);
    expect(received).toHaveLength(1);
    expect(received[0].authorization).toBeUndefined();
    expect(received[0][LANE_HEADER]).toBeUndefined();
    expect(blocked).toEqual([]);
  });

  it('bounds a compiler that never leaves its fallback and records the readiness deadline', async () => {
    let documents = 0;
    const origin = await serve((_, response) => {
      documents += 1;
      response.setHeader('content-type', 'text/html');
      response.end(fallbackHtml);
    });
    const { page, context, blocked } = await prepare(origin, 250);
    const startedAt = Date.now();
    await expect(page.goto(origin, { timeout: 2000 })).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(documents).toBeGreaterThanOrEqual(2);
    expect(blocked).toEqual([
      expect.objectContaining({ kind: 'compiler-readiness', url: `${origin}/`, method: 'GET', timeoutMs: 250 }),
    ]);
    const documentsAtDeadline = documents;
    await context.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(documents).toBe(documentsAtDeadline);
  });

  it('bounds a held re-fetch with the same readiness deadline', async () => {
    let documents = 0;
    const origin = await serve((_, response) => {
      documents += 1;
      if (documents === 1) {
        response.setHeader('content-type', 'text/html');
        response.end(fallbackHtml);
      }
    });
    const { page, blocked } = await prepare(origin, 250);
    const startedAt = Date.now();
    await expect(page.goto(origin, { timeout: 2000 })).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1500);
    expect(documents).toBe(2);
    expect(blocked).toEqual([expect.objectContaining({ kind: 'compiler-readiness', timeoutMs: 250 })]);
  });

  it('closes the context promptly while a compiler re-fetch is held', async () => {
    let documents = 0;
    let signalRetry: () => void = () => undefined;
    const retryReceived = new Promise<void>((resolve) => (signalRetry = resolve));
    const origin = await serve((_, response) => {
      documents += 1;
      if (documents === 1) {
        response.setHeader('content-type', 'text/html');
        response.end(fallbackHtml);
      } else {
        signalRetry();
      }
    });
    const { page, context } = await prepare(origin);
    const navigation = page.goto(origin).catch(() => undefined);
    await retryReceived;
    const startedAt = Date.now();
    await context.close();
    await navigation;
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(documents).toBe(2);
  });
});

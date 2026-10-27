// AC8 and AC9: the harness's own boundaries.
//
// - The browser reaches only the app, the RPC proxy and the screening stub. The raw anvil fork, the upstream
//   proxy, the wallet server and every other host are blocked, over HTTP and WebSocket.
// - The RPC proxy refuses every write and administrative method on every route.
// - The wallet binding answers only the app's top frame, and only provider calls and the events poll.
// - Every harness service listens on 127.0.0.1, read from the processes' real sockets.
// - The control API needs the per-run token, its own Host, and no Origin. The real token is used only from
//   Node; the page only ever sees a made-up one.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

import { encodeFunctionData } from 'viem';

import { ERC20_ABI, USDC } from '../harness/contracts';
import { applyEgress, type BlockedRequest } from '../harness/egress';
import { connectAccount, expect, openApp, providerRequest, selectedAccount, test } from '../harness/fixtures';
import { BINDING_NAME } from '../harness/injectedProvider';

const FAKE_TOKEN = 'not-the-run-token';

type Received = { method: string; url: string };

/** A loopback server that records each request and answers `answer(url)`, or 200 with the URL. */
async function recordingServer(
  answer: (url: string) => { status: number; location?: string } | undefined = () => undefined
) {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    received.push({ method: request.method ?? '', url: request.url ?? '' });
    const redirect = answer(request.url ?? '');
    if (redirect !== undefined) {
      response.writeHead(redirect.status, redirect.location === undefined ? {} : { location: redirect.location });
      return response.end();
    }
    response.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
    response.end(`served ${request.url}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    received,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

/** A request to the control API from Node, with the headers given, which `fetch` would not let a test set. */
function controlRequest(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL('/v1/health', url);
    const request = http.request(
      { host: '127.0.0.1', port: target.port, path: target.pathname, method: 'GET', headers },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );
    request.on('error', reject);
    request.end();
  });
}

/** The TCP addresses that process `pid` listens on, from the operating system. */
function listeningAddresses(pid: number): string[] {
  const output = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], {
    encoding: 'utf8',
  });
  return output
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
}

test.describe('harness boundaries', { tag: ['@AC8', '@AC9'] }, () => {
  test('the browser cannot reach the fork, the upstream proxy, the wallet server or any other host', async ({
    page,
    manifest,
    blocked,
  }) => {
    await openApp(page);
    const targets = [
      manifest.fork.localUrl,
      manifest.fork.upstreamProxyUrl,
      `${manifest.services.wallet}/v1/health`,
      'https://rpc.scroll.io/',
      'https://example.com/',
    ];
    const results = await page.evaluate(
      async ({ targets, token }) =>
        Promise.all(
          targets.map(async (url) => {
            try {
              const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_accounts', params: [] }),
              });
              return { url, status: response.status };
            } catch (error) {
              return { url, failed: String(error) };
            }
          })
        ),
      { targets, token: FAKE_TOKEN }
    );
    for (const result of results)
      expect(result, result.url).toEqual({ url: result.url, failed: expect.stringContaining('Failed to fetch') });
    const webSockets = await page.evaluate(
      async (urls) =>
        Promise.all(
          urls.map(
            (url) =>
              new Promise<{ url: string; messages: number; closed: boolean }>((resolve) => {
                let messages = 0;
                const socket = new WebSocket(url);
                socket.onopen = () =>
                  socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_accounts', params: [] }));
                socket.onmessage = () => (messages += 1);
                socket.onclose = () => resolve({ url, messages, closed: true });
                setTimeout(() => resolve({ url, messages, closed: socket.readyState === WebSocket.CLOSED }), 5_000);
              })
          )
        ),
      [manifest.fork.localUrl.replace('http:', 'ws:'), 'wss://example.com/']
    );
    for (const result of webSockets) expect(result, result.url).toEqual({ url: result.url, messages: 0, closed: true });
    const blockedUrls = blocked.map((entry) => `${entry.kind} ${entry.url}`);
    expect(blockedUrls).toEqual(
      expect.arrayContaining([
        `http ${manifest.fork.localUrl}/`,
        `http ${manifest.fork.upstreamProxyUrl}`,
        `http ${manifest.services.wallet}/v1/health`,
        `websocket ${manifest.fork.localUrl.replace('http:', 'ws:')}/`,
        'websocket wss://example.com/',
      ])
    );
  });

  test('egress checks every redirect hop, and allows only GET and HEAD under a read-only prefix', async ({
    browser,
  }) => {
    // A denied loopback origin, except for its read-only `/v3/market` prefix, as the optional v3 API has.
    const denied = await recordingServer();
    const allowed = await recordingServer((url) => {
      if (url === '/to-denied') return { status: 302, location: `${denied.origin}/forbidden` };
      if (url === '/to-external') return { status: 307, location: 'https://example.com/' };
      if (url === '/chain') return { status: 301, location: '/hop' };
      if (url === '/hop') return { status: 302, location: `${denied.origin}/after-two-hops` };
      if (url === '/to-allowed') return { status: 302, location: '/final' };
      if (url === '/to-read-only') return { status: 303, location: `${denied.origin}/v3/market/redirected` };
      return undefined;
    });
    const blocked: BlockedRequest[] = [];
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      await applyEgress(
        context,
        { http: new Set([allowed.origin]), readOnly: new Set([`${denied.origin}/v3/market`]), webSocket: new Set() },
        blocked
      );
      const page = await context.newPage();
      await page.goto(`${allowed.origin}/`);
      const answers = await page.evaluate(async (deniedOrigin) => {
        const attempt = async (url: string, init?: RequestInit) => {
          try {
            const response = await fetch(url, init);
            return `${response.status} ${await response.text()}`;
          } catch (error) {
            return String(error);
          }
        };
        return {
          toDenied: await attempt('/to-denied'),
          toExternal: await attempt('/to-external'),
          chain: await attempt('/chain'),
          toAllowed: await attempt('/to-allowed'),
          toReadOnly: await attempt('/to-read-only'),
          readOnlyGet: await attempt(`${deniedOrigin}/v3/market/summary`),
          readOnlyPost: await attempt(`${deniedOrigin}/v3/market/summary`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x00'] }),
          }),
          outsideReadOnly: await attempt(`${deniedOrigin}/v3/admin`),
        };
      }, denied.origin);
      expect(answers.toDenied).toContain('Failed to fetch');
      expect(answers.toExternal).toContain('Failed to fetch');
      expect(answers.chain).toContain('Failed to fetch');
      expect(answers.toAllowed).toBe('200 served /final');
      expect(answers.toReadOnly).toBe('200 served /v3/market/redirected');
      expect(answers.readOnlyGet).toBe('200 served /v3/market/summary');
      expect(answers.readOnlyPost).toContain('Failed to fetch');
      expect(answers.outsideReadOnly).toContain('Failed to fetch');
      // The denied server saw only the two read-only GETs: no redirected hop and no POST reached it.
      expect(denied.received).toEqual([
        { method: 'GET', url: '/v3/market/redirected' },
        { method: 'GET', url: '/v3/market/summary' },
      ]);
      expect(blocked).toEqual(
        expect.arrayContaining([
          { kind: 'redirect', url: `${denied.origin}/forbidden`, from: `${allowed.origin}/to-denied`, method: 'GET' },
          { kind: 'redirect', url: 'https://example.com/', from: `${allowed.origin}/to-external`, method: 'GET' },
          { kind: 'redirect', url: `${denied.origin}/after-two-hops`, from: `${allowed.origin}/hop`, method: 'GET' },
          { kind: 'http', url: `${denied.origin}/v3/market/summary`, method: 'POST' },
          { kind: 'http', url: `${denied.origin}/v3/admin`, method: 'GET' },
        ])
      );
    } finally {
      await context.close();
      await denied.close();
      await allowed.close();
    }
  });

  test('the RPC proxy refuses writes and fork administration from the page, on every route, and serves reads', async ({
    page,
    manifest,
    fork,
  }) => {
    await openApp(page);
    const target = '0x000000000000000000000000000000000000dEaD';
    const before = await fork.getBalance({ address: target });
    const calls = [
      ['eth_sendRawTransaction', ['0x02f86c0180808080809400000000000000000000000000000000000000008080c0808080']],
      ['eth_sendTransaction', [{ from: target, to: target, value: '0x1' }]],
      ['anvil_setBalance', [target, '0xffffffffffffffffffff']],
      ['anvil_impersonateAccount', [target]],
      ['evm_snapshot', []],
      ['hardhat_setBalance', [target, '0x1']],
      ['personal_sign', ['0x00', target]],
      ['eth_accounts', []],
      ['debug_traceCall', [{}, 'latest']],
    ] as const;
    const answers = await page.evaluate(
      async ({ rpcProxy, calls, usdcCall }) => {
        const post = async (route: string, body: unknown) =>
          (
            await fetch(`${rpcProxy}${route}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            })
          ).json();
        const refused = [];
        for (const route of ['/ethereum-mainnet', '/base-mainnet', '/arbitrum-mainnet']) {
          for (const [method, params] of calls)
            refused.push({ route, method, answer: await post(route, { jsonrpc: '2.0', id: 1, method, params }) });
        }
        const batch = await post('/ethereum-mainnet', [
          { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
          { jsonrpc: '2.0', id: 2, method: 'anvil_mine', params: [] },
        ]);
        const read = await post('/ethereum-mainnet', {
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_call',
          params: [{ to: usdcCall.to, data: usdcCall.data }, 'latest'],
        });
        const unserved = await post('/base-mainnet', { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
        return { refused, batch, read, unserved };
      },
      {
        rpcProxy: manifest.services.rpcProxy,
        calls: calls as unknown as [string, unknown[]][],
        usdcCall: { to: USDC, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [target] }) },
      }
    );
    for (const { route, method, answer } of answers.refused)
      expect(answer.error?.code, `${method} on ${route}`).toBe(-32601);
    expect(answers.batch.map((entry: { error?: { code: number } }) => entry.error?.code)).toEqual([-32603, -32601]);
    expect(answers.read.result).toMatch(/^0x[0-9a-f]{64}$/);
    expect(answers.unserved.error?.code).toBe(-32000);
    expect(await fork.getBalance({ address: target })).toBe(before);
  });

  test('the page cannot read the harness private directory through the dev server', async ({ page, manifest }) => {
    await openApp(page);
    const answer = await page.evaluate(async (path) => {
      const response = await fetch(`/@fs${path}`);
      const text = await response.text();
      return { status: response.status, length: text.length, looksLikeToken: /^[0-9a-f]{64}$/.test(text.trim()) };
    }, manifest.tokenFile);
    expect(answer.status).not.toBe(200);
    expect(answer.looksLikeToken).toBe(false);
  });

  test('the wallet binding answers only the app top frame, and only provider calls', async ({
    page,
    wallet,
    manifest,
  }) => {
    const account = await selectedAccount(wallet, '0');
    await page.goto('/extensions/cfharness');
    await connectAccount(page, wallet, account);
    // In the app's top frame: provider calls only.
    expect(await providerRequest(page, 'eth_accounts')).toEqual({ result: [account.toLowerCase()] });
    const unknown = await page.evaluate(
      (name) =>
        (window as unknown as Record<string, (payload: unknown) => Promise<unknown>>)[name]({
          kind: 'control',
          path: '/v1/reset',
        }),
      BINDING_NAME
    );
    expect(unknown).toEqual({ error: { code: 4200, message: 'harness: unknown wallet call' } });
    // In the extension frame, which another origin serves: no provider is injected, and the binding refuses.
    const frame = page
      .frames()
      .find((each) => each !== page.mainFrame() && each.url().startsWith(manifest.services.screening));
    expect(frame).toBeDefined();
    const inFrame = await frame?.evaluate(async (name) => {
      let announced = false;
      window.addEventListener('eip6963:announceProvider', () => (announced = true));
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      const answer = await (window as unknown as Record<string, (payload: unknown) => Promise<unknown>>)[name]({
        kind: 'rpc',
        method: 'eth_accounts',
        params: [],
      });
      return { announced, answer };
    }, BINDING_NAME);
    expect(inFrame).toEqual({
      announced: false,
      answer: { error: { code: 4100, message: "harness: only the app page's top frame may use the wallet" } },
    });
    // After a navigation of the top frame to another origin: no provider, and the binding refuses.
    await page.goto(manifest.services.extensionUrl);
    const elsewhere = await page.evaluate(
      (name) =>
        (window as unknown as Record<string, (payload: unknown) => Promise<unknown>>)[name]({
          kind: 'rpc',
          method: 'eth_accounts',
          params: [],
        }),
      BINDING_NAME
    );
    expect(elsewhere).toEqual({ error: { code: 4100, message: 'harness: the page is not the app' } });
    expect((await wallet.requests()).map((request) => request.method)).toEqual(['wallet_requestPermissions']);
  });

  test('every harness service listens on 127.0.0.1 only', async ({ manifest }) => {
    // The workers are children of the Playwright runner, which runs the services in-process.
    const runner = listeningAddresses(process.ppid);
    const anvil = listeningAddresses(manifest.fork.anvilPid);
    // The upstream proxy, RPC proxy, screening stub, wallet server and dev server, and the two production
    // servers when the builds ran. Vite's HMR shares the dev server's port.
    expect(runner.length).toBe(5 + (manifest.production.skipped ? 0 : 2));
    for (const address of [...runner, ...anvil]) expect(address).toMatch(/^127\.0\.0\.1:\d+$/);
    const ports = new Set([...runner, ...anvil].map((address) => address.split(':')[1]));
    for (const url of Object.values(manifest.services.bindings)) {
      const port = /:(\d+)/.exec(url)?.[1];
      expect(ports.has(port as string), url).toBe(true);
    }
    expect(anvil).toEqual([`127.0.0.1:${new URL(manifest.fork.localUrl).port}`]);
  });

  test('the control API needs the run token, its own Host and no Origin', async ({ manifest }) => {
    const url = manifest.services.wallet;
    const host = new URL(url).host;
    const token = fs.readFileSync(manifest.tokenFile, 'utf8').trim();
    expect(fs.statSync(manifest.tokenFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(manifest.privateDir).mode & 0o777).toBe(0o700);
    expect(await controlRequest(url, { host })).toBe(401);
    expect(await controlRequest(url, { host, authorization: `Bearer ${FAKE_TOKEN}` })).toBe(401);
    expect(
      await controlRequest(url, {
        host,
        authorization: `Bearer ${token.replace(/.$/, (last) => (last === '0' ? '1' : '0'))}`,
      })
    ).toBe(401);
    expect(await controlRequest(url, { host, authorization: `Bearer ${token}x` })).toBe(401);
    expect(
      await controlRequest(url, { host, authorization: `Bearer ${token}`, origin: 'http://attacker.example' })
    ).toBe(403);
    expect(await controlRequest(url, { host, authorization: `Bearer ${token}`, origin: 'null' })).toBe(403);
    expect(await controlRequest(url, { host, authorization: `Bearer ${token}`, origin: manifest.app.devOrigin })).toBe(
      403
    );
    expect(
      await controlRequest(url, { host: `localhost:${new URL(url).port}`, authorization: `Bearer ${token}` })
    ).toBe(403);
    expect(await controlRequest(url, { host: 'attacker.example', authorization: `Bearer ${token}` })).toBe(403);
    expect(await controlRequest(url, { host, authorization: `Bearer ${token}` })).toBe(200);
  });
});

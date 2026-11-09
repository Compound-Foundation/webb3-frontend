/**
 * @jest-environment node
 */
// Bundled dev selection, private-file refusals and the dev server's connection lifetime.
import http from 'node:http';

import { createServer } from 'vite';

import { server as mockServer } from '../../../handlers/server';
import { BUNDLED_DEV_CONFIG, denyRawFs, devBundledOf, isRawFsRequest, startDevServer } from '../viteApp';

// Vite ships ESM only. The HTTP lifetime test substitutes middleware while exercising the real harness server.
jest.mock('vite', () => ({ createServer: jest.fn() }));

test('selects bundled dev only when BROWSER_TEST_BUNDLED_DEV is 1', () => {
  for (const value of [undefined, '', '0']) expect(devBundledOf({ BROWSER_TEST_BUNDLED_DEV: value })).toBe(false);
  expect(devBundledOf({ BROWSER_TEST_BUNDLED_DEV: '1' })).toBe(true);
  for (const value of ['true', 'yes', '2']) {
    expect(() => devBundledOf({ BROWSER_TEST_BUNDLED_DEV: value })).toThrow('BROWSER_TEST_BUNDLED_DEV must be 0 or 1.');
  }
  expect(BUNDLED_DEV_CONFIG).toEqual({
    experimental: { bundledDev: true },
    build: { rollupOptions: { output: { strictExecutionOrder: true } } },
  });
});

test("bundled dev's middleware refuses every /@fs/ request with 403 and passes every other request on", () => {
  type Middleware = (
    request: { url?: string },
    response: { statusCode: number; end: () => void },
    next: () => void
  ) => void;
  let middleware: Middleware | undefined;
  const configureServer = denyRawFs().configureServer as (server: unknown) => void;
  configureServer({ middlewares: { use: (each: Middleware) => (middleware = each) } });
  const answer = (url: string) => {
    const response = { statusCode: 200, ended: false, end: () => (response.ended = true) };
    let passed = false;
    middleware?.(url === '' ? {} : { url }, response, () => (passed = true));
    return passed ? 'passed' : `${response.statusCode}${response.ended ? '' : ' unended'}`;
  };
  for (const url of ['/@fs/tmp/control-token', '/@fs', '/%40fs/tmp/x', '/@fs/tmp/x?import', '/@fs/%E0%A4%A']) {
    expect([url, answer(url)]).toEqual([url, '403']);
  }
  for (const url of ['/', '', '/markets/', '/@vite/client', '/@fsx', '/src/@fs/x', '/?q=/@fs/x']) {
    expect([url, answer(url)]).toEqual([url, 'passed']);
  }
  expect(isRawFsRequest(undefined)).toBe(false);
});

test('keeps idle dev connections reusable until shutdown and closes them promptly', async () => {
  mockServer.close();
  const savedEnvironment = { ...process.env };
  delete process.env.BROWSER_TEST_BUNDLED_DEV;
  delete process.env.BROWSER_TEST_MINIFY_DEV;
  const mockCreateServer = createServer as jest.Mock;
  mockCreateServer.mockResolvedValue({
    middlewares: (_request: http.IncomingMessage, response: http.ServerResponse) => response.end('ready'),
    close: async () => undefined,
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let served: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    served = await startDevServer({ envDir: '.', environment: {} });
    const origin = served.origin;
    const get = () =>
      new Promise<{ body: string; reusedSocket: boolean; socket: http.ClientRequest['socket'] }>((resolve, reject) => {
        const request = http.get(origin, { agent }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (body += chunk));
          response.once('end', () => resolve({ body, reusedSocket: request.reusedSocket, socket: request.socket }));
          response.once('error', reject);
        });
        request.once('error', reject);
      });
    const first = await get();
    expect(first.body).toBe('ready');
    expect(first.socket).not.toBeNull();
    let isClosed = false;
    const socketClosed = new Promise<void>((resolve) =>
      first.socket?.once('close', () => {
        isClosed = true;
        resolve();
      })
    );
    // The wait exceeds Node 22's five-second server timeout and one-second buffer.
    await new Promise((resolve) => setTimeout(resolve, 6200));
    expect(isClosed).toBe(false);
    const second = await get();
    expect(second).toMatchObject({ body: 'ready', reusedSocket: true });
    expect(second.socket).toBe(first.socket);

    const started = performance.now();
    await served.close();
    served = undefined;
    await socketClosed;
    expect(performance.now() - started).toBeLessThan(1000);
  } finally {
    agent.destroy();
    await served?.close();
    for (const name of Object.keys(process.env)) if (!(name in savedEnvironment)) delete process.env[name];
    Object.assign(process.env, savedEnvironment);
  }
}, 20_000);

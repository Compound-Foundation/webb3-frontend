// Optional Chromium servers for the browser harness. Their WebSocket paths grant browser control and stay
// in a private file, read only by Node workers. The manifest records loopback origins and process IDs.
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Browser, BrowserType } from '@playwright/test';

import { REPO_ROOT } from './paths';
import { registerSecret } from './secrets';

const WORKER_FILE = path.join(REPO_ROOT, 'e2e/harness/browserPoolWorker.mjs');

function assertPoolLogging(env: NodeJS.ProcessEnv): void {
  // Playwright's channel logs expose the capability URL in connect parameters.
  if (env.DEBUG || (env.PWDEBUG && env.PWDEBUG !== '0')) {
    throw new Error(
      'BROWSER_TEST_BROWSER_POOL cannot run with DEBUG or PWDEBUG; debug logging can expose browser endpoints.'
    );
  }
}

/** A zero count keeps a browser per worker. A positive count selects a shared pool for headless runs. */
export function browserPoolCountOf(env: NodeJS.ProcessEnv, laneCount: number, isInteractive: boolean): number {
  const value = env.BROWSER_TEST_BROWSER_POOL;
  if (value === undefined || value === '' || value === '0') return 0;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 16 || Number(value) > laneCount) {
    throw new Error(
      'BROWSER_TEST_BROWSER_POOL must be 0 or an integer from 1 to 16, no greater than the worker count.'
    );
  }
  if (isInteractive) throw new Error('BROWSER_TEST_BROWSER_POOL cannot pool an interactive session.');
  assertPoolLogging(env);
  return Number(value);
}

export type BrowserPoolInfo = { count: number; servers: { origin: string; serverPid: number; browserPid: number }[] };
type Ready = { kind: 'ready'; endpoint: string; browserPid: number };
type PoolServer = { child: ChildProcess; ready: Promise<Ready>; stop: () => Promise<void> };

function startServer(certificatePath: string, index: number, workerFile: string): PoolServer {
  // No child output enters reports, even when the caller enables Playwright's DEBUG logging.
  const child = fork(workerFile, [certificatePath], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, DEBUG: '' },
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const ready = new Promise<Ready>((resolve, reject) => {
    const fail = () => reject(new Error(`Browser pool server ${index} failed to start.`));
    const timeout = setTimeout(fail, 20_000);
    child.once('error', fail);
    child.once('exit', fail);
    child.on('message', (message: Ready | { kind: 'failed' }) => {
      if (message.kind !== 'ready') {
        fail();
        return;
      }
      try {
        const url = new URL(message.endpoint);
        if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.pathname.length < 16) throw new Error();
        if (!Number.isInteger(message.browserPid) || message.browserPid <= 0) throw new Error();
        // Register both forms before publishing the file a Playwright worker reads.
        registerSecret(message.endpoint, 'a browser pool endpoint');
        registerSecret(url.pathname.slice(1), 'a browser pool capability path');
        resolve(message);
      } catch {
        fail();
      }
    });
    // Either settlement clears the timer without producing an unhandled rejection.
    exited.then(() => clearTimeout(timeout));
    child.on('message', () => clearTimeout(timeout));
  });
  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      // SIGTERM also reaches a child whose IPC send fails. Its handler owns browser cleanup during launch.
      child.kill('SIGTERM');
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`Browser pool server ${index} did not stop.`)), 20_000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    })();
    return stopped;
  };
  return { child, ready, stop };
}

/** Starts the pool, or stops the started children before reporting a startup failure. */
export async function startBrowserPool({
  count,
  certificatePath,
  privateDir,
  workerFile = WORKER_FILE,
}: {
  count: number;
  certificatePath: string;
  privateDir: string;
  workerFile?: string;
}): Promise<{ info: BrowserPoolInfo; endpointsFile: string; stop: () => Promise<void> }> {
  const servers: PoolServer[] = [];
  const endpointsFile = path.join(privateDir, 'browser-pool-endpoints.json');
  const stop = async () => {
    const outcomes = await Promise.allSettled(servers.map((server) => server.stop()));
    fs.rmSync(endpointsFile, { force: true });
    if (outcomes.some((outcome) => outcome.status === 'rejected')) {
      throw new Error('A browser pool server did not stop cleanly.');
    }
  };
  try {
    for (let index = 0; index < count; index++) servers.push(startServer(certificatePath, index, workerFile));
    const connections = await Promise.all(servers.map((server) => server.ready));
    fs.writeFileSync(endpointsFile, JSON.stringify(connections.map((connection) => connection.endpoint)), {
      mode: 0o600,
      flag: 'wx',
    });
    return {
      info: {
        count,
        servers: connections.map((connection, index) => ({
          origin: new URL(connection.endpoint).origin,
          serverPid: servers[index].child.pid as number,
          browserPid: connection.browserPid,
        })),
      },
      endpointsFile,
      stop,
    };
  } catch (error) {
    await stop();
    await Promise.allSettled(servers.map((server) => server.ready));
    throw error;
  }
}

/** Connects one worker to its server without exposing a capability URL in an error or its cause. */
export async function connectPoolBrowser(
  chromium: BrowserType,
  parallelIndex: number,
  endpointsFile: string
): Promise<Browser> {
  assertPoolLogging(process.env);
  try {
    const endpoints: string[] = JSON.parse(fs.readFileSync(endpointsFile, 'utf8'));
    return await chromium.connect(endpoints[parallelIndex % endpoints.length], { timeout: 15_000 });
  } catch {
    throw new Error(`Worker ${parallelIndex} could not connect to its browser pool server.`);
  }
}

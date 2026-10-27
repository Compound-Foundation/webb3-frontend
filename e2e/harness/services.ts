// Starts and stops the harness's services for one run, in this order:
//
//  1. a private 0700 directory outside the repository, for the TLS key and the control token
//  2. the fork: the read-only upstream proxy and anvil, verified, moving to the next public endpoint when
//     the upstream fails anvil's start-up
//  3. the HTTPS RPC proxy, the screening stub and the wallet server, with a new per-run token
//  4. unless skipped, the two production builds (no screening endpoint, and an allowed control) and their
//     static servers
//  5. the dev server, then one warm-up page load, which also checks the browser's trust in the certificate
//
// Each service registers its own stop as soon as it starts, so a failure at any step stops what started
// before it. `stopServices` is awaited on teardown and on start-up failure, and is idempotent. On SIGINT
// and SIGTERM it runs too. A synchronous kill of anvil runs on process exit as the last resort.
import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';

import { COMET_USDC, USDC } from './contracts';
import {
  allowLoopbackWebSocket,
  applyEgress,
  closePagesItDidNotOpen,
  withoutQuery,
  type BlockedRequest,
} from './egress';
import {
  createRedactor,
  failedToStartOnUpstream,
  findAnvil,
  ForkStartError,
  hasExited,
  forkTarget,
  startFork,
  startUpstreamProxy,
  stopChild,
  toolVersion,
  upstreamEndpoints,
  verifyFork,
  type ForkTarget,
} from './fork';
import { BINDING_NAME, installHarnessProvider, PROVIDER_ICON, PROVIDER_NAME, PROVIDER_RDNS } from './injectedProvider';
import { RUNS_DIR } from './paths';
import { startRpcProxy } from './rpcProxy';
import { cleanUpSynchronously, recoverKilledRuns, type ProcessRecord } from './runRecords';
import { startScreeningStub } from './screeningStub';
import { findSecrets, outputsUnder, registerSecret, registerSecretPattern } from './secrets';
import { v3ApiReadPrefixes, v3ApiUrl } from './settings';
import { makeCertificate, trustHarnessCertificate } from './tls';
import {
  buildProduction,
  emptyEnvDir,
  REPO_ROOT,
  removeViteVariables,
  serveProduction,
  startDevServer,
  type ResolvedBuild,
} from './viteApp';
import { startWalletServer } from './walletServer';

export const EXTENSION_ID = 'cfharness';

/** What the workers read about the run. It holds no secret: the token stays in its 0600 file. */
export type Manifest = {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  isInteractive: boolean;
  fork: ForkTarget & { endpoint: string; localUrl: string; anvilPid: number; upstreamProxyUrl: string };
  tools: Record<string, string | undefined>;
  git: { head: string | undefined; isDirty: boolean | undefined };
  app: {
    devOrigin: string;
    hmrOrigin: string;
    devResolved: { DEV: boolean };
    environment: Record<string, string>;
    removedViteVariables: string[];
  };
  production:
    | { isSkipped: true; reason: string }
    | {
        isSkipped: false;
        missingEndpoint: {
          origin: string;
          outDir: string;
          resolved: ResolvedBuild;
          environment: Record<string, string>;
        };
        allowed: { origin: string; outDir: string; resolved: ResolvedBuild; environment: Record<string, string> };
      };
  services: {
    rpcProxy: string;
    screening: string;
    extensionUrl: string;
    wallet: string;
    bindings: Record<string, string>;
  };
  /** The browser makes no TLS connection: the egress route fetches its requests in Node, which trusts `certPath`. */
  tls: { mode: 'node-trusts-harness-certificate'; certPath: string; spkiHash: string };
  v3Api: { url: string; label: string } | { url: null; label: string };
  contracts: { usdc: string; cometUsdc: string; usdcImplementation: string };
  privateDir: string;
  tokenFile: string;
};

type Stop = { name: string; run: () => Promise<void> | void };

export type Services = {
  manifest: Manifest;
  manifestPath: string;
  runDir: string;
  stop: () => Promise<string[]>;
  stats: () => Record<string, unknown>;
};

function gitState() {
  try {
    const head = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
    return { head, isDirty: status.trim() !== '' };
  } catch {
    return { head: undefined, isDirty: undefined };
  }
}

export async function startServices({
  runId,
  isInteractive,
  skipProduction,
}: {
  runId: string;
  isInteractive: boolean;
  skipProduction: string | undefined;
}): Promise<Services> {
  const startedAt = new Date().toISOString();
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const recovered = recoverKilledRuns();
  const stops: Stop[] = [];
  let anvilChild: ChildProcess | undefined;
  let anvilCwd: string | undefined;
  let privateDir: string | undefined;
  let stopped: Promise<string[]> | undefined;
  /** The production builds and `dist/`, scanned for the run's secrets before the private directory goes. */
  let bundleRoots: string[] = [];
  let bundleSecretScan: { roots: string[]; files: number; leaks: { file: string; secret: string }[] } | undefined;
  /** Registers a service's stop. Once stopping has begun, as after a signal during start-up, it stops at once. */
  const addStop = (each: Stop) => {
    if (stopped === undefined) stops.push(each);
    else void Promise.resolve(each.run()).catch(() => undefined);
  };
  /** Ends start-up when a signal has begun the stop, so no further service starts. */
  const ensureRunning = () => {
    if (stopped !== undefined) throw new Error('The harness was stopped by a signal during start-up.');
  };

  const scanBundles = () => {
    const repositoryDist = path.join(REPO_ROOT, 'dist');
    if (fs.existsSync(repositoryDist)) bundleRoots = [...bundleRoots, repositoryDist];
    const files = outputsUnder(bundleRoots);
    bundleSecretScan = {
      roots: bundleRoots.map((root) =>
        root.startsWith(REPO_ROOT) ? path.relative(REPO_ROOT, root) : path.basename(root)
      ),
      files: files.length,
      leaks: findSecrets(files).map((leak) => ({ file: path.basename(leak.file), secret: leak.secret })),
    };
  };

  const stop = () => {
    stopped ??= (async () => {
      const errors: string[] = [];
      try {
        scanBundles();
      } catch (error) {
        errors.push(`bundle scan: ${(error as Error)?.message ?? error}`);
      }
      for (const { name, run } of stops.reverse()) {
        try {
          await run();
        } catch (error) {
          errors.push(`${name}: ${(error as Error)?.message ?? error}`);
        }
      }
      if (anvilChild !== undefined && !hasExited(anvilChild)) errors.push(`anvil ${anvilChild.pid} is still running`);
      const processFile = path.join(runDir, 'processes.json');
      if (errors.length === 0 && fs.existsSync(processFile)) fs.rmSync(processFile);
      return errors;
    })();
    return stopped;
  };
  const exitHandler = () => cleanUpSynchronously({ anvil: anvilChild, anvilCwd, privateDir });
  // Playwright handles SIGINT itself and runs the teardown; the exit handler covers a SIGINT during
  // start-up. Playwright's runner does not handle SIGTERM, so this stops the services and then exits, as
  // Node would have without a listener.
  const terminate = () => void stop().finally(() => process.exit(143));
  process.once('exit', exitHandler);
  process.once('SIGTERM', terminate);
  stops.push({ name: 'signal handler', run: () => void process.off('SIGTERM', terminate) });

  const anvilLog = fs.openSync(path.join(runDir, 'anvil.log'), 'a', 0o600);
  const walletLog = fs.openSync(path.join(runDir, 'wallet.log'), 'a', 0o600);
  let areLogsOpen = true;
  /** Writes to a log until the logs close. anvil's last output and a late control error can come after. */
  const writeLog = (fd: number, text: string) => {
    if (areLogsOpen) fs.writeSync(fd, text);
  };
  stops.push({
    name: 'logs',
    run: () => {
      areLogsOpen = false;
      [anvilLog, walletLog].forEach((fd) => fs.closeSync(fd));
    },
  });

  try {
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-wallet-'));
    fs.chmodSync(privateDir, 0o700);
    const directory = privateDir;
    addStop({ name: 'private directory', run: () => fs.rmSync(directory, { recursive: true, force: true }) });
    const writeRecord = (record: Omit<ProcessRecord, 'runnerPid' | 'privateDir'>) =>
      fs.writeFileSync(
        path.join(runDir, 'processes.json'),
        JSON.stringify({ runnerPid: process.pid, privateDir: directory, ...record }, null, 2)
      );
    writeRecord({});

    // 2. The fork.
    const endpoints = upstreamEndpoints();
    // Only the runner holds the private URL: the workers, which inherit the environment, never see it.
    delete process.env.BROWSER_FORK_RPC_URL;
    for (const endpoint of endpoints) for (const pattern of endpoint.secretPatterns) registerSecretPattern(pattern);
    const redactor = createRedactor(endpoints.flatMap((endpoint) => endpoint.secretPatterns));
    const anvil = findAnvil();
    const blockOption = process.env.BROWSER_FORK_BLOCK === 'latest' ? 'latest' : 'pinned';
    if (
      process.env.BROWSER_FORK_BLOCK !== undefined &&
      !['latest', 'pinned', ''].includes(process.env.BROWSER_FORK_BLOCK)
    ) {
      throw new Error("BROWSER_FORK_BLOCK must be 'pinned' (the default) or 'latest'.");
    }
    const problems: string[] = [];
    let fork: Awaited<ReturnType<typeof startFork>> | undefined;
    let target: ForkTarget | undefined;
    let upstream: Awaited<ReturnType<typeof startUpstreamProxy>> | undefined;
    let chosen: (typeof endpoints)[number] | undefined;
    for (const endpoint of endpoints) {
      try {
        target = await forkTarget(endpoint, blockOption);
      } catch (error) {
        problems.push(`${endpoint.label}: ${redactor.printable((error as Error).message)}`);
        continue;
      }
      if (target === undefined) {
        problems.push(`${endpoint.label}: does not serve block ${blockOption}`);
        continue;
      }
      const proxy = await startUpstreamProxy(endpoint, { printable: redactor.printable });
      const stopProxy = () => new Promise<void>((resolve) => proxy.server.close(() => resolve()));
      try {
        let child: Parameters<typeof stopChild>[0] | undefined;
        fork = await startFork({
          anvil: anvil.command,
          upstreamUrl: proxy.url,
          target,
          log: (text) => writeLog(anvilLog, text),
          redactor,
          onChild: (spawned, directory) => {
            child = spawned;
            anvilChild = spawned;
            anvilCwd = directory;
            addStop({
              name: 'anvil',
              run: async () => {
                await stopChild(spawned);
                fs.rmSync(directory, { recursive: true, force: true });
              },
            });
            writeRecord({
              anvilPid: spawned.pid,
              upstreamProxyPort: Number(new URL(proxy.url).port),
              anvilCwd: directory,
            });
          },
        });
        void child;
        upstream = proxy;
        chosen = endpoint;
        addStop({ name: 'upstream proxy', run: () => (proxy.server.closeAllConnections(), stopProxy()) });
        break;
      } catch (error) {
        proxy.server.closeAllConnections();
        await stopProxy();
        if (
          error instanceof ForkStartError &&
          failedToStartOnUpstream({ stats: proxy.stats, output: error.output, isTimedOut: error.isTimedOut })
        ) {
          problems.push(
            `${endpoint.label}: the upstream failed anvil's start-up (${redactor.printable(
              proxy.stats.firstError ?? ''
            )})`
          );
          continue;
        }
        throw error;
      }
    }
    if (fork === undefined || target === undefined || upstream === undefined || chosen === undefined) {
      throw new Error(`No upstream endpoint can serve the fork:\n  ${problems.join('\n  ')}`);
    }
    ensureRunning();
    const forkInfo = fork;
    const { clientVersion } = await verifyFork(forkInfo, target);
    // anvil holds no unlocked account, so it can sign nothing (`--accounts 0`).
    const unlocked = await (
      await fetch(forkInfo.localUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_accounts', params: [] }),
      })
    ).json();
    if (!Array.isArray(unlocked.result) || unlocked.result.length !== 0)
      throw new Error('anvil started with unlocked accounts');
    const usdcImplementation = await readUsdcImplementation(forkInfo.localUrl);

    // 3. Proxy, stub and wallet.
    const appOrigins = new Set<string>();
    const certificate = makeCertificate(directory);
    const rpcProxy = await startRpcProxy({
      tls: certificate,
      forkUrl: () => forkInfo.localUrl,
      allowedOrigins: appOrigins,
    });
    addStop({ name: 'RPC proxy', run: () => rpcProxy.close() });
    const screening = await startScreeningStub({ allowedOrigins: appOrigins });
    addStop({ name: 'screening stub', run: () => screening.close() });
    const token = randomBytes(32).toString('hex');
    registerSecret(token);
    const tokenFile = path.join(directory, 'control-token');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    const walletRedactor = createRedactor(chosen.secretPatterns, [token]);
    const upstreamStats = upstream.stats;
    const stats = () => ({
      rpcProxy: {
        forwarded: Object.fromEntries(rpcProxy.stats.forwarded),
        refused: Object.fromEntries(rpcProxy.stats.refused),
        unserved: Object.fromEntries(rpcProxy.stats.unserved),
      },
      upstream: {
        requests: upstreamStats.requests,
        failures: upstreamStats.failures,
        errorAnswers: upstreamStats.errorAnswers,
        methods: Object.fromEntries(upstreamStats.methods),
        refused: Object.fromEntries(upstreamStats.refused),
      },
    });
    const wallet = await startWalletServer({
      fork: forkInfo,
      target,
      token,
      screening,
      stats,
      log: (line) => writeLog(walletLog, `${new Date().toISOString()} ${walletRedactor.redact(line)}\n`),
      onSecret: registerSecret,
    });
    addStop({ name: 'wallet server', run: () => wallet.close() });
    ensureRunning();

    // 4. Production builds, before the dev server sets NODE_ENV=development for the rest of the run.
    const removedViteVariables = removeViteVariables();
    const envDir = emptyEnvDir(directory);
    const apiUrl = v3ApiUrl();
    const baseEnvironment = {
      VITE_V3_RPC_PROVIDER_HOST: rpcProxy.host,
      ...(apiUrl === undefined ? {} : { VITE_V3_API_HOST: apiUrl }),
    };
    let production: Manifest['production'];
    if (skipProduction !== undefined) {
      production = { isSkipped: true, reason: skipProduction };
    } else {
      const missingEnvironment = { ...baseEnvironment };
      const allowedEnvironment = { ...baseEnvironment, VITE_SCREENING_ENDPOINT: screening.endpoint };
      const missingOut = path.join(directory, 'dist-prod-missing-endpoint');
      const allowedOut = path.join(directory, 'dist-prod-allowed');
      bundleRoots = [missingOut, allowedOut];
      const missingResolved = await buildProduction({ outDir: missingOut, envDir, environment: missingEnvironment });
      const allowedResolved = await buildProduction({ outDir: allowedOut, envDir, environment: allowedEnvironment });
      const missingServer = await serveProduction({ outDir: missingOut });
      addStop({ name: 'production server (no endpoint)', run: () => missingServer.close() });
      const allowedServer = await serveProduction({ outDir: allowedOut });
      addStop({ name: 'production server (allowed)', run: () => allowedServer.close() });
      appOrigins.add(missingServer.origin).add(allowedServer.origin);
      production = {
        isSkipped: false,
        missingEndpoint: {
          origin: missingServer.origin,
          outDir: missingOut,
          resolved: missingResolved,
          environment: missingEnvironment,
        },
        allowed: {
          origin: allowedServer.origin,
          outDir: allowedOut,
          resolved: allowedResolved,
          environment: allowedEnvironment,
        },
      };
    }

    // 5. The dev server.
    const devEnvironment = {
      ...baseEnvironment,
      VITE_SCREENING_ENDPOINT: screening.endpoint,
      VITE_EXTRA_EXTENSIONS: EXTENSION_ID,
      [`VITE_${EXTENSION_ID.toUpperCase()}_SOURCE`]: screening.extensionUrl,
    };
    const dev = await startDevServer({ envDir, environment: devEnvironment });
    addStop({ name: 'dev server', run: () => dev.close() });
    ensureRunning();
    appOrigins.add(dev.origin);

    trustHarnessCertificate(certificate.cert.toString());
    const tlsMode = await warmUp({
      devOrigin: dev.origin,
      hmrOrigin: dev.hmrOrigin,
      rpcProxyOrigin: rpcProxy.url,
      screeningOrigin: screening.origin,
      readOnly: v3ApiReadPrefixes(apiUrl ?? null),
      forwarded: () => rpcProxy.stats.forwarded.get('eth_call') ?? 0,
      runDir,
    });

    const manifest: Manifest = {
      runId,
      startedAt,
      isInteractive,
      fork: {
        ...target,
        endpoint: chosen.label,
        localUrl: forkInfo.localUrl,
        anvilPid: forkInfo.pid,
        upstreamProxyUrl: upstream.url,
      },
      tools: {
        anvil: anvil.version,
        anvilClient: clientVersion,
        node: process.version,
        playwright: toolVersion(process.execPath, [
          path.join(REPO_ROOT, 'node_modules/@playwright/test/cli.js'),
          '--version',
        ]),
        browser: tlsMode.browserVersion,
        openssl: toolVersion('openssl', ['version']),
        recoveredKilledRuns: recovered.join('; ') || undefined,
      },
      git: gitState(),
      app: {
        devOrigin: dev.origin,
        hmrOrigin: dev.hmrOrigin,
        devResolved: { DEV: dev.DEV },
        environment: devEnvironment,
        removedViteVariables,
      },
      production,
      services: {
        rpcProxy: rpcProxy.url,
        screening: screening.origin,
        extensionUrl: screening.extensionUrl,
        wallet: wallet.url,
        bindings: {
          anvil: forkInfo.localUrl,
          upstreamProxy: upstream.url,
          rpcProxy: `127.0.0.1:${rpcProxy.port}`,
          screening: screening.origin,
          wallet: wallet.url,
          dev: dev.origin,
        },
      },
      tls: { mode: tlsMode.mode, certPath: certificate.certPath, spkiHash: certificate.spkiHash },
      v3Api:
        apiUrl === undefined
          ? { url: null, label: 'not configured: no display uses production API data' }
          : { url: apiUrl, label: 'production v3 API data, not fork state' },
      contracts: { usdc: USDC, cometUsdc: COMET_USDC, usdcImplementation },
      privateDir: directory,
      tokenFile,
    };
    const manifestPath = path.join(runDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    process.env.BROWSER_HARNESS_MANIFEST = manifestPath;
    process.env.BROWSER_WALLET_CONTROL_URL = wallet.url;
    process.env.BROWSER_WALLET_TOKEN_FILE = tokenFile;
    return {
      manifest,
      manifestPath,
      runDir,
      stats,
      stop: async () => {
        // The stop scans the production builds for the run's secrets before it removes the private
        // directory: the keys and the private URL are known only to this process.
        const errors = await stop();
        process.off('exit', exitHandler);
        const finished = { ...manifest, finishedAt: new Date().toISOString() };
        fs.writeFileSync(manifestPath, JSON.stringify(finished, null, 2));
        fs.writeFileSync(
          path.join(runDir, 'stats.json'),
          JSON.stringify({ ...stats(), bundleSecretScan, cleanupErrors: errors }, null, 2)
        );
        return errors;
      },
    };
  } catch (error) {
    const errors = await stop();
    process.off('exit', exitHandler);
    const message = `${(error as Error)?.message ?? error}${
      errors.length > 0 ? `\nCleanup problems: ${errors.join('; ')}` : ''
    }`;
    fs.writeFileSync(path.join(runDir, 'startup-failure.txt'), message);
    throw new Error(message);
  }
}

/** FiatTokenProxy's implementation slot: keccak256("org.zeppelinos.proxy.implementation"). */
const USDC_IMPLEMENTATION_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';

async function readUsdcImplementation(forkUrl: string): Promise<string> {
  const response = await fetch(forkUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getStorageAt',
      params: [USDC, USDC_IMPLEMENTATION_SLOT, 'latest'],
    }),
  });
  const { result } = await response.json();
  return `0x${String(result).slice(-40)}`;
}

/**
 * Loads the app once, so that Vite's first dependency optimization is not charged to a test. It also checks
 * that the app's `eth_call` reads reach the RPC proxy through the egress route, which trusts the harness
 * certificate in Node.
 */
async function warmUp({
  devOrigin,
  hmrOrigin,
  rpcProxyOrigin,
  screeningOrigin,
  readOnly,
  forwarded,
  runDir,
}: {
  devOrigin: string;
  hmrOrigin: string;
  rpcProxyOrigin: string;
  screeningOrigin: string;
  readOnly: string[];
  forwarded: () => number;
  runDir: string;
}): Promise<{ mode: 'node-trusts-harness-certificate'; browserVersion: string }> {
  const browser = await chromium.launch();
  try {
    {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await allowLoopbackWebSocket(context, devOrigin);
      const blocked: BlockedRequest[] = [];
      closePagesItDidNotOpen(context, blocked);
      await applyEgress(
        context,
        {
          http: new Set([devOrigin, rpcProxyOrigin, screeningOrigin]),
          readOnly: new Set(readOnly),
          webSocket: new Set([hmrOrigin]),
        },
        blocked
      );
      await context.addInitScript(installHarnessProvider, {
        appOrigin: devOrigin,
        bindingName: BINDING_NAME,
        name: PROVIDER_NAME,
        icon: PROVIDER_ICON,
        rdns: PROVIDER_RDNS,
      });
      const page = await context.newPage();
      // What went wrong if the app does not render, for warm-up.json in the run directory.
      const problems: string[] = [];
      page.on('pageerror', (error) => problems.push(`page error: ${error.message.slice(0, 300)}`));
      page.on('requestfailed', (request) =>
        problems.push(
          `failed: ${request.method()} ${withoutQuery(request.url())} ${request.failure()?.errorText ?? ''}`
        )
      );
      page.on('console', (message) => {
        if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 300)}`);
      });
      const before = forwarded();
      try {
        await page.goto(devOrigin, { timeout: 240_000 });
        await page.getByText('Net Supply APR').first().waitFor({ timeout: 240_000 });
      } catch (error) {
        fs.writeFileSync(
          path.join(runDir, 'warm-up.json'),
          JSON.stringify({ problems: problems.slice(-200), blocked }, null, 2)
        );
        throw error;
      }
      const deadline = Date.now() + 60_000;
      while (forwarded() === before && Date.now() < deadline) await page.waitForTimeout(250);
      await context.close();
      if (forwarded() > before) return { mode: 'node-trusts-harness-certificate', browserVersion: browser.version() };
    }
    throw new Error('The app made no RPC read through the HTTPS proxy.');
  } finally {
    await browser.close();
  }
}

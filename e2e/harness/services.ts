// Starts and stops the harness's services for one run, in this order:
//
//  1. a private 0700 directory outside the repository, for the TLS key and the control token
//  2. the screening stub and the HTTPS RPC proxy, with one partition and one route for each fork lane
//  3. the fork: the read-only upstream proxy, shared by every lane, and lane 0's anvil and wallet server,
//     verified, moving to the next public endpoint when the upstream fails anvil's start-up. A fork of the
//     pinned block starts from the fork cache, and a clean stop promotes what the lanes read back to it.
//  4. the lane pool and its lease server: each Playwright worker leases the lane of its parallel index, whose
//     anvil and wallet server start then (`forkLanes.ts`)
//  5. unless skipped, the two production builds (no screening endpoint, and an allowed control) and their
//     static servers
//  6. the dev server, then one warm-up page load on lane 0, which also checks the browser's trust in the
//     certificate
//
// Every lane shares the builds, the dev server and the proxies. The app's RPC and screening URLs are compiled
// in, so the worker's egress route names its lane in a header (`laneHeader.ts`) on each request to them.
//
// Each service registers its own stop as soon as it starts, so a failure at any step stops what started
// before it. `stopServices` is awaited on teardown and on start-up failure, and is idempotent. On SIGINT
// and SIGTERM it runs too. A synchronous kill of every anvil runs on process exit as the last resort.
import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';

import type { WorkerSelection } from './concurrency';
import { COMET_USDC, USDC } from './contracts';
import {
  allowLoopbackWebSocket,
  applyEgress,
  closePagesItDidNotOpen,
  withoutQuery,
  type BlockedRequest,
} from './egress';
import {
  CACHED_PROXY_PORT,
  checkCacheRoot,
  isCacheAnvil,
  createRedactor,
  failedToStartOnUpstream,
  findAnvil,
  forkCacheRoot,
  ForkStartError,
  hasExited,
  forkTarget,
  loadForkCache,
  promoteLaneCaches,
  recordLoggedMethods,
  sharedCacheFile,
  startFork,
  startHeldProxy,
  stopChild,
  toolVersion,
  upstreamEndpoints,
  verifyFork,
  type CacheTrust,
  type Endpoint,
  type ForkTarget,
  type LaneCache,
  type Promotion,
  type UpstreamStats,
} from './fork';
import { createLanePool, startLaneServer, type LaneInfo, type StartedLane } from './forkLanes';
import { BINDING_NAME, installHarnessProvider, PROVIDER_ICON, PROVIDER_NAME, PROVIDER_RDNS } from './injectedProvider';
import { homeRelative, RUNS_DIR } from './paths';
import { openWrappedReleaseControls } from './releaseControls';
import { startRpcProxy } from './rpcProxy';
import { cleanUpSynchronously, recoverKilledRuns, type ProcessRecord, type RecordedAnvil } from './runRecords';
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
import { startWalletServer, type WalletServer } from './walletServer';

export const EXTENSION_ID = 'cfharness';

/** What the workers read about the run. It holds no secret: the token stays in its 0600 file. */
export type Manifest = {
  runId: string;
  startedAt: string;
  /** When the services were ready and the tests could start. */
  readyAt?: string;
  finishedAt?: string;
  isInteractive: boolean;
  /**
   * The fork. `localUrl` and `anvilPid` are lane 0's in the file; a worker's `manifest` fixture gives its own
   * lane's.
   */
  fork: ForkTarget & {
    endpoint: string;
    localUrl: string;
    anvilPid: number;
    upstreamProxyUrl: string;
    cache: ForkCache;
    /** Whether the teardown promoted the lanes' caches, written when the run finishes. */
    cachePromotion?: Promotion;
  };
  /** The fork lanes: how many workers may lease one, and, when the run finishes, each lane started. */
  lanes: { count: number; started?: LaneInfo[] };
  /** How the worker count was chosen. `workers` is what Playwright ran with, `--workers` included. */
  concurrency: { workers: number; selection?: WorkerSelection; isCliOverride: boolean };
  tools: Record<string, string | undefined>;
  git: { head: string | undefined; isDirty: boolean | undefined };
  app: {
    devOrigin: string;
    hmrOrigin: string;
    devResolved: { DEV: boolean };
    environment: Record<string, string>;
    removedViteVariables: string[];
    /**
     * The wrapper release controls the dev server serves. Its plugin opens them, so the wrapped specs can
     * run. The production builds keep the committed, closed controls.
     */
    wrappedReleaseControls: 'open';
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
    /** Lane 0's wallet server in the file; a worker's `manifest` fixture gives its own lane's. */
    wallet: string;
    /** The lane server, where a worker leases its lane. */
    lanes: string;
    bindings: Record<string, string>;
  };
  /** The browser makes no TLS connection: the egress route fetches its requests in Node, which trusts `certPath`. */
  tls: { mode: 'node-trusts-harness-certificate'; certPath: string; spkiHash: string };
  v3Api: { url: string; label: string } | { url: null; label: string };
  contracts: { usdc: string; cometUsdc: string; usdcImplementation: string };
  privateDir: string;
  tokenFile: string;
};

/**
 * The fork cache for the run: off, with why when the cache is on but the run could not use it, or its root
 * and the trust class of the run's upstream, with whether that class's cache held state of the block.
 */
export type ForkCache =
  | { state: 'off'; reason?: string }
  | { state: 'cold' | 'warm'; trust: CacheTrust; directory: string };

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
  laneCount,
  concurrency,
}: {
  runId: string;
  isInteractive: boolean;
  skipProduction: string | undefined;
  /** How many fork lanes workers may lease: Playwright's worker count. */
  laneCount: number;
  concurrency: Manifest['concurrency'];
}): Promise<Services> {
  const startedAt = new Date().toISOString();
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const recovered = recoverKilledRuns();
  const stops: Stop[] = [];
  /** Every anvil the run started, with its working directory, for the synchronous last resort. */
  const anvils: { child: ChildProcess; cwd: string }[] = [];
  let privateDir: string | undefined;
  let cachePromotion: Promotion | undefined;
  /** Each lane as it started, restarts included, for the finished manifest. */
  const lanesStarted: LaneInfo[] = [];
  let upstreamStats: UpstreamStats | undefined;
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
      for (const { child } of anvils) if (!hasExited(child)) errors.push(`anvil ${child.pid} is still running`);
      const processFile = path.join(runDir, 'processes.json');
      if (errors.length === 0 && fs.existsSync(processFile)) fs.rmSync(processFile);
      return errors;
    })();
    return stopped;
  };
  const exitHandler = () => cleanUpSynchronously({ anvils, privateDir });
  // Playwright handles SIGINT itself and runs the teardown; the exit handler covers a SIGINT during
  // start-up. Playwright's runner does not handle SIGTERM, so this stops the services and then exits, as
  // Node would have without a listener.
  const terminate = () => void stop().finally(() => process.exit(143));
  process.once('exit', exitHandler);
  process.once('SIGTERM', terminate);
  stops.push({ name: 'signal handler', run: () => void process.off('SIGTERM', terminate) });

  const walletLog = fs.openSync(path.join(runDir, 'wallet.log'), 'a', 0o600);
  /** Each lane's anvil log, by lane, open until the logs close. */
  const anvilLogs = new Map<number, number>();
  let areLogsOpen = true;
  /** Writes to a log until the logs close. anvil's last output and a late control error can come after. */
  const writeLog = (fd: number, text: string) => {
    if (areLogsOpen) fs.writeSync(fd, text);
  };
  const anvilLogOf = (lane: number) => {
    let fd = anvilLogs.get(lane);
    if (fd === undefined) {
      fd = fs.openSync(path.join(runDir, `anvil-${lane}.log`), 'a', 0o600);
      anvilLogs.set(lane, fd);
    }
    return fd;
  };
  stops.push({
    name: 'logs',
    run: () => {
      areLogsOpen = false;
      [walletLog, ...anvilLogs.values()].forEach((fd) => fs.closeSync(fd));
    },
  });

  try {
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-wallet-'));
    fs.chmodSync(privateDir, 0o700);
    const directory = privateDir;
    addStop({ name: 'private directory', run: () => fs.rmSync(directory, { recursive: true, force: true }) });
    const record: Omit<ProcessRecord, 'runnerPid' | 'privateDir'> & { anvils: RecordedAnvil[] } = { anvils: [] };
    const writeRecord = () =>
      fs.writeFileSync(
        path.join(runDir, 'processes.json'),
        JSON.stringify({ runnerPid: process.pid, privateDir: directory, ...record }, null, 2)
      );
    writeRecord();

    // 2. The screening stub and the RPC proxy, which route each request by its lane. The proxy reads a lane's
    // fork URL from the pool on every request, so a lane that starts later is reached at once.
    const appOrigins = new Set<string>();
    const certificate = makeCertificate(directory);
    let forkUrlOf: (lane: number) => string | undefined = () => undefined;
    const rpcProxy = await startRpcProxy({
      tls: certificate,
      forkUrl: (lane) => forkUrlOf(lane),
      laneCount,
      allowedOrigins: appOrigins,
    });
    addStop({ name: 'RPC proxy', run: () => rpcProxy.close() });
    const screening = await startScreeningStub({ allowedOrigins: appOrigins, laneCount });
    addStop({ name: 'screening stub', run: () => screening.close() });
    const token = randomBytes(32).toString('hex');
    registerSecret(token);
    const tokenFile = path.join(directory, 'control-token');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });

    // 3. The fork.
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
    // Before any endpoint is contacted, so that a wrong setting or an unsafe directory stops the run first.
    const configuredCacheRoot = forkCacheRoot(process.env, blockOption);
    if (configuredCacheRoot !== undefined) checkCacheRoot(configuredCacheRoot);
    // The checked root, resolved once, so that no link on its path can change between the checks and the reads.
    const cacheRoot = configuredCacheRoot === undefined ? undefined : fs.realpathSync(configuredCacheRoot);
    const anvilOffReason =
      cacheRoot === undefined || isCacheAnvil(anvil.version) ? undefined : 'the installed anvil cannot read the cache';
    const cachePort = cacheRoot !== undefined && anvilOffReason === undefined ? CACHED_PROXY_PORT : undefined;
    const stats = () => ({
      rpcProxy: {
        forwarded: Object.fromEntries(rpcProxy.stats.forwarded),
        refused: Object.fromEntries(rpcProxy.stats.refused),
        unserved: Object.fromEntries(rpcProxy.stats.unserved),
        lanes: Object.fromEntries(rpcProxy.stats.lanes),
      },
      upstream:
        upstreamStats === undefined
          ? undefined
          : {
              requests: upstreamStats.requests,
              failures: upstreamStats.failures,
              errorAnswers: upstreamStats.errorAnswers,
              methods: Object.fromEntries(upstreamStats.methods),
              refused: Object.fromEntries(upstreamStats.refused),
              peakPending: upstreamStats.peakPending,
              peakPerSecond: Math.max(0, ...upstreamStats.perSecond.values()),
            },
    });

    /** What every lane of the run shares: the upstream, its proxy, the block, and the shared cache file. */
    type ForkContext = {
      endpoint: Endpoint;
      proxy: Awaited<ReturnType<typeof startHeldProxy>>['proxy'];
      target: ForkTarget;
      sharedFile: string | undefined;
    };

    /**
     * Starts lane `index`: its own anvil home, holding a copy of the shared cache file, its own anvil forked
     * through the shared proxy, verified, and its own wallet server on its screening partition. A failure stops
     * what the lane started before it throws. The lane's stop closes the wallet server, then stops anvil,
     * which writes its cache on SIGTERM, while the proxy still holds its port.
     */
    const startLane = async (context: ForkContext, index: number, generation: number): Promise<StartedLane> => {
      ensureRunning();
      const { proxy, target, sharedFile } = context;
      const runHome = path.join(directory, `anvil-home-${index}-${generation}`);
      let cache: LaneInfo['cache'] = 'off';
      if (cacheRoot !== undefined && sharedFile !== undefined) {
        checkCacheRoot(cacheRoot);
        cache = loadForkCache({ sharedFile, runHome, blockNumber: target.number, forkUrl: proxy.url });
      }
      const methods = new Set<string>();
      const log = anvilLogOf(index);
      writeLog(log, `--- lane ${index}, start ${generation}, ${new Date().toISOString()}\n`);
      let child: ChildProcess | undefined;
      let cwd: string | undefined;
      let wallet: WalletServer | undefined;
      /** Whether the lane started and its stop belongs to the pool. Until then, its anvil has a stop of its own. */
      let isStarted = false;
      const stopParts = async () => {
        await wallet?.close();
        if (child !== undefined) await stopChild(child);
        if (cwd !== undefined) fs.rmSync(cwd, { recursive: true, force: true });
      };
      try {
        const fork = await startFork({
          anvil: anvil.command,
          upstreamUrl: proxy.url,
          target,
          log: (text) => {
            recordLoggedMethods(text, methods);
            writeLog(log, text);
          },
          redactor,
          cacheHome: sharedFile === undefined ? undefined : runHome,
          onChild: (spawned, spawnedCwd) => {
            child = spawned;
            cwd = spawnedCwd;
            anvils.push({ child: spawned, cwd: spawnedCwd });
            // A signal while the lane starts stops this anvil while the proxy still holds its port: the stop is
            // registered after the proxy's, so it runs first.
            addStop({
              name: `lane ${index} anvil while it starts`,
              run: async () => {
                if (isStarted) return;
                await stopChild(spawned);
                fs.rmSync(spawnedCwd, { recursive: true, force: true });
              },
            });
            record.upstreamProxyPort = Number(new URL(proxy.url).port);
            record.anvils.push({ pid: spawned.pid, cwd: spawnedCwd });
            writeRecord();
          },
        });
        ensureRunning();
        await verifyFork(fork, target);
        // anvil holds no unlocked account, so it can sign nothing (`--accounts 0`).
        const unlocked = await (
          await fetch(fork.localUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_accounts', params: [] }),
          })
        ).json();
        if (!Array.isArray(unlocked.result) || unlocked.result.length !== 0)
          throw new Error('anvil started with unlocked accounts');
        const walletRedactor = createRedactor(context.endpoint.secretPatterns, [token]);
        wallet = await startWalletServer({
          fork,
          target,
          upstreamUrl: proxy.url,
          token,
          screening: screening.lanes[index],
          stats,
          log: (line) =>
            writeLog(walletLog, `${new Date().toISOString()} lane ${index} ${walletRedactor.redact(line)}\n`),
          onSecret: registerSecret,
        });
        const info: LaneInfo = {
          index,
          generation,
          forkUrl: fork.localUrl,
          anvilPid: fork.pid,
          walletUrl: wallet.url,
          cache,
        };
        lanesStarted.push(info);
        const spawned = fork.child;
        isStarted = true;
        return {
          info,
          isAlive: () => !hasExited(spawned),
          stop: async (): Promise<LaneCache | undefined> => {
            await stopParts();
            // Only while this run's proxy still held the fixed port, so that nothing else answered anvil.
            if (sharedFile === undefined) return undefined;
            return {
              lane: index,
              generation,
              runHome,
              methods,
              hasExitedCleanly: spawned.exitCode === 0,
              anvilVersion: anvil.version,
              isProxyListening: proxy.server.listening,
            };
          },
        };
      } catch (error) {
        await stopParts();
        throw error;
      }
    };

    let firstLane: StartedLane | undefined;
    let context: ForkContext | undefined;
    let cache: ForkCache = { state: 'off' };
    const problems: string[] = [];
    for (const endpoint of endpoints) {
      let target: ForkTarget | undefined;
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
      // A cached fork needs the proxy at its fixed port, so that the fork URL, and with it anvil's cache
      // file, is the same in every run and every lane. The proxy's stop is registered before the lanes', so
      // the teardown stops every lane's anvil first.
      const { proxy, offReason, stopProxy } = await startHeldProxy(endpoint, {
        printable: redactor.printable,
        cachePort,
        addStop,
      });
      ensureRunning();
      const trust: CacheTrust = endpoint.isPrivate ? 'private' : 'public';
      const sharedFile =
        cacheRoot !== undefined && cachePort !== undefined && offReason === undefined
          ? sharedCacheFile(cacheRoot, trust, target.number)
          : undefined;
      const candidate: ForkContext = { endpoint, proxy, target, sharedFile };
      upstreamStats = proxy.stats;
      try {
        firstLane = await startLane(candidate, 0, 0);
      } catch (error) {
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
      context = candidate;
      if (cacheRoot !== undefined && sharedFile !== undefined) {
        cache = { state: firstLane.info.cache === 'warm' ? 'warm' : 'cold', trust, directory: homeRelative(cacheRoot) };
      } else {
        const reason = offReason ?? anvilOffReason;
        cache = reason === undefined ? { state: 'off' } : { state: 'off', reason };
      }
      break;
    }
    if (firstLane === undefined || context === undefined) {
      throw new Error(`No upstream endpoint can serve the fork:\n  ${problems.join('\n  ')}`);
    }
    const forkContext = context;
    // 4. The lane pool. Its stop is registered after the proxy's, so it runs first: every lane's anvil stops
    // and writes its cache while the proxy still holds its port, and then the union of the eligible lanes'
    // caches is promoted.
    const pool = createLanePool({
      count: laneCount,
      startLane: (index, generation) => startLane(forkContext, index, generation),
      initial: firstLane,
    });
    forkUrlOf = pool.forkUrlOf;
    addStop({
      name: 'fork lanes',
      run: async () => {
        const { caches, errors } = await pool.stop();
        const { sharedFile, target } = forkContext;
        if (cacheRoot !== undefined && sharedFile !== undefined) {
          cachePromotion = promoteLaneCaches({
            cacheRoot,
            sharedFile,
            blockNumber: target.number,
            forkHash: target.hash,
            forkUrl: forkContext.proxy.url,
            lanes: caches,
          });
        }
        if (errors.length > 0) throw new Error(errors.join('; '));
      },
    });
    ensureRunning();
    const laneServer = await startLaneServer({ pool, token });
    addStop({ name: 'lane server', run: () => laneServer.close() });
    const firstInfo = firstLane.info;
    const target = forkContext.target;
    const clientVersion = (await verifyFork({ localUrl: firstInfo.forkUrl }, target)).clientVersion;
    const usdcImplementation = await readUsdcImplementation(firstInfo.forkUrl);
    ensureRunning();

    // 5. Production builds, before the dev server sets NODE_ENV=development for the rest of the run.
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

    // 6. The dev server.
    const devEnvironment = {
      ...baseEnvironment,
      VITE_SCREENING_ENDPOINT: screening.endpoint,
      VITE_EXTRA_EXTENSIONS: EXTENSION_ID,
      [`VITE_${EXTENSION_ID.toUpperCase()}_SOURCE`]: screening.extensionUrl,
    };
    const dev = await startDevServer({
      envDir,
      environment: devEnvironment,
      plugins: [openWrappedReleaseControls()],
    });
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
      forwarded: () => rpcProxy.stats.lanes.get('0') ?? 0,
      runDir,
    });

    const manifest: Manifest = {
      runId,
      startedAt,
      readyAt: new Date().toISOString(),
      isInteractive,
      fork: {
        ...target,
        endpoint: forkContext.endpoint.label,
        localUrl: firstInfo.forkUrl,
        anvilPid: firstInfo.anvilPid,
        upstreamProxyUrl: forkContext.proxy.url,
        cache,
      },
      lanes: { count: laneCount },
      concurrency,
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
        wrappedReleaseControls: 'open',
      },
      production,
      services: {
        rpcProxy: rpcProxy.url,
        screening: screening.origin,
        extensionUrl: screening.extensionUrl,
        wallet: firstInfo.walletUrl,
        lanes: laneServer.url,
        bindings: {
          anvil: firstInfo.forkUrl,
          upstreamProxy: forkContext.proxy.url,
          rpcProxy: `127.0.0.1:${rpcProxy.port}`,
          screening: screening.origin,
          wallet: firstInfo.walletUrl,
          lanes: laneServer.url,
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
    process.env.BROWSER_HARNESS_LANES_URL = laneServer.url;
    // Lane 0's wallet, for an interactive session and an agent's own control calls. A worker uses its lane's.
    process.env.BROWSER_WALLET_CONTROL_URL = firstInfo.walletUrl;
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
        const finished = {
          ...manifest,
          finishedAt: new Date().toISOString(),
          fork: { ...manifest.fork, cachePromotion },
          lanes: { ...manifest.lanes, started: lanesStarted },
        };
        fs.writeFileSync(manifestPath, JSON.stringify(finished, null, 2));
        fs.writeFileSync(
          path.join(runDir, 'stats.json'),
          JSON.stringify(
            {
              ...stats(),
              upstreamPerSecond: Object.fromEntries(upstreamStats?.perSecond ?? []),
              forkCachePromotion: cachePromotion,
              bundleSecretScan,
              cleanupErrors: errors,
            },
            null,
            2
          )
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
 * Loads the app once, on lane 0, so that Vite's first dependency optimization is not charged to a test. It
 * also checks that the app's reads reach lane 0's fork through the RPC proxy and the egress route, which
 * trusts the harness certificate in Node.
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
        blocked,
        { origins: new Set([rpcProxyOrigin, screeningOrigin]), value: '0' }
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

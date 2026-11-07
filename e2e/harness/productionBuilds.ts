// Runs the harness's production builds one after another in the runner (the default), or at the same time in
// worker threads when BROWSER_TEST_PARALLEL_BUILDS=1.
//
// A build in the runner sets NODE_ENV and the `VITE_*` variables in the runner's process environment, so two
// builds cannot run there at once. Node copies the environment into each worker thread by default.
// The worker builds with the settings of `buildProduction` (`productionBuildConfig.mjs`).
// The runner checks each worker's result with `assertProduction` again.
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { assertProduction, buildProduction, REPO_ROOT, type AppEnvironment, type ResolvedBuild } from './viteApp';

/** The worker thread's entry. It is plain JavaScript, so it loads in Node without a TypeScript loader. */
export const BUILD_WORKER_FILE = path.join(REPO_ROOT, 'e2e/harness/productionBuildWorker.mjs');
const CONFIG_FILE = path.join(REPO_ROOT, 'vite.config.js');

/** How the production builds run: one after another in the runner, or at the same time in worker threads. */
export type ProductionBuildMode = 'serial' | 'parallel';

/** One production build: its output directory and exactly its `VITE_*` variables. */
export type ProductionBuildRequest = { outDir: string; environment: AppEnvironment };

/**
 * The mode BROWSER_TEST_PARALLEL_BUILDS selects: unset, empty or `0` for serial builds in the runner, `1` for
 * parallel builds in worker threads. Any other value throws, so a misspelt setting stops the run.
 */
export function productionBuildModeOf(env: NodeJS.ProcessEnv = process.env): ProductionBuildMode {
  const value = env.BROWSER_TEST_PARALLEL_BUILDS;
  if (value === undefined || value === '' || value === '0') return 'serial';
  if (value === '1') return 'parallel';
  throw new Error('BROWSER_TEST_PARALLEL_BUILDS must be 0 or 1.');
}

/**
 * Returns a worker's environment: the runner's environment without NODE_ENV and without any `VITE_*`
 * variable, then NODE_ENV=production and exactly `environment`. It throws on a name in `environment` that
 * does not start with `VITE_`, so a build cannot change any other variable of its worker.
 */
export function workerEnvironmentOf(
  runnerEnvironment: NodeJS.ProcessEnv,
  environment: AppEnvironment
): Record<string, string> {
  const foreign = Object.keys(environment).filter((name) => !name.startsWith('VITE_'));
  if (foreign.length > 0) throw new Error(`A production build's environment names non-VITE_ variables: ${foreign}.`);
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(runnerEnvironment)) {
    if (value !== undefined && name !== 'NODE_ENV' && !name.startsWith('VITE_')) inherited[name] = value;
  }
  return { ...inherited, NODE_ENV: 'production', ...environment };
}

type WorkerBuild = { result: Promise<ResolvedBuild>; terminate: () => Promise<number> };

/**
 * Starts one build in a worker thread. `result` settles after the worker exits.
 * The runner ends the worker when it reports its build or an error.
 */
function startWorkerBuild({
  workerFile,
  configFile,
  root,
  envDir,
  request,
  workerEnvironment,
}: {
  workerFile: string;
  configFile: string;
  root: string;
  envDir: string;
  request: ProductionBuildRequest;
  workerEnvironment: Record<string, string>;
}): WorkerBuild {
  const { outDir, environment } = request;
  const worker = new Worker(workerFile, {
    env: workerEnvironment,
    workerData: { configFile, root, envDir, outDir, environment },
  });
  const result = new Promise<ResolvedBuild>((resolve, reject) => {
    let reported: ResolvedBuild | undefined;
    let failure: unknown;
    worker.once('message', (message: { resolved: ResolvedBuild }) => {
      reported = message.resolved;
      void worker.terminate();
    });
    worker.once('error', (error) => (failure = error));
    worker.once('exit', (code) => {
      if (reported === undefined) {
        const name = path.basename(outDir);
        reject(
          failure ?? new Error(`The production build worker for ${name} exited with code ${code} before it reported.`)
        );
        return;
      }
      try {
        resolve(assertProduction(reported));
      } catch (error) {
        reject(error);
      }
    });
  });
  return { result, terminate: () => worker.terminate() };
}

/**
 * Builds each of `builds` at the same time, each in its own worker thread, and returns what each resolved, in
 * the order of `builds`. If one build fails, it ends every other worker, waits for all of them to exit, and
 * throws the first failure. `configFile`, `root` and `workerFile` default to the repository's own.
 */
export async function buildProductionsInWorkers({
  envDir,
  builds,
  configFile = CONFIG_FILE,
  root = REPO_ROOT,
  workerFile = BUILD_WORKER_FILE,
}: {
  envDir: string;
  builds: ProductionBuildRequest[];
  configFile?: string;
  root?: string;
  workerFile?: string;
}): Promise<ResolvedBuild[]> {
  if (os.availableParallelism() < 2) {
    throw new Error('BROWSER_TEST_PARALLEL_BUILDS=1 needs at least 2 CPUs; unset it to build one after another.');
  }
  // Every environment is checked before the first worker starts, so a refused one leaves no worker running.
  const workerEnvironments = builds.map((request) => workerEnvironmentOf(process.env, request.environment));
  const started: WorkerBuild[] = [];
  try {
    builds.forEach((request, i) =>
      started.push(
        startWorkerBuild({ workerFile, configFile, root, envDir, request, workerEnvironment: workerEnvironments[i] })
      )
    );
    return await Promise.all(started.map((each) => each.result));
  } catch (error) {
    await Promise.allSettled(started.map((each) => each.terminate()));
    await Promise.allSettled(started.map((each) => each.result));
    throw error;
  }
}

/**
 * Builds the app for production once for each of `builds`, in the mode BROWSER_TEST_PARALLEL_BUILDS selects,
 * and returns what each resolved, in the order of `builds`. Either mode refuses a build that resolved DEV=true.
 */
export async function buildProductions({
  envDir,
  builds,
}: {
  envDir: string;
  builds: ProductionBuildRequest[];
}): Promise<ResolvedBuild[]> {
  const mode = productionBuildModeOf();
  if (mode === 'parallel') {
    console.log(
      `Browser harness: ${builds.length} production builds in worker threads, by BROWSER_TEST_PARALLEL_BUILDS.`
    );
    return buildProductionsInWorkers({ envDir, builds });
  }
  const resolved: ResolvedBuild[] = [];
  for (const { outDir, environment } of builds) resolved.push(await buildProduction({ outDir, envDir, environment }));
  return resolved;
}

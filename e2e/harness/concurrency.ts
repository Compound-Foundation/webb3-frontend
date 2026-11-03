// How many Playwright workers a run of the browser suite uses. Each worker gets its own fork lane (an anvil,
// a wallet server and a screening partition), its own Chromium and its own Node process, so a worker costs
// CPU and memory on top of the services every worker shares (the runner, the dev server, the proxies).
//
// The estimate is a heuristic, not a measured optimum. It takes the smallest of these limits, and at least one:
// - CPU: the CPUs the process may use (a cgroup quota, where one applies), times the share that was idle over
//   a short sample, less the shared services' CPUs, divided by one worker's CPUs.
// - Memory: the memory the operating system can give without swapping, less the shared services and
//   headroom, divided by one worker's memory.
// - Files: Playwright runs a spec file in one worker (`fullyParallel: false`), so more workers than spec
//   files would sit idle.
// - Upstream: a run on the public endpoints without a warm cache sends every miss of every worker upstream,
//   and those endpoints limit their rate. Such a run gets a lower maximum.
// - The default maximum, which the benchmarks in docs/browser-fork-wallet.md support.
//
// The signals are read once, in the runner, and only when the environment does not decide the count.
//
// BROWSER_TEST_WORKERS sets the count outright (1 included), and Playwright's `--workers` overrides both.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { forkCacheRoot, PINNED_BLOCK, sharedCacheFile } from './fork';

const GIB = 1024 ** 3;

/**
 * The most workers the estimate chooses. A spec file runs in one worker, and the two longest files take about
 * 85 and 75 s of the suite's 290 s, so past four workers they bound the run: six workers were 6 % faster than
 * four in the benchmarks, for 1.1 GiB more memory and half again the upstream burst.
 */
export const DEFAULT_MAX_WORKERS = 4;
/**
 * The most workers the estimate chooses for a run on the public endpoints without a warm cache. Every lane's
 * misses go upstream: four cold lanes sent 39 % more requests than one, at more than twice the peak rate, to
 * endpoints whose rate limits are not published and change.
 */
export const PUBLIC_COLD_MAX_WORKERS = 2;
/** The largest count BROWSER_TEST_WORKERS accepts. */
export const MAX_OVERRIDE_WORKERS = 16;
/** The CPUs that the runner, the dev server and the proxies use, which no worker can have. */
export const SHARED_CPUS = 2;
/**
 * One worker's CPUs: its Chromium, its Node process and its anvil. A worker averaged 0.6 CPUs in the benchmarks
 * and peaked at 1.6.
 */
export const CPUS_PER_WORKER = 2;
/**
 * The memory of the runner, the dev server and the production builds, about 3 GiB in the benchmarks, with
 * 1 GiB of headroom for the system.
 */
export const SHARED_MEMORY = 4 * GIB;
/** One worker's memory: its Chromium, its Node process and its anvil, about 1.1 GiB in the benchmarks. */
export const MEMORY_PER_WORKER = 1.5 * GIB;
/** The share of the CPUs counted as idle when the sample cannot be taken. */
const UNKNOWN_IDLE_FRACTION = 0.5;
/** The CPUs counted when the count cannot be read. */
const UNKNOWN_CPUS = 2;
/** How long the CPU sample takes. */
const IDLE_SAMPLE_MS = 300;

export type ConcurrencySignals = {
  platform: string;
  /** `os.availableParallelism()`: the CPUs the process may run on. */
  availableParallelism?: number;
  /** The CPUs a cgroup quota allows, on Linux. */
  cgroupCpuLimit?: number;
  /** The share of CPU time that was idle over a short sample, from 0 to 1. */
  idleFraction?: number;
  /** The memory the system can give without swapping, in bytes. */
  availableMemoryBytes?: number;
  /** Where `availableMemoryBytes` came from. */
  memorySource?: string;
  /** The spec files the run's projects match. */
  specFiles?: number;
  /** The upstream's trust class: public endpoints or a private BROWSER_FORK_RPC_URL. */
  upstream: 'public' | 'private';
  /** Whether a shared fork cache file for the pinned block exists. */
  cache: 'warm' | 'cold' | 'off';
};

export type WorkerSelection = {
  workers: number;
  source: 'estimate' | 'override' | 'interactive';
  reasons: string[];
  /** The signals that could not be read, for which a conservative value stood in. */
  missing: string[];
  signals: ConcurrencySignals;
  /** Each limit the estimate took the smallest of. A missing file count sets no file limit. */
  limits: { cpu?: number; memory?: number; files?: number; upstream: number; max: number };
};

const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`;

/** The worker count for `signals`, or the one the environment sets. */
export function selectWorkers(signals: ConcurrencySignals, env: NodeJS.ProcessEnv): WorkerSelection {
  const base = { signals, missing: [] as string[], limits: { upstream: 1, max: 1 } };
  if (env.BROWSER_WALLET_INTERACTIVE === '1') {
    return { ...base, workers: 1, source: 'interactive', reasons: ['an interactive session runs one worker'] };
  }
  const override = env.BROWSER_TEST_WORKERS;
  if (override !== undefined && override !== '' && override !== 'auto') {
    if (!/^[1-9][0-9]*$/.test(override) || Number(override) > MAX_OVERRIDE_WORKERS) {
      throw new Error(
        `BROWSER_TEST_WORKERS must be 'auto' or a whole number from 1 to ${MAX_OVERRIDE_WORKERS}, not '${override}'.`
      );
    }
    return {
      ...base,
      workers: Number(override),
      source: 'override',
      reasons: [`BROWSER_TEST_WORKERS=${override} sets the count; the estimate was not used`],
    };
  }

  const missing: string[] = [];
  const reasons: string[] = [];
  const visibleCpus = signals.availableParallelism;
  if (visibleCpus === undefined) missing.push('CPU count');
  const cpus = Math.min(visibleCpus ?? UNKNOWN_CPUS, signals.cgroupCpuLimit ?? Infinity);
  const idle = signals.idleFraction ?? UNKNOWN_IDLE_FRACTION;
  if (signals.idleFraction === undefined) missing.push('CPU idle share');
  const freeCpus = cpus * idle;
  const cpu = Math.floor((freeCpus - SHARED_CPUS) / CPUS_PER_WORKER);
  reasons.push(
    `CPU: ${cpus} CPUs${signals.cgroupCpuLimit === undefined ? '' : ' (cgroup quota)'} at ${Math.round(
      idle * 100
    )} % idle leave ${freeCpus.toFixed(
      1
    )}; ${SHARED_CPUS} for shared services and ${CPUS_PER_WORKER} per worker allow ${cpu}`
  );

  let memory = 1;
  if (signals.availableMemoryBytes === undefined) {
    missing.push('available memory');
    reasons.push('memory: unknown, so one worker');
  } else {
    memory = Math.floor((signals.availableMemoryBytes - SHARED_MEMORY) / MEMORY_PER_WORKER);
    reasons.push(
      `memory: ${gib(signals.availableMemoryBytes)} available (${signals.memorySource ?? 'unknown source'}); ${gib(
        SHARED_MEMORY
      )} for shared services and headroom and ${gib(MEMORY_PER_WORKER)} per worker allow ${memory}`
    );
  }

  const files = signals.specFiles;
  if (files === undefined) missing.push('spec file count');
  else reasons.push(`files: ${files} spec files, and a file runs in one worker`);

  const isUpstreamLimited = signals.upstream === 'public' && signals.cache !== 'warm';
  const upstream = isUpstreamLimited ? PUBLIC_COLD_MAX_WORKERS : DEFAULT_MAX_WORKERS;
  reasons.push(
    isUpstreamLimited
      ? `upstream: the public endpoints with a ${signals.cache} cache allow ${upstream}, since every miss goes upstream`
      : `upstream: ${signals.upstream} endpoint with a ${signals.cache} cache, no lower limit`
  );
  reasons.push(`the default maximum is ${DEFAULT_MAX_WORKERS}`);

  const smallest = Math.min(cpu, memory, files ?? Infinity, upstream, DEFAULT_MAX_WORKERS);
  if (smallest < 1) reasons.push('the smallest limit is below one, and a run has at least one worker');
  return {
    workers: Math.max(1, smallest),
    source: 'estimate',
    reasons,
    missing,
    signals,
    limits: {
      cpu,
      memory: signals.availableMemoryBytes === undefined ? undefined : memory,
      files,
      upstream,
      max: DEFAULT_MAX_WORKERS,
    },
  };
}

/** `MemAvailable` from Linux's /proc/meminfo, in bytes. */
export function parseMeminfoAvailable(text: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text);
  return match === null ? undefined : Number(match[1]) * 1024;
}

/** The CPUs a cgroup v2 `cpu.max` allows: its quota over its period, or none for `max`. */
export function parseCgroupCpuMax(text: string): number | undefined {
  const match = /^(\d+)\s+(\d+)\s*$/.exec(text.trim());
  return match === null || Number(match[2]) === 0 ? undefined : Number(match[1]) / Number(match[2]);
}

/**
 * The memory macOS can give without swapping, from `vm_stat`: free, inactive and speculative pages.
 * `os.freemem()` counts only free pages, which macOS keeps few of. Purgeable pages are already counted among
 * the active and inactive ones, so they are not added.
 */
export function parseVmStatAvailable(text: string): number | undefined {
  const pageSize = /page size of (\d+) bytes/.exec(text);
  if (pageSize === null) return undefined;
  const pages = (name: string) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(text)?.[1] ?? 0);
  return (pages('free') + pages('inactive') + pages('speculative')) * Number(pageSize[1]);
}

const readText = (file: string) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** The cgroup's memory limit less its use, on Linux with cgroup v2 or v1, or undefined. */
function cgroupMemoryAvailable(): number | undefined {
  for (const [limitFile, usageFile] of [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
  ]) {
    const limit = readText(limitFile)?.trim();
    const usage = readText(usageFile)?.trim();
    // cgroup v2 writes `max` for no limit; v1 writes a number near 2^63.
    if (limit === undefined || usage === undefined || !/^\d+$/.test(limit) || !/^\d+$/.test(usage)) continue;
    if (Number(limit) >= 2 ** 60) continue;
    return Number(limit) - Number(usage);
  }
  return undefined;
}

function availableMemory(platform: string): { bytes?: number; source?: string } {
  if (platform === 'linux') {
    const meminfo = parseMeminfoAvailable(readText('/proc/meminfo') ?? '');
    const cgroup = cgroupMemoryAvailable();
    if (cgroup !== undefined && (meminfo === undefined || cgroup < meminfo)) return { bytes: cgroup, source: 'cgroup' };
    if (meminfo !== undefined) return { bytes: meminfo, source: 'MemAvailable' };
  }
  if (platform === 'darwin') {
    try {
      const bytes = parseVmStatAvailable(execFileSync('vm_stat', { encoding: 'utf8', timeout: 2_000 }));
      if (bytes !== undefined) return { bytes, source: 'vm_stat' };
    } catch {
      // Falls back to os.freemem().
    }
  }
  const free = os.freemem();
  return free > 0 ? { bytes: free, source: 'os.freemem' } : {};
}

/** The share of CPU time all CPUs spent idle over `sampleMs`, waiting without using a CPU. */
function sampleIdleFraction(sampleMs: number): number | undefined {
  const totals = () =>
    os.cpus().reduce(
      (sum, cpu) => {
        const { user, nice, sys, idle, irq } = cpu.times;
        return { idle: sum.idle + idle, all: sum.all + user + nice + sys + idle + irq };
      },
      { idle: 0, all: 0 }
    );
  const before = totals();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sampleMs);
  const after = totals();
  const all = after.all - before.all;
  return all > 0 ? Math.min(1, Math.max(0, (after.idle - before.idle) / all)) : undefined;
}

function cgroupCpuLimit(platform: string): number | undefined {
  if (platform !== 'linux') return undefined;
  const v2 = readText('/sys/fs/cgroup/cpu.max');
  if (v2 !== undefined) return parseCgroupCpuMax(v2);
  const quota = Number(readText('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const period = Number(readText('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  return quota > 0 && period > 0 ? quota / period : undefined;
}

function countSpecFiles(testDir: string): number | undefined {
  try {
    return fs.readdirSync(testDir).filter((name) => name.endsWith('.spec.ts')).length;
  } catch {
    return undefined;
  }
}

/**
 * Reads the signals: cheap reads of the operating system and one CPU sample of `IDLE_SAMPLE_MS`. Each signal
 * that cannot be read is left out, and the estimate names it.
 */
export function readSignals(env: NodeJS.ProcessEnv, testDir: string): ConcurrencySignals {
  const platform = process.platform;
  const isPrivate = (env.BROWSER_FORK_RPC_URL ?? '') !== '';
  let cache: ConcurrencySignals['cache'] = 'cold';
  try {
    const root = forkCacheRoot(env, env.BROWSER_FORK_BLOCK === 'latest' ? 'latest' : 'pinned');
    if (root === undefined) cache = 'off';
    else if (fs.lstatSync(sharedCacheFile(root, isPrivate ? 'private' : 'public', PINNED_BLOCK)).isFile()) {
      cache = 'warm';
    }
  } catch {
    // A missing file is a cold cache; a wrong setting stops the run later, in the global setup, with its error.
  }
  const memory = availableMemory(platform);
  let parallelism: number | undefined;
  try {
    parallelism = os.availableParallelism();
  } catch {
    parallelism = os.cpus().length || undefined;
  }
  return {
    platform,
    availableParallelism: parallelism,
    cgroupCpuLimit: cgroupCpuLimit(platform),
    idleFraction: sampleIdleFraction(IDLE_SAMPLE_MS),
    availableMemoryBytes: memory.bytes,
    memorySource: memory.source,
    specFiles: countSpecFiles(path.resolve(testDir)),
    upstream: isPrivate ? 'private' : 'public',
    cache,
  };
}

/**
 * The worker count for this run: from the environment when BROWSER_TEST_WORKERS or an interactive session
 * decides it, without reading the machine, and otherwise from `read`'s signals.
 */
export function estimateWorkers(env: NodeJS.ProcessEnv, read: () => ConcurrencySignals): WorkerSelection {
  const decided = env.BROWSER_WALLET_INTERACTIVE === '1' || !['', 'auto', undefined].includes(env.BROWSER_TEST_WORKERS);
  return selectWorkers(decided ? { platform: process.platform, upstream: 'public', cache: 'off' } : read(), env);
}

/** How many workers a run used, and why: the selection, or `--workers` when it set another count. */
export function workersText({
  workers,
  selection,
  isCliOverride,
}: {
  workers: number;
  selection?: Pick<WorkerSelection, 'workers' | 'source' | 'reasons' | 'missing'>;
  isCliOverride: boolean;
}): string {
  if (selection === undefined) return `${workers}`;
  if (isCliOverride) return `${workers}, set by --workers (the estimate was ${selection.workers})`;
  const missing = selection.missing.length > 0 ? ` Signals not read: ${selection.missing.join(', ')}.` : '';
  return `${workers}, by ${selection.source}: ${selection.reasons.join('; ')}.${missing}`;
}

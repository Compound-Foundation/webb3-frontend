/**
 * @jest-environment node
 */
// The choice of how many Playwright workers, each with its own fork lane, a run of the browser suite uses.
import {
  CPUS_PER_WORKER,
  DEFAULT_MAX_WORKERS,
  estimateWorkers,
  MAX_OVERRIDE_WORKERS,
  MEMORY_PER_WORKER,
  parseCgroupCpuMax,
  parseMeminfoAvailable,
  parseVmStatAvailable,
  PUBLIC_COLD_MAX_WORKERS,
  SHARED_CPUS,
  SHARED_MEMORY,
  selectWorkers,
  type ConcurrencySignals,
} from '../concurrency';

const GIB = 1024 ** 3;

/** A large idle workstation with a warm cache and the public endpoints: only the default maximum limits it. */
const ROOMY: ConcurrencySignals = {
  platform: 'darwin',
  availableParallelism: 16,
  idleFraction: 0.9,
  availableMemoryBytes: 100 * GIB,
  memorySource: 'vm_stat',
  specFiles: 11,
  upstream: 'public',
  cache: 'warm',
};

describe('the estimate', () => {
  test('is bounded by the default maximum on a large idle machine', () => {
    const selection = selectWorkers(ROOMY, {});
    expect(selection.workers).toBe(DEFAULT_MAX_WORKERS);
    expect(selection.source).toBe('estimate');
    expect(selection.limits.max).toBe(DEFAULT_MAX_WORKERS);
    expect(selection.limits.cpu).toBeGreaterThan(DEFAULT_MAX_WORKERS);
    expect(selection.limits.memory).toBeGreaterThan(DEFAULT_MAX_WORKERS);
    expect(selection.missing).toEqual([]);
    expect(selection.reasons.join(' ')).toContain('default maximum');
  });

  test('counts only the idle share of the CPUs, after the shared services', () => {
    // 16 CPUs at 25 % idle leave 4 CPUs, 2 of them for the shared services: one worker's worth.
    const busy = selectWorkers({ ...ROOMY, idleFraction: 0.25 }, {});
    expect(busy.limits.cpu).toBe(Math.floor((16 * 0.25 - SHARED_CPUS) / CPUS_PER_WORKER));
    expect(busy.workers).toBe(1);
    // A cgroup quota below the visible CPUs is the limit, as in a container.
    const quota = selectWorkers({ ...ROOMY, cgroupCpuLimit: 4, idleFraction: 1 }, {});
    expect(quota.limits.cpu).toBe(1);
    expect(quota.workers).toBe(1);
  });

  test('keeps the shared services and headroom out of the memory it divides between workers', () => {
    const memory = SHARED_MEMORY + 2 * MEMORY_PER_WORKER + GIB / 2;
    const selection = selectWorkers({ ...ROOMY, availableMemoryBytes: memory }, {});
    expect(selection.limits.memory).toBe(2);
    expect(selection.workers).toBe(2);
  });

  test('is never below one worker, however constrained the machine', () => {
    const selection = selectWorkers(
      { ...ROOMY, availableParallelism: 1, idleFraction: 0, availableMemoryBytes: 256 * 1024 ** 2 },
      {}
    );
    expect(selection.workers).toBe(1);
    expect(selection.reasons.join(' ')).toMatch(/at least one worker/);
  });

  test('uses no more workers than there are spec files, since a file runs in one worker', () => {
    expect(selectWorkers({ ...ROOMY, specFiles: 3 }, {}).workers).toBe(3);
    expect(selectWorkers({ ...ROOMY, specFiles: 3 }, {}).limits.files).toBe(3);
  });

  test('limits a run that reads the public endpoints with no warm cache, whose misses all go upstream', () => {
    const cold = selectWorkers({ ...ROOMY, cache: 'cold' }, {});
    expect(cold.workers).toBe(PUBLIC_COLD_MAX_WORKERS);
    expect(cold.limits.upstream).toBe(PUBLIC_COLD_MAX_WORKERS);
    expect(selectWorkers({ ...ROOMY, cache: 'off' }, {}).workers).toBe(PUBLIC_COLD_MAX_WORKERS);
    // A private endpoint, or a warm cache, has the default maximum.
    expect(selectWorkers({ ...ROOMY, cache: 'cold', upstream: 'private' }, {}).workers).toBe(DEFAULT_MAX_WORKERS);
  });

  test('falls back to conservative values for each signal it cannot read, and names them', () => {
    const selection = selectWorkers(
      {
        platform: 'unknown',
        upstream: 'public',
        cache: 'warm',
      },
      {}
    );
    expect(selection.missing).toEqual(['CPU count', 'CPU idle share', 'available memory', 'spec file count']);
    expect(selection.workers).toBe(1);
    // An unknown idle share counts half the CPUs as busy.
    const halfIdle = selectWorkers({ ...ROOMY, idleFraction: undefined }, {});
    expect(halfIdle.limits.cpu).toBe(Math.floor((16 * 0.5 - SHARED_CPUS) / CPUS_PER_WORKER));
    expect(halfIdle.missing).toEqual(['CPU idle share']);
  });
});

describe('an explicit count', () => {
  test('BROWSER_TEST_WORKERS sets it, one worker included, whatever the estimate', () => {
    for (const value of ['1', '3', String(MAX_OVERRIDE_WORKERS)]) {
      const selection = selectWorkers({ ...ROOMY, idleFraction: 0 }, { BROWSER_TEST_WORKERS: value });
      expect(selection.workers).toBe(Number(value));
      expect(selection.source).toBe('override');
      expect(selection.reasons.join(' ')).toContain('BROWSER_TEST_WORKERS');
    }
  });

  test('auto, or an empty value, is the estimate', () => {
    expect(selectWorkers(ROOMY, { BROWSER_TEST_WORKERS: 'auto' }).source).toBe('estimate');
    expect(selectWorkers(ROOMY, { BROWSER_TEST_WORKERS: '' }).source).toBe('estimate');
  });

  test('refuses anything but a whole number from 1 to the bound, rather than guess', () => {
    for (const value of ['0', '-1', '2.5', 'four', '1e1', String(MAX_OVERRIDE_WORKERS + 1), ' 2']) {
      expect(() => selectWorkers(ROOMY, { BROWSER_TEST_WORKERS: value })).toThrow(/BROWSER_TEST_WORKERS/);
    }
  });

  test('an interactive session has one worker', () => {
    const selection = selectWorkers(ROOMY, { BROWSER_WALLET_INTERACTIVE: '1', BROWSER_TEST_WORKERS: '4' });
    expect(selection).toMatchObject({ workers: 1, source: 'interactive' });
  });
});

describe('the reading of the signals', () => {
  test('is skipped when BROWSER_TEST_WORKERS or an interactive session decides the count', () => {
    const read = jest.fn(() => ROOMY);
    expect(estimateWorkers({ BROWSER_TEST_WORKERS: '3' }, read).workers).toBe(3);
    expect(estimateWorkers({ BROWSER_WALLET_INTERACTIVE: '1' }, read).workers).toBe(1);
    expect(() => estimateWorkers({ BROWSER_TEST_WORKERS: 'many' }, read)).toThrow(/BROWSER_TEST_WORKERS/);
    expect(read).not.toHaveBeenCalled();
    expect(estimateWorkers({ BROWSER_TEST_WORKERS: 'auto' }, read).workers).toBe(DEFAULT_MAX_WORKERS);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('the signals read from the operating system', () => {
  test("Linux's MemAvailable, in bytes", () => {
    expect(parseMeminfoAvailable('MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n')).toBe(8000000 * 1024);
    expect(parseMeminfoAvailable('MemTotal: 1 kB\n')).toBeUndefined();
  });

  test("a cgroup v2 CPU quota, in CPUs, and none for 'max'", () => {
    expect(parseCgroupCpuMax('200000 100000\n')).toBe(2);
    expect(parseCgroupCpuMax('150000 100000')).toBe(1.5);
    expect(parseCgroupCpuMax('max 100000\n')).toBeUndefined();
    expect(parseCgroupCpuMax('garbage')).toBeUndefined();
  });

  test("macOS's reclaimable memory from vm_stat: free, inactive and speculative pages", () => {
    const vmStat = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                                   100.',
      'Pages active:                                 999.',
      'Pages inactive:                               200.',
      'Pages speculative:                             30.',
      'Pages wired down:                             999.',
      'Pages purgeable:                                4.',
    ].join('\n');
    // Purgeable pages are already counted among the active and inactive ones, so they are not added again.
    expect(parseVmStatAvailable(vmStat)).toBe((100 + 200 + 30) * 16384);
    expect(parseVmStatAvailable('nothing here')).toBeUndefined();
  });
});

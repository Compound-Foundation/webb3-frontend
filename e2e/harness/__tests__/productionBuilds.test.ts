/**
 * @jest-environment node
 */
// BROWSER_TEST_PARALLEL_BUILDS selects serial or parallel production builds.
// These checks cover worker environments, `buildProduction` settings, and worker and esbuild cleanup after failure.
// The worker builds use a small fixture app.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { build } from 'vite';

import { REPO_ROOT } from '../paths';
import {
  BUILD_WORKER_FILE,
  buildProductionsInWorkers,
  productionBuildModeOf,
  workerEnvironmentOf,
} from '../productionBuilds';
import { assertProduction, buildProduction, type ResolvedBuild } from '../viteApp';

// Vite ships ESM only, which Jest cannot load. The worker threads load the real Vite outside Jest.
jest.mock('vite', () => ({ build: jest.fn(), createServer: jest.fn() }));

const CONFIG_MODULE = path.join(REPO_ROOT, 'e2e/harness/productionBuildConfig.mjs');

/** Runs `body`, a function of the shared configuration module, in a worker thread, and returns its result. */
function withConfigModule<T>(body: string): Promise<T> {
  const code = `
    const { parentPort } = require('node:worker_threads');
    import(${JSON.stringify(pathToFileURL(CONFIG_MODULE).href)}).then(async (module) => {
      parentPort.postMessage(await (${body})(module));
    });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true });
    worker.once('message', (message) => {
      resolve(message);
      void worker.terminate();
    });
    worker.once('error', reject);
  });
}

/** The esbuild processes this process started, which a stopped build must not leave running. */
function esbuildChildren(): string[] {
  // `-axo` and the column list work in both procps (Linux) and BSD (macOS) `ps`.
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' });
  return output.split('\n').filter((line) => {
    // macOS prints the command's full path, which can contain spaces.
    const match = /^\s*\d+\s+(\d+)\s+(.*)$/.exec(line);
    return match !== null && Number(match[1]) === process.pid && match[2].includes('esbuild');
  });
}

/** Waits up to two seconds for every esbuild child to exit, as each does when its worker's pipe closes. */
async function expectNoEsbuildChildren() {
  for (let attempt = 0; attempt < 20 && esbuildChildren().length > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(esbuildChildren()).toEqual([]);
}

describe('productionBuildModeOf', () => {
  it('builds one after another unless BROWSER_TEST_PARALLEL_BUILDS is 1', () => {
    for (const value of [undefined, '', '0']) {
      expect(productionBuildModeOf({ BROWSER_TEST_PARALLEL_BUILDS: value })).toBe('serial');
    }
    expect(productionBuildModeOf({ BROWSER_TEST_PARALLEL_BUILDS: '1' })).toBe('parallel');
  });

  it('refuses any other value', () => {
    for (const value of ['true', 'yes', '2', ' 1']) {
      expect(() => productionBuildModeOf({ BROWSER_TEST_PARALLEL_BUILDS: value })).toThrow(
        'BROWSER_TEST_PARALLEL_BUILDS must be 0 or 1.'
      );
    }
  });
});

describe('workerEnvironmentOf', () => {
  it('drops NODE_ENV and every inherited VITE_ variable, and adds exactly the given ones', () => {
    const runnerEnvironment = {
      PATH: '/usr/bin',
      HOME: '/home/runner',
      NODE_ENV: 'development',
      VITE_SCREENING_ENDPOINT: 'http://inherited.invalid',
      VITE_INHERITED: 'inherited',
    };
    expect(workerEnvironmentOf(runnerEnvironment, { VITE_V3_RPC_PROVIDER_HOST: 'https://rpc.invalid' })).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/runner',
      NODE_ENV: 'production',
      VITE_V3_RPC_PROVIDER_HOST: 'https://rpc.invalid',
    });
  });

  it('refuses a build environment that names a variable other than VITE_', () => {
    const environment = { NODE_ENV: 'development' } as unknown as Record<`VITE_${string}`, string>;
    expect(() => workerEnvironmentOf({}, environment)).toThrow('non-VITE_ variables: NODE_ENV');
  });
});

describe('the worker settings', () => {
  const buildMock = build as jest.MockedFunction<typeof build>;
  const production = { mode: 'production', isProduction: true, env: { DEV: false, PROD: true } };

  it('match the settings of buildProduction', async () => {
    let nodeEnvDuringBuild: string | undefined;
    buildMock.mockImplementationOnce(async (config) => {
      nodeEnvDuringBuild = process.env.NODE_ENV;
      const recorder = config?.plugins?.[0] as { configResolved: (resolved: unknown) => void };
      recorder.configResolved(production);
      return [] as never;
    });
    const arguments_ = { outDir: '/out', envDir: '/env' };
    const resolved = await buildProduction({ ...arguments_, environment: { VITE_GIVEN: 'given' } });
    const { plugins, ...settings } = buildMock.mock.calls[0][0] as { plugins: { name: string }[] };

    const worker = await withConfigModule<{ settings: object; pluginNames: string[]; resolved: ResolvedBuild }>(
      `(module) => {
        let resolved;
        const { plugins, ...settings } = module.productionInlineConfig({
          configFile: ${JSON.stringify(path.join(REPO_ROOT, 'vite.config.js'))},
          root: ${JSON.stringify(REPO_ROOT)},
          envDir: '/env',
          outDir: '/out',
          onResolved: (each) => (resolved = each),
        });
        plugins[0].configResolved(${JSON.stringify(production)});
        return { settings, pluginNames: plugins.map((plugin) => plugin.name), resolved };
      }`
    );
    expect(worker.settings).toEqual(settings);
    expect(worker.pluginNames).toEqual(plugins.map((plugin) => plugin.name));
    expect(worker.resolved).toEqual(resolved);
    expect(nodeEnvDuringBuild).toBe('production');
  });

  it('refuse the configurations assertProduction refuses, with the same message', async () => {
    const refused: ResolvedBuild[] = [
      { mode: 'production', isProduction: true, DEV: true, PROD: true },
      { mode: 'production', isProduction: true, DEV: false, PROD: false },
      { mode: 'development', isProduction: false, DEV: false, PROD: true },
    ];
    const messages = await withConfigModule<string[]>(
      `(module) => ${JSON.stringify(refused)}.map((each) => {
        try { module.assertProductionBuild(each); return 'accepted'; } catch (error) { return error.message; }
      })`
    );
    expect(messages).toEqual(
      refused.map((each) => {
        try {
          assertProduction(each);
          return 'accepted';
        } catch (error) {
          return (error as Error).message;
        }
      })
    );
  });

  it('refuse a worker environment without NODE_ENV=production or with other VITE_ variables', async () => {
    const results = await withConfigModule<string[]>(
      `(module) => [
        [{ NODE_ENV: 'production', VITE_A: 'a' }, { VITE_A: 'a' }],
        [{ NODE_ENV: 'development', VITE_A: 'a' }, { VITE_A: 'a' }],
        [{ VITE_A: 'a' }, { VITE_A: 'a' }],
        [{ NODE_ENV: 'production', VITE_A: 'a', VITE_EXTRA: 'x' }, { VITE_A: 'a' }],
        [{ NODE_ENV: 'production' }, { VITE_A: 'a' }],
        [{ NODE_ENV: 'production', VITE_A: 'b' }, { VITE_A: 'a' }],
      ].map(([env, environment]) => {
        try { module.assertBuildEnvironment(env, environment); return 'accepted'; } catch (error) { return error.message; }
      })`
    );
    expect(results[0]).toBe('accepted');
    expect(results.slice(1, 3)).toEqual(
      Array(2).fill('The production build worker does not have NODE_ENV=production.')
    );
    for (const message of results.slice(3)) expect(message).toMatch(/not exactly the given \[VITE_A\]/);
  });
});

describe('buildProductionsInWorkers', () => {
  let fixture: string;
  let envDir: string;
  let configFile: string;
  const savedEnvironment = { ...process.env };

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'production-builds-'));
    envDir = path.join(fixture, 'empty-env-dir');
    fs.mkdirSync(envDir);
    configFile = path.join(fixture, 'vite.config.mjs');
    fs.writeFileSync(
      path.join(fixture, 'index.html'),
      '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>'
    );
    fs.writeFileSync(
      path.join(fixture, 'main.js'),
      'document.body.textContent = JSON.stringify([import.meta.env, import.meta.env.VITE_LEAKED]);'
    );
    // The fixture's plugin reads the worker's environment: VITE_FIXTURE_FAIL fails the build, and
    // VITE_FIXTURE_DELAY_MS holds it before Rollup starts. VITE_FIXTURE_NODE_ENV changes NODE_ENV as a
    // configuration file can, after the worker's environment check and before Vite resolves the configuration.
    fs.writeFileSync(
      configFile,
      `if (process.env.VITE_FIXTURE_NODE_ENV) process.env.NODE_ENV = process.env.VITE_FIXTURE_NODE_ENV;
      export default {
        plugins: [{
          name: 'fixture',
          async buildStart() {
            if (process.env.VITE_FIXTURE_FAIL === '1') throw new Error('The fixture build failed.');
            const delayMs = Number(process.env.VITE_FIXTURE_DELAY_MS ?? 0);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          },
        }],
      };`
    );
    // The runner's environment deliberately includes values forbidden in worker builds.
    process.env.NODE_ENV = 'development';
    process.env.VITE_LEAKED = 'leaked-from-the-runner';
  });

  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in savedEnvironment)) delete process.env[name];
    Object.assign(process.env, savedEnvironment);
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  const outputOf = (outDir: string) =>
    fs
      .readdirSync(path.join(outDir, 'assets'))
      .map((file) => fs.readFileSync(path.join(outDir, 'assets', file), 'utf8'))
      .join('\n');

  it('builds each app with exactly its own environment and leaves the runner environment unchanged', async () => {
    const firstOut = path.join(fixture, 'dist-first');
    const secondOut = path.join(fixture, 'dist-second');
    const resolved = await buildProductionsInWorkers({
      envDir,
      configFile,
      root: fixture,
      builds: [
        { outDir: firstOut, environment: { VITE_GIVEN: 'first-build-value' } },
        { outDir: secondOut, environment: { VITE_GIVEN: 'second-build-value', VITE_ONLY_SECOND: 'second-only' } },
      ],
    });

    const production = { mode: 'production', isProduction: true, DEV: false, PROD: true };
    expect(resolved).toEqual([production, production]);
    const first = outputOf(firstOut);
    const second = outputOf(secondOut);
    expect(first).toContain('first-build-value');
    expect(first).not.toMatch(/second-build-value|second-only|leaked-from-the-runner/);
    expect(second).toContain('second-build-value');
    expect(second).toContain('second-only');
    expect(second).not.toMatch(/first-build-value|leaked-from-the-runner/);
    expect(process.env.NODE_ENV).toBe('development');
    expect(process.env.VITE_LEAKED).toBe('leaked-from-the-runner');
    expect(process.env.VITE_GIVEN).toBeUndefined();
    await expectNoEsbuildChildren();
  }, 60_000);

  it('stops the other worker when one build fails, and leaves no esbuild process', async () => {
    const failedOut = path.join(fixture, 'dist-failed');
    const slowOut = path.join(fixture, 'dist-slow');
    const startedAt = Date.now();
    await expect(
      buildProductionsInWorkers({
        envDir,
        configFile,
        root: fixture,
        builds: [
          { outDir: failedOut, environment: { VITE_FIXTURE_FAIL: '1' } },
          { outDir: slowOut, environment: { VITE_FIXTURE_DELAY_MS: '120000' } },
        ],
      })
    ).rejects.toThrow('The fixture build failed.');
    // Without termination, the slow build holds its worker for two minutes. The rejection waits for worker exit.
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    expect(fs.existsSync(path.join(slowOut, 'index.html'))).toBe(false);
    await expectNoEsbuildChildren();
  }, 60_000);

  it('refuses a build that resolved DEV=true before it writes any output', async () => {
    const outDir = path.join(fixture, 'dist-development');
    await expect(
      buildProductionsInWorkers({
        envDir,
        configFile,
        root: fixture,
        builds: [{ outDir, environment: { VITE_FIXTURE_NODE_ENV: 'development' } }],
      })
    ).rejects.toThrow(/resolved DEV=true, PROD=false/);
    expect(fs.existsSync(outDir)).toBe(false);
    await expectNoEsbuildChildren();
  }, 60_000);

  it('refuses a refused environment before any worker starts', async () => {
    const environment = { VITE_GIVEN: 'given', PATH: '/nowhere' } as unknown as Record<`VITE_${string}`, string>;
    await expect(
      buildProductionsInWorkers({
        envDir,
        configFile,
        root: fixture,
        builds: [
          { outDir: path.join(fixture, 'dist-first'), environment: { VITE_FIXTURE_DELAY_MS: '120000' } },
          { outDir: path.join(fixture, 'dist-second'), environment },
        ],
      })
    ).rejects.toThrow('non-VITE_ variables: PATH');
    await expectNoEsbuildChildren();
  });

  it('the worker itself refuses an environment with a VITE_ variable it was not given', async () => {
    const worker = new Worker(BUILD_WORKER_FILE, {
      env: { ...workerEnvironmentOf(process.env, { VITE_GIVEN: 'given' }), VITE_EXTRA: 'extra' },
      workerData: {
        configFile,
        root: fixture,
        envDir,
        outDir: path.join(fixture, 'dist'),
        environment: { VITE_GIVEN: 'given' },
      },
    });
    const error = await new Promise<Error>((resolve) => worker.once('error', resolve));
    expect(error.message).toMatch(/VITE_\* variables \[VITE_EXTRA, VITE_GIVEN\], not exactly the given \[VITE_GIVEN\]/);
    expect(fs.existsSync(path.join(fixture, 'dist'))).toBe(false);
  }, 30_000);
});

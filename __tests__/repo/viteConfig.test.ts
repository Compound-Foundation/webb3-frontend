/**
 * @jest-environment node
 */
// These checks cover Vite 8's resolved production, plain dev and bundled dev configurations.
// The dependency optimizer checks execute the Buffer and process shims.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { BUNDLED_DEV_CONFIG } from '../../e2e/harness/viteApp';

// Vite and Rolldown ship ESM only, which Jest cannot load, so they run in a child process.
jest.mock('vite', () => ({}));

const ROOT = path.join(__dirname, '..', '..');
const HTML_ENTRIES = [
  'main',
  'markets',
  'marketDetail',
  'extensions',
  'vote',
  'extensionDetail',
  'transactions',
  'rewards',
  'redirect',
];

// The build-only plugin that replaces process.env.NODE_ENV before the Node polyfills rewrite `process`.
const NODE_ENV_PLUGIN = 'replace-node-env-before-polyfills';

/** Runs `script` as an ES module in a child Node process with `input`, and returns what it writes as JSON. */
function inChild<T>(script: string, input: unknown, nodeEnv: 'development' | 'production'): T {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITE_')));
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(input)], {
    cwd: ROOT,
    env: { ...environment, NODE_ENV: nodeEnv },
    encoding: 'utf8',
    timeout: 90_000,
  });
  return JSON.parse(output);
}

type Resolved = {
  isProduction: boolean;
  DEV: boolean;
  PROD: boolean;
  bundledDev: boolean;
  base: string;
  target: unknown;
  minify: unknown;
  cssMinify: unknown;
  inputs: string[];
  plugins: string[];
  vitePlugins: string[];
  output: Record<string, unknown> | undefined;
  renderedUrl: unknown;
  walletConnect: string | undefined;
  define: Record<string, string>;
  host: unknown;
  optimizer: { define?: Record<string, string>; inject?: Record<string, [string, string]>; target?: string };
  esbuildPlugins: number;
};

/** Resolves the repository's configuration for `command` with `inline` merged in, as Vite does on start. */
function resolve(command: 'build' | 'serve', inline: object = {}): Resolved {
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-config-env-'));
  const script = `
    const { resolveConfig } = await import(${JSON.stringify(path.join(ROOT, 'node_modules/vite/dist/node/index.js'))});
    const { root, envDir, command, inline } = JSON.parse(process.argv[1]);
    const mode = command === 'build' ? 'production' : 'development';
    const config = await resolveConfig({ configFile: root + '/vite.config.js', root, envDir, mode, logLevel: 'silent', ...inline }, command);
    const options = config.build.rolldownOptions;
    const render = config.experimental.renderBuiltUrl;
    const aliases = Array.isArray(config.resolve.alias) ? config.resolve.alias : [];
    process.stdout.write(JSON.stringify({
      isProduction: config.isProduction,
      DEV: config.env.DEV,
      PROD: config.env.PROD,
      bundledDev: Boolean(config.experimental.bundledDev),
      base: config.base,
      target: config.build.target,
      minify: config.build.minify,
      cssMinify: config.build.cssMinify,
      inputs: Object.keys(options.input ?? {}),
      plugins: [options.plugins ?? []].flat(Infinity).map((plugin) => plugin?.name),
      vitePlugins: config.plugins.map((plugin) => plugin.name),
      output: options.output,
      renderedUrl: render === undefined ? null : render('assets/x.js', { hostId: 'index.html', hostType: 'html', type: 'asset', ssr: false }),
      walletConnect: aliases.find((alias) => alias.find === '@walletconnect/ethereum-provider')?.replacement,
      define: config.define,
      host: config.server.host,
      optimizer: config.optimizeDeps.rolldownOptions?.transform ?? {},
      esbuildPlugins: config.optimizeDeps.esbuildOptions?.plugins?.length ?? 0,
    }));
  `;
  try {
    return inChild<Resolved>(
      script,
      { root: ROOT, envDir, command, inline },
      command === 'build' ? 'production' : 'development'
    );
  } finally {
    fs.rmSync(envDir, { recursive: true, force: true });
  }
}

test('the production build keeps its target, minifiers, nine HTML entries, relative URLs and the Node polyfills', () => {
  const resolved = resolve('build');
  expect(resolved).toMatchObject({
    isProduction: true,
    DEV: false,
    PROD: true,
    bundledDev: false,
    base: './',
    target: ['es2020'],
    minify: 'esbuild',
    cssMinify: 'esbuild',
    renderedUrl: { relative: true },
    walletConnect: path.join(ROOT, 'node_modules/@walletconnect/ethereum-provider/dist/index.umd.js'),
    host: '127.0.0.1',
  });
  expect(resolved.inputs).toEqual(HTML_ENTRIES);
  expect(resolved.plugins).toEqual(['polyfill-node']);
  expect(resolved.vitePlugins).toContain(NODE_ENV_PLUGIN);
  expect(resolved.define).toMatchObject({ global: 'globalThis' });
  // The harness's bundled dev setting is not in the configuration file.
  expect(resolved.output?.strictExecutionOrder).toBeUndefined();
}, 120_000);

test('the default dev server is unbundled and runs no esbuild plugin in the dependency optimizer', () => {
  const resolved = resolve('serve');
  expect(resolved).toMatchObject({ isProduction: false, DEV: true, PROD: false, bundledDev: false, esbuildPlugins: 0 });
  // The dev server keeps React's development build.
  expect(resolved.vitePlugins).not.toContain(NODE_ENV_PLUGIN);
  expect(resolved.output?.strictExecutionOrder).toBeUndefined();
}, 120_000);

test("the harness's bundled dev server keeps the configuration's entries and plugins and runs modules in order", () => {
  const resolved = resolve('serve', BUNDLED_DEV_CONFIG);
  expect(resolved).toMatchObject({ DEV: true, PROD: false, bundledDev: true, host: '127.0.0.1' });
  // The override preserves the entries and Node polyfills in the configuration's `rollupOptions`.
  // Bundled dev uses these polyfills for Buffer and process because its dependency optimizer does not run.
  expect(resolved.inputs).toEqual(HTML_ENTRIES);
  expect(resolved.plugins).toEqual(['polyfill-node']);
  expect(resolved.output).toEqual({ strictExecutionOrder: true });
  expect(resolved.vitePlugins).not.toContain(NODE_ENV_PLUGIN);
  // Vite drops `renderBuiltUrl` in bundled dev only. The production test above checks that the build keeps it.
  expect(resolved.renderedUrl).toBeNull();
}, 120_000);

describe("the production build's React", () => {
  type Markers = {
    /** The development markers that `yarn build`'s check rejects, and the ones the bundle contains. */
    development: string[];
    foundDevelopment: string[];
    /** Whether the bundle contains the production marker that `yarn build`'s check requires. */
    foundProduction: boolean;
  };

  /**
   * Builds React and ReactDOM's client through the repository's configuration with `nodeEnv` as NODE_ENV, as
   * `vite build` does, and returns which of the markers in `scripts/lib/development-react.js` the bundled
   * JavaScript contains. That module holds the markers `yarn build` checks the app's bundle for. The plugins,
   * Node polyfills, target and minifier are the app's. The entry, output and env directory are not.
   */
  function buildReact(nodeEnv: 'development' | 'production'): Markers {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-config-react-'));
    const entry = path.join(directory, 'entry.js');
    // The entry imports React's CommonJS entry points, which choose a build from process.env.NODE_ENV.
    fs.writeFileSync(
      entry,
      `import { createElement } from ${JSON.stringify(path.join(ROOT, 'node_modules/react/index.js'))};
       import { createRoot } from ${JSON.stringify(path.join(ROOT, 'node_modules/react-dom/client.js'))};
       createRoot(document.body).render(createElement('div'));`
    );
    const script = `
      const { build, loadConfigFromFile } = await import(${JSON.stringify(
        path.join(ROOT, 'node_modules/vite/dist/node/index.js')
      )});
      const { DEVELOPMENT_REACT_MARKERS, PRODUCTION_REACT_MARKER, findDevelopmentReactMarkers } = await import(${JSON.stringify(
        path.join(ROOT, 'scripts/lib/development-react.js')
      )});
      const { root, envDir, entry, outDir } = JSON.parse(process.argv[1]);
      const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, root + '/vite.config.js', root, 'silent');
      const config = loaded.config;
      const output = await build({
        ...config,
        configFile: false,
        root,
        envDir,
        mode: 'production',
        logLevel: 'silent',
        build: {
          ...config.build,
          outDir,
          write: false,
          rollupOptions: { ...config.build.rollupOptions, input: { entry } },
        },
      });
      const chunks = [output].flat().flatMap((result) => result.output).filter((file) => file.type === 'chunk');
      const code = chunks.map((chunk) => chunk.code).join('\\n');
      process.stdout.write(JSON.stringify({
        development: DEVELOPMENT_REACT_MARKERS.map(({ marker }) => marker),
        foundDevelopment: findDevelopmentReactMarkers(code),
        foundProduction: code.includes(PRODUCTION_REACT_MARKER.marker),
      }));
    `;
    try {
      return inChild<Markers>(
        script,
        { root: ROOT, envDir: directory, entry, outDir: path.join(directory, 'out') },
        nodeEnv
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  test('is the production build of React and ReactDOM', () => {
    const markers = buildReact('production');
    expect(markers.development).not.toHaveLength(0);
    expect(markers).toMatchObject({ foundDevelopment: [], foundProduction: true });
  }, 120_000);

  test('follows NODE_ENV=development to the development build, as Vite does', () => {
    // The browser harness builds the app with NODE_ENV=development to compile DEV=true in mode production.
    // Every marker survives the app's minifier, so `yarn build`'s check would reject this bundle.
    const markers = buildReact('development');
    expect(markers.foundDevelopment).toEqual(markers.development);
    expect(markers.foundProduction).toBe(false);
  }, 120_000);
});

describe('the dependency optimizer', () => {
  const polyfills = path.join(ROOT, 'node_modules/@esbuild-plugins/node-globals-polyfill');

  test('injects the Buffer and process shims and maps global to globalThis', () => {
    // The React plugin adds its own JSX setting beside these.
    expect(resolve('serve').optimizer).toMatchObject({
      target: 'esnext',
      define: { global: 'globalThis' },
      inject: {
        Buffer: [path.join(polyfills, 'Buffer.js'), 'Buffer'],
        process: [path.join(polyfills, 'process.js'), 'process'],
      },
    });
  }, 120_000);

  /**
   * Bundles a dependency with or without the optimizer's transform options.
   * Runs the result in a context without Buffer, process or global, like a browser.
   */
  function runDependency(withShims: boolean): unknown {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-config-shims-'));
    const entry = path.join(directory, 'dependency.js');
    fs.writeFileSync(
      entry,
      `export const result = {
         hex: Buffer.from('ab', 'utf8').toString('hex'),
         isBuffer: Buffer.isBuffer(Buffer.alloc(1)),
         env: typeof process.env,
         nextTick: typeof process.nextTick,
         isGlobal: global === globalThis,
         big: String(2n ** 64n),
       };`
    );
    const script = `
      const { rolldown } = await import(${JSON.stringify(path.join(ROOT, 'node_modules/rolldown/dist/index.mjs'))});
      const { resolveConfig } = await import(${JSON.stringify(
        path.join(ROOT, 'node_modules/vite/dist/node/index.js')
      )});
      const { root, entry, withShims } = JSON.parse(process.argv[1]);
      const config = await resolveConfig({ configFile: root + '/vite.config.js', root, logLevel: 'silent' }, 'serve');
      const bundle = await rolldown({
        input: entry,
        platform: 'browser',
        transform: withShims ? config.optimizeDeps.rolldownOptions.transform : {},
      });
      const { output } = await bundle.generate({ format: 'iife', name: 'dependency' });
      process.stdout.write(JSON.stringify(output[0].code));
    `;
    try {
      const code = inChild<string>(script, { root: ROOT, entry, withShims }, 'development');
      // A context with JavaScript's own globals only: no Buffer, process or global.
      const context = vm.createContext({ setTimeout, clearTimeout });
      return JSON.parse(vm.runInContext(`${code}; JSON.stringify(dependency.result)`, context));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  test("gives a dependency working Buffer and process globals in a browser's context", () => {
    expect(runDependency(true)).toEqual({
      hex: '6162',
      isBuffer: true,
      env: 'object',
      nextTick: 'function',
      isGlobal: true,
      big: '18446744073709551616',
    });
    // Without the shims the same dependency fails, so the test above measures them.
    expect(() => runDependency(false)).toThrow(/Buffer is not defined/);
  }, 120_000);
});

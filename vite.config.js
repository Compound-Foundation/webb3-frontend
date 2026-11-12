import { sentryVitePlugin } from '@sentry/bundler-plugins/vite';
import react from '@vitejs/plugin-react';

import { resolve } from 'path';

import nodePolyfills from 'rollup-plugin-polyfill-node';

import { defineConfig, transformWithOxc } from 'vite';
import pluginRewriteAll from 'vite-plugin-rewrite-all';

// The Buffer and process shims that the dependency optimizer injects into pre-bundled dependencies. They
// are the files @esbuild-plugins/node-globals-polyfill injected before Vite 8, whose esbuild plugin Vite 8's
// optimizer cannot run.
const nodeGlobalsPolyfill = (file) => resolve(__dirname, 'node_modules/@esbuild-plugins/node-globals-polyfill', file);

// Vite replaces `process.env.NODE_ENV` in the build only after other plugins' transforms. By then the Node
// polyfills below have rewritten `process` to their shim. The shim's `process.env` has no NODE_ENV, so React's
// entry points take their development branch at run time, and the build ships and runs development React.
//
// This build-only plugin runs before the polyfills. It replaces `process.env.NODE_ENV` with the value Vite
// would give it: a `define` entry for it, else NODE_ENV, else the mode. It parses the code, so it changes
// expressions only, never strings or comments. It handles JavaScript files only. Application code reads no
// `process.env`, and the dependencies that read NODE_ENV, React among them, ship JavaScript.
const replaceNodeEnvBeforePolyfills = () => {
  let define;
  let sourcemap;
  return {
    name: 'replace-node-env-before-polyfills',
    enforce: 'pre',
    apply: 'build',
    configResolved(config) {
      const nodeEnv = config.define?.['process.env.NODE_ENV'] ?? JSON.stringify(process.env.NODE_ENV || config.mode);
      define = {
        'process.env.NODE_ENV': nodeEnv,
        'global.process.env.NODE_ENV': nodeEnv,
        'globalThis.process.env.NODE_ENV': nodeEnv,
      };
      sourcemap = Boolean(config.build.sourcemap);
    },
    transform: {
      filter: { id: /\.[cm]?js$/, code: 'process.env.NODE_ENV' },
      async handler(code, id) {
        const result = await transformWithOxc(code, id, { lang: 'js', define, tsconfig: false, sourcemap });
        return { code: result.code, map: result.map ?? null };
      },
    },
  };
};

// Source maps for Sentry. Only a build with SENTRY_AUTH_TOKEN, which CI's build of this repository's branches
// has, generates them. It uploads them to Sentry and deletes them, so they never reach IPFS. Local and fork
// builds have no token and build exactly as before.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const sentryPlugins = sentryAuthToken
  ? sentryVitePlugin({
      org: 'compound-foundation',
      project: 'webb3-frontend',
      authToken: sentryAuthToken,
      // The same release name that src/helpers/sentry.ts tags events with.
      release: { name: process.env.VITE_SENTRY_RELEASE },
      sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
      telemetry: false,
    })
  : [];

// https://vitejs.dev/config/
export default defineConfig({
  // pluginRewriteAll fixes an issue where the dev server doesn't properly
  // handle paths with a `.`. See https://stackoverflow.com/questions/66734726/paramname-doesnt-match-url-segments-containing-dot-in-react-app-with-vitej
  // eg. /markets/usdc.e-arb
  // The Sentry plugin must come last.
  plugins: [replaceNodeEnvBeforePolyfills(), react(), pluginRewriteAll(), ...sentryPlugins],
  // Bind dev/preview servers to loopback only — never expose to the network
  // (do not use `--host` / `host: true`). Security: prevents the local dev
  // server from being reachable from the LAN.
  server: {
    host: '127.0.0.1',
  },
  preview: {
    host: '127.0.0.1',
  },
  // Node.js global to browser globalThis
  define: {
    global: 'globalThis',
  },
  build: {
    target: ['es2020'],
    // Hidden: the bundles carry no sourceMappingURL comment.
    sourcemap: sentryAuthToken ? 'hidden' : false,
    // Vite 8 minifies with Oxc and Lightning CSS by default. Keep esbuild, which built every release so far.
    minify: 'esbuild',
    cssMinify: 'esbuild',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        markets: resolve(__dirname, 'markets/index.html'),
        marketDetail: resolve(__dirname, 'markets/ipfs-404.html'),
        extensions: resolve(__dirname, 'extensions/index.html'),
        vote: resolve(__dirname, 'vote/index.html'),
        extensionDetail: resolve(__dirname, 'extensions/ipfs-404.html'),
        transactions: resolve(__dirname, 'transactions/index.html'),
        rewards: resolve(__dirname, 'rewards/index.html'),
        redirect: resolve(__dirname, 'redirect/index.html'),
      },
      plugins: [nodePolyfills()],
    },
  },
  base: '',
  experimental: {
    renderBuiltUrl: (filename, { hostType }) => {
      return { relative: true };
    },
  },
  resolve: {
    alias: {
      comet: resolve(__dirname, 'node_modules/comet'),
      '/fonts': resolve(__dirname, 'node_modules/compound-styles/public/fonts'),
      // Redirect the (transitive) WalletConnect provider to its self-contained UMD
      // bundle, which carries its own WalletConnect 2.21.1 packages. package.json
      // resolves the separately installed WalletConnect packages to 2.21.10 so the
      // audit passes, and ethereum-provider 2.21.1 was never released against those
      // versions. Without this alias, the dev server and the production build would
      // load that untested mix on the pairing and signing path. Keep the alias at
      // least until wagmi depends on @walletconnect/ethereum-provider 2.22.0 or
      // later and those resolutions are removed.
      '@walletconnect/ethereum-provider': resolve(
        __dirname,
        'node_modules/@walletconnect/ethereum-provider/dist/index.umd.js'
      ),
      '@components': resolve(__dirname, 'src/components'),
      '@hooks': resolve(__dirname, 'src/hooks'),
      '@contexts': resolve(__dirname, 'src/contexts'),
      '@helpers': resolve(__dirname, 'src/helpers'),
      '@types': resolve(__dirname, 'src/types'),
      '@constants': resolve(__dirname, 'src/constants'),
    },
  },
  optimizeDeps: {
    rolldownOptions: {
      transform: {
        target: 'esnext',
        // Node.js global to browser globalThis
        define: {
          global: 'globalThis',
        },
        // Node.js Buffer and process globals for dependencies that expect them
        inject: {
          Buffer: [nodeGlobalsPolyfill('Buffer.js'), 'Buffer'],
          process: [nodeGlobalsPolyfill('process.js'), 'process'],
        },
      },
    },
  },
});

import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';

import react from '@vitejs/plugin-react';

import { resolve } from 'path';

import nodePolyfills from 'rollup-plugin-polyfill-node';

import { defineConfig } from 'vite';
import pluginRewriteAll from 'vite-plugin-rewrite-all';

// https://vitejs.dev/config/
export default defineConfig({
  // pluginRewriteAll fixes an issue where the dev server doesn't properly
  // handle paths with a `.`. See https://stackoverflow.com/questions/66734726/paramname-doesnt-match-url-segments-containing-dot-in-react-app-with-vitej
  // eg. /markets/usdc.e-arb
  plugins: [react(), pluginRewriteAll()],
  // Node.js global to browser globalThis
  define: {
    global: 'globalThis',
  },
  build: {
    target: ['es2020'],
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        markets: resolve(__dirname, 'markets/index.html'),
        marketDetail: resolve(__dirname, 'markets/ipfs-404.html'),
        extensions: resolve(__dirname, 'extensions/index.html'),
        vote: resolve(__dirname, 'vote/index.html'),
        extensionDetail: resolve(__dirname, 'extensions/ipfs-404.html'),
        transactions: resolve(__dirname, 'transactions/index.html'),
      },
      plugins: [nodePolyfills()],
      external: ['@safe-global/safe-apps-sdk', '@safe-globalThis/safe-apps-sdk', '@safe-globalThis/safe-apps-provider'],
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
    esbuildOptions: {
      target: 'esnext',
      // Node.js global to browser globalThis
      define: {
        global: 'globalThis',
      },
      // Enable esbuild polyfill plugins
      plugins: [
        NodeGlobalsPolyfillPlugin({
          buffer: true,
        }),
      ],
      supported: {
        bigint: true,
      },
    },
  },
});

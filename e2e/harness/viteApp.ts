// Runs the app with Vite's JavaScript API, with a configuration the harness controls entirely.
//
// - `envDir` is an empty directory, so no `.env*` file in the repository changes a run.
// - Every `VITE_*` variable in the runner's environment is removed first, and only the harness's are set.
// - NODE_ENV is set for each lifecycle. Vite keeps an existing NODE_ENV and derives `import.meta.env.DEV`
//   from it, so a production build in a process where the dev server set NODE_ENV=development compiles
//   DEV=true, which turns on the dev-only screening bypass (`SCREENING_DISABLED` in `envVars.ts`). Each
//   production build sets NODE_ENV=production and refuses to continue unless the resolved configuration has
//   DEV=false and PROD=true.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { build, createServer, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';

import { devMinificationOf, minifyDev } from './devMinification';
import { REPO_ROOT } from './paths';

export { REPO_ROOT };
const CONFIG_FILE = path.join(REPO_ROOT, 'vite.config.js');

export type AppEnvironment = Record<`VITE_${string}`, string>;

/** What a production build resolved to: its mode, and the booleans that decide the screening bypass. */
export type ResolvedBuild = { mode: string; isProduction: boolean; DEV: boolean; PROD: boolean };

/** Removes every `VITE_*` variable from the runner's environment, and returns their names (never their values). */
export function removeViteVariables(): string[] {
  const names = Object.keys(process.env).filter((name) => name.startsWith('VITE_'));
  for (const name of names) delete process.env[name];
  return names.sort();
}

/**
 * Runs `run` with NODE_ENV and exactly the `VITE_*` variables in `environment`, then restores NODE_ENV and
 * removes the variables again.
 */
async function withEnvironment<T>(nodeEnv: 'production', environment: AppEnvironment, run: () => Promise<T>) {
  const savedNodeEnv = process.env.NODE_ENV;
  removeViteVariables();
  process.env.NODE_ENV = nodeEnv;
  Object.assign(process.env, environment);
  try {
    return await run();
  } finally {
    removeViteVariables();
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  }
}

function recorder(onResolved: (config: ResolvedConfig) => void): Plugin {
  return { name: 'cf-harness-record-config', configResolved: onResolved };
}

/** Throws unless `resolved` is a production configuration: DEV=false and PROD=true. */
export function assertProduction(resolved: ResolvedBuild | undefined): ResolvedBuild {
  if (resolved === undefined) throw new Error('The production build resolved no configuration.');
  if (resolved.DEV !== false || resolved.PROD !== true || !resolved.isProduction) {
    throw new Error(
      `The production build resolved DEV=${resolved.DEV}, PROD=${resolved.PROD}, isProduction=${resolved.isProduction}. ` +
        'It would compile the dev-only screening bypass, so the harness refuses to serve it.'
    );
  }
  return resolved;
}

/**
 * Builds the app for production into `outDir`, with only `environment`'s `VITE_*` variables, and returns
 * what the build resolved. It refuses a build that resolved DEV=true.
 */
export async function buildProduction({
  outDir,
  envDir,
  environment,
}: {
  outDir: string;
  envDir: string;
  environment: AppEnvironment;
}): Promise<ResolvedBuild> {
  let resolved: ResolvedBuild | undefined;
  await withEnvironment('production', environment, () =>
    build({
      configFile: CONFIG_FILE,
      root: REPO_ROOT,
      envDir,
      mode: 'production',
      logLevel: 'warn',
      clearScreen: false,
      build: { outDir, emptyOutDir: true },
      plugins: [
        recorder((config) => {
          resolved = {
            mode: config.mode,
            isProduction: config.isProduction,
            DEV: Boolean(config.env.DEV),
            PROD: Boolean(config.env.PROD),
          };
          // Stop before any output is written if the configuration is not a production one.
          assertProduction(resolved);
        }),
      ],
    })
  );
  return assertProduction(resolved);
}

export type Served = { origin: string; close: () => Promise<void> };

/** Listens on 127.0.0.1 at a port the system chooses, and refuses to go on if the bound address is another. */
function listenOnLoopback(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
        server.close();
        reject(new Error('The app server is not bound to 127.0.0.1.'));
      } else resolve(address.port);
    });
  });
}

const closed = (server: http.Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/**
 * Serves a production build from `outDir` on 127.0.0.1, as a static host such as IPFS does: GET and HEAD
 * only, files inside `outDir` only, and `index.html` for any path that names no file.
 */
export async function serveProduction({ outDir }: { outDir: string }): Promise<Served> {
  const root = fs.realpathSync(outDir);
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405);
      return response.end();
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400);
      return response.end();
    }
    let file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      response.writeHead(403);
      return response.end();
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const index = path.join(file, 'index.html');
      file = fs.existsSync(index) ? index : path.join(root, 'index.html');
    }
    response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(file).pipe(response);
  });
  const port = await listenOnLoopback(server);
  return { origin: `http://127.0.0.1:${port}`, close: () => closed(server) };
}

/**
 * Whether BROWSER_TEST_BUNDLED_DEV selects Vite's experimental bundled dev mode (`experimental.bundledDev`):
 * unset, empty or `0` for the default unbundled dev server, `1` for bundled.
 * Bundled dev serves Rolldown chunks from memory. A fresh browser context loads those chunks instead of individual modules.
 */
export function devBundledOf(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.BROWSER_TEST_BUNDLED_DEV;
  if (value === undefined || value === '' || value === '0') return false;
  if (value !== '1') throw new Error('BROWSER_TEST_BUNDLED_DEV must be 0 or 1.');
  return true;
}

/**
 * What BROWSER_TEST_BUNDLED_DEV=1 adds to the dev server's configuration.
 * `strictExecutionOrder` preserves module order across Rolldown chunks.
 * Shared chunks otherwise precede the entry's React Refresh preamble.
 * React modules then throw "@vitejs/plugin-react can't detect preamble" (vitejs/vite-plugin-react#1191).
 * It sits under `rollupOptions`, the key `vite.config.js` uses, so Vite merges it with the configuration's
 * inputs and plugins instead of replacing them.
 */
export const BUNDLED_DEV_CONFIG = {
  experimental: { bundledDev: true },
  build: { rollupOptions: { output: { strictExecutionOrder: true } } },
} as const;

/** Whether `url`, a request's URL, asks for a file by its file system path under Vite's `/@fs/` prefix. */
export function isRawFsRequest(url: string | undefined): boolean {
  const pathname = (url ?? '').split(/[?#]/)[0];
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is checked as sent.
  }
  return [pathname, decoded].some((each) => each === '/@fs' || each.startsWith('/@fs/'));
}

/**
 * Answers 403 to every `/@fs/` request, before Vite's own middleware sees it. The unbundled dev server
 * serves `/@fs/` itself and refuses a file outside the repository with 403. Bundled dev serves no `/@fs/`
 * path and answers it with the app's HTML and status 200 instead, which holds no file but reads as served.
 * The harness adds this plugin to bundled dev only. A page receives the unbundled server's refusal, with no file outside the repository.
 */
export function denyRawFs(): Plugin {
  return {
    name: 'cf-harness-deny-raw-fs',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!isRawFsRequest(request.url)) return next();
        response.statusCode = 403;
        response.end();
      });
    },
  };
}

/**
 * Starts the dev server on 127.0.0.1 with NODE_ENV=development and exactly `environment`'s `VITE_*`
 * variables. They stay set in the runner for the server's life, because Vite reads NODE_ENV again when it
 * first optimizes dependencies. So the dev server starts after every production build. Vite runs in
 * middleware mode on a server the harness binds itself, because Vite reads port 0 as its default port.
 */
export async function startDevServer({
  envDir,
  environment,
  plugins = [],
  sourceMapsFile,
}: {
  envDir: string;
  environment: AppEnvironment;
  /** Plugins for the dev server only, such as `openWrappedReleaseControls`. */
  plugins?: Plugin[];
  /** A private build-time archive, copied to test artifacts only after a failure. */
  sourceMapsFile?: string;
}): Promise<Served & { server: ViteDevServer; hmrOrigin: string; DEV: boolean; bundled: boolean }> {
  const bundled = devBundledOf();
  const minified = devMinificationOf();
  if (minified && sourceMapsFile === undefined) throw new Error('Minified dev requires a private source map archive.');
  if (bundled) console.log('Browser harness: experimental bundled dev mode, by BROWSER_TEST_BUNDLED_DEV.');
  removeViteVariables();
  process.env.NODE_ENV = 'development';
  Object.assign(process.env, environment);
  const httpServer = http.createServer();
  // Playwright reuses idle sockets. Keep them open until cleanup to avoid idle-close resets during a page reload.
  httpServer.keepAliveTimeout = 0;
  const port = await listenOnLoopback(httpServer);
  let DEV = false;
  const server = await createServer({
    configFile: CONFIG_FILE,
    root: REPO_ROOT,
    envDir,
    mode: 'development',
    logLevel: 'warn',
    clearScreen: false,
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
      host: '127.0.0.1',
      // Vite 8 turns this on when it detects a coding agent, and then logs the page's console errors and
      // warnings in the runner as well. Vite 7 never did, and the browser fixtures and traces record them.
      forwardConsole: false,
    },
    ...(bundled ? BUNDLED_DEV_CONFIG : {}),
    plugins: [
      recorder((config) => (DEV = Boolean(config.env.DEV))),
      ...(bundled ? [denyRawFs()] : []),
      ...(minified ? [minifyDev(sourceMapsFile as string)] : []),
      ...plugins,
    ],
  });
  httpServer.on('request', server.middlewares);
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    hmrOrigin: `ws://127.0.0.1:${port}`,
    DEV,
    bundled,
    close: async () => {
      await server.close();
      await closed(httpServer);
    },
  };
}

/** Makes an empty directory for `envDir`, so Vite reads no `.env*` file. */
export function emptyEnvDir(parent: string): string {
  const directory = path.join(parent, 'empty-env-dir');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

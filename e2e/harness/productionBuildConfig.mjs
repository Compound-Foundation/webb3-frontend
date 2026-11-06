// The production build's Vite settings and checks, for the build worker thread (`productionBuildWorker.mjs`).
// `buildProduction` in `viteApp.ts` passes the same settings in the runner's own thread. A Jest test
// (`__tests__/productionBuilds.test.ts`) compares the two, so a change to one without the other fails it.
// This file is plain JavaScript because the worker thread runs in Node without the TypeScript loaders of
// Playwright and Jest.

/** Returns what a production build resolved: its mode, and the booleans that decide the screening bypass. */
export function resolvedBuildOf(config) {
  return {
    mode: config.mode,
    isProduction: config.isProduction,
    DEV: Boolean(config.env.DEV),
    PROD: Boolean(config.env.PROD),
  };
}

/** Throws unless `resolved` is a production configuration: DEV=false and PROD=true. It mirrors `assertProduction`. */
export function assertProductionBuild(resolved) {
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
 * Throws unless `env` holds NODE_ENV=production and exactly the `VITE_*` variables of `environment`, with the
 * same values. Vite keeps an existing NODE_ENV and reads every `VITE_*` variable of the process, so any other
 * value would change what the build compiles.
 */
export function assertBuildEnvironment(env, environment) {
  if (env.NODE_ENV !== 'production') throw new Error('The production build worker does not have NODE_ENV=production.');
  const names = Object.keys(env)
    .filter((name) => name.startsWith('VITE_'))
    .sort();
  const expectedNames = Object.keys(environment).sort();
  const isExact =
    names.length === expectedNames.length &&
    names.every((name, i) => name === expectedNames[i] && env[name] === environment[name]);
  if (!isExact) {
    throw new Error(
      `The production build worker has the VITE_* variables [${names.join(', ')}], ` +
        `not exactly the given [${expectedNames.join(', ')}].`
    );
  }
}

/**
 * Returns the inline configuration of one production build. Its recorder plugin passes the resolved
 * configuration to `onResolved`, which can throw to stop the build before any output is written.
 */
export function productionInlineConfig({ configFile, root, envDir, outDir, onResolved }) {
  return {
    configFile,
    root,
    envDir,
    mode: 'production',
    logLevel: 'warn',
    clearScreen: false,
    build: { outDir, emptyOutDir: true },
    plugins: [{ name: 'cf-harness-record-config', configResolved: (config) => onResolved(resolvedBuildOf(config)) }],
  };
}

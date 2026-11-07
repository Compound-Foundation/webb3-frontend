// Runs one production build in a worker thread and posts what it resolved to the runner (`productionBuilds.ts`).
// The runner starts the worker with its own copy of the environment: NODE_ENV=production and exactly the build's
// `VITE_*` variables. The worker's changes to `process.env` stay in the worker, so builds in other workers and
// the runner's own environment are unchanged. An error ends the worker, and the runner reports it.
import { parentPort, workerData } from 'node:worker_threads';

import { build } from 'vite';

import { assertBuildEnvironment, assertProductionBuild, productionInlineConfig } from './productionBuildConfig.mjs';

const { configFile, root, envDir, outDir, environment } = workerData;
assertBuildEnvironment(process.env, environment);

let resolved;
await build(
  productionInlineConfig({
    configFile,
    root,
    envDir,
    outDir,
    // Stops before any output is written if the configuration is not a production one.
    onResolved: (each) => {
      resolved = assertProductionBuild(each);
    },
  })
);
parentPort.postMessage({ resolved: assertProductionBuild(resolved) });

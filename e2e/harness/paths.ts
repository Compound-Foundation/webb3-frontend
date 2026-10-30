// Where the harness and its outputs live.
import path from 'node:path';

/** The repository root. Playwright and Jest both run from it. */
export const REPO_ROOT = process.cwd();
/** Each run writes its manifest, logs, summary and Playwright output under `<RUNS_DIR>/<run ID>`. */
export const RUNS_DIR = path.join(REPO_ROOT, 'test-results/browser-fork');

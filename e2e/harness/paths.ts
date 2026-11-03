// Where the harness and its outputs live.
import os from 'node:os';
import path from 'node:path';

/** The repository root. Playwright and Jest both run from it. */
export const REPO_ROOT = process.cwd();
/** Each run writes its manifest, logs, summary and Playwright output under `<RUNS_DIR>/<run ID>`. */
export const RUNS_DIR = path.join(REPO_ROOT, 'test-results/browser-fork');

/** A path under the home directory as `~/...`, so that a record of the run does not show the user name. */
export const homeRelative = (directory: string) => {
  const home = os.homedir();
  return directory === home || directory.startsWith(`${home}${path.sep}`)
    ? `~${directory.slice(home.length)}`
    : directory;
};

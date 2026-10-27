// The record of each run's processes, which lets a later run stop an anvil whose runner was killed with
// SIGKILL and so could not stop it itself.
import { execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RUNS_DIR } from './paths';

/** The process record that lets a later run stop an anvil whose runner was killed. */
export type ProcessRecord = {
  runnerPid: number;
  anvilPid?: number;
  upstreamProxyPort?: number;
  /** anvil's empty working directory, which anvil's own exit removes only when the runner lives on. */
  anvilCwd?: string;
  privateDir: string;
};

/** Whether `directory` is one the harness made under the system's temporary directory, with `prefix`. */
const isHarnessDirectory = (directory: string | undefined, prefix: string): directory is string =>
  directory !== undefined &&
  path.dirname(directory) === os.tmpdir().replace(/\/$/, '') &&
  path.basename(directory).startsWith(prefix);

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether `command`, a process's command line, is the anvil that `record` started: anvil forked from that
 * run's own upstream proxy port. Only such a process is stopped, so another session's anvil never is.
 */
export const isRecordedAnvil = (command: string, record: ProcessRecord) =>
  record.upstreamProxyPort !== undefined &&
  /(^|\/)anvil\s/.test(command) &&
  command.includes(`--fork-url http://127.0.0.1:${record.upstreamProxyPort}/`);

/**
 * Stops the anvil and removes the private directory of each earlier run whose runner is gone, as after the
 * runner was killed with SIGKILL. Returns what it did, for the log.
 */
export function recoverKilledRuns(runsDir = RUNS_DIR): string[] {
  const done: string[] = [];
  if (!fs.existsSync(runsDir)) return done;
  for (const run of fs.readdirSync(runsDir)) {
    const file = path.join(runsDir, run, 'processes.json');
    if (!fs.existsSync(file)) continue;
    let record: ProcessRecord;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (isAlive(record.runnerPid)) continue;
    // A live process at the recorded PID that is not the recorded anvil keeps the record, so a person can
    // still check it by hand.
    let keepRecord = false;
    if (record.anvilPid !== undefined && isAlive(record.anvilPid)) {
      let command = '';
      try {
        command = execFileSync('ps', ['-p', String(record.anvilPid), '-o', 'command='], { encoding: 'utf8' }).trim();
      } catch {
        command = '';
      }
      if (isRecordedAnvil(command, record)) {
        process.kill(record.anvilPid, 'SIGKILL');
        done.push(`stopped anvil ${record.anvilPid} of run ${run}`);
      } else {
        keepRecord = true;
      }
    }
    if (isHarnessDirectory(record.privateDir, 'cf-browser-wallet-') && fs.existsSync(record.privateDir)) {
      fs.rmSync(record.privateDir, { recursive: true, force: true });
      done.push(`removed the private directory of run ${run}`);
    }
    if (!keepRecord && isHarnessDirectory(record.anvilCwd, 'cf-browser-anvil-') && fs.existsSync(record.anvilCwd)) {
      fs.rmSync(record.anvilCwd, { recursive: true, force: true });
      done.push(`removed anvil's working directory of run ${run}`);
    }
    if (!keepRecord) fs.rmSync(file);
  }
  return done;
}

/**
 * The exit handler's synchronous last resort, as when SIGINT ends the runner during start-up, before the
 * global setup has returned its teardown: kills anvil through its handle, so a reused PID is never
 * signalled, and removes anvil's working directory and the private directory. An asynchronous stop cannot
 * run once the process is exiting.
 */
export function cleanUpSynchronously({
  anvil,
  anvilCwd,
  privateDir,
}: {
  anvil: ChildProcess | undefined;
  anvilCwd: string | undefined;
  privateDir: string | undefined;
}): void {
  if (anvil !== undefined && anvil.exitCode === null && anvil.signalCode === null) anvil.kill('SIGKILL');
  for (const directory of [anvilCwd, privateDir]) {
    if (directory !== undefined) fs.rmSync(directory, { recursive: true, force: true });
  }
}

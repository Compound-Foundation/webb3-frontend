// The record of each run's processes, which lets a later run stop the anvils whose runner was killed with
// SIGKILL and so could not stop them itself. A run has one anvil per fork lane.
import { execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RUNS_DIR } from './paths';

/** One anvil of a run: its PID, and its empty working directory, which its own exit removes only when the runner lives on. */
export type RecordedAnvil = { pid?: number; cwd?: string };

/** The process record that lets a later run stop the anvils whose runner was killed. */
export type ProcessRecord = {
  runnerPid: number;
  /** Every lane's anvil that the run started, restarted lanes included. */
  anvils?: RecordedAnvil[];
  /** A record written before fork lanes, with its one anvil. */
  anvilPid?: number;
  anvilCwd?: string;
  upstreamProxyPort?: number;
  privateDir: string;
};

/** The anvils `record` names: its list, or the one anvil of a record from before fork lanes. */
const recordedAnvils = (record: ProcessRecord): RecordedAnvil[] =>
  record.anvils ??
  (record.anvilPid === undefined && record.anvilCwd === undefined
    ? []
    : [{ pid: record.anvilPid, cwd: record.anvilCwd }]);

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
 * The working directory of the process `pid`, as `lsof` reads it, or undefined when it cannot be read.
 */
function processCwd(pid: number): string | undefined {
  // Linux names a removed directory with a ` (deleted)` suffix; lsof gives its last path.
  if (fs.existsSync(`/proc/${pid}/cwd`)) {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, '');
    } catch {
      return undefined;
    }
  }
  try {
    const output = execFileSync('lsof', ['-b', '-w', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
    });
    return output
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1);
  } catch {
    return undefined;
  }
}

/**
 * Whether the process `pid` still runs in the recorded anvil working directory `recordedCwd`, or none was
 * recorded. Every cached run and lane forks from the same proxy URL, so only the directory, which is new for
 * each anvil, tells two cached anvils apart. A directory that cannot be read does not match.
 */
const runsInRecordedCwd = (pid: number, recordedCwd: string | undefined) => {
  if (recordedCwd === undefined) return true;
  const cwd = processCwd(pid);
  if (cwd === undefined) return false;
  // The parent is resolved, not the directory, which the run's anvil may outlive: its `mkdtemp` name is new for
  // each anvil, so the match stays unique.
  let recorded = recordedCwd;
  try {
    recorded = path.join(fs.realpathSync(path.dirname(recorded)), path.basename(recorded));
  } catch {
    return false;
  }
  return cwd === recorded || cwd === recordedCwd;
};

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
    // A live process at a recorded PID that is not the recorded anvil keeps the record, so a person can
    // still check it by hand.
    let shouldKeepRecord = false;
    const anvils = recordedAnvils(record);
    for (const anvil of anvils) {
      if (anvil.pid === undefined || !isAlive(anvil.pid)) continue;
      let command = '';
      try {
        command = execFileSync('ps', ['-p', String(anvil.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
      } catch {
        command = '';
      }
      if (isRecordedAnvil(command, record) && runsInRecordedCwd(anvil.pid, anvil.cwd)) {
        process.kill(anvil.pid, 'SIGKILL');
        done.push(`stopped anvil ${anvil.pid} of run ${run}`);
      } else {
        shouldKeepRecord = true;
      }
    }
    if (isHarnessDirectory(record.privateDir, 'cf-browser-wallet-') && fs.existsSync(record.privateDir)) {
      fs.rmSync(record.privateDir, { recursive: true, force: true });
      done.push(`removed the private directory of run ${run}`);
    }
    if (!shouldKeepRecord) {
      for (const anvil of anvils) {
        if (isHarnessDirectory(anvil.cwd, 'cf-browser-anvil-') && fs.existsSync(anvil.cwd)) {
          fs.rmSync(anvil.cwd, { recursive: true, force: true });
          done.push(`removed anvil's working directory of run ${run}`);
        }
      }
    }
    if (!shouldKeepRecord) fs.rmSync(file);
  }
  return done;
}

/**
 * The exit handler's synchronous last resort, as when SIGINT ends the runner during start-up, before the
 * global setup has returned its teardown: kills each lane's anvil through its handle, so a reused PID is never
 * signalled, and removes the anvils' working directories and the private directory. An asynchronous stop
 * cannot run once the process is exiting.
 */
export function cleanUpSynchronously({
  anvils,
  privateDir,
}: {
  anvils: { child: ChildProcess; cwd?: string }[];
  privateDir: string | undefined;
}): void {
  for (const { child } of anvils) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const directory of [...anvils.map((anvil) => anvil.cwd), privateDir]) {
    if (directory !== undefined) fs.rmSync(directory, { recursive: true, force: true });
  }
}

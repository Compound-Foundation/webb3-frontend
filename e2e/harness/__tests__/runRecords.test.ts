/**
 * @jest-environment node
 */
// The recovery after a runner killed with SIGKILL: it stops that run's own anvil only, never another
// session's, and removes the run's private directory.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isAlive, isRecordedAnvil, recoverKilledRuns } from '../runRecords';

const deadPid = () => spawnSync('true').pid as number;

test('matches only the anvil forked from the recorded upstream proxy port', () => {
  const record = { runnerPid: 1, upstreamProxyPort: 51234, privateDir: '/tmp/x' };
  expect(isRecordedAnvil('/Users/me/.foundry/bin/anvil --fork-url http://127.0.0.1:51234/ --port 0', record)).toBe(
    true
  );
  expect(isRecordedAnvil('anvil --fork-url http://127.0.0.1:51235/ --port 0', record)).toBe(false);
  expect(isRecordedAnvil('node anvil-like --fork-url http://127.0.0.1:51234/', record)).toBe(false);
  expect(isRecordedAnvil('anvil --fork-url http://127.0.0.1:51234/', { ...record, upstreamProxyPort: undefined })).toBe(
    false
  );
});

test("stops a dead runner's anvil and removes its private directory, and leaves a live runner's run alone", async () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-runs-'));
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-tools-'));
  const fakeAnvil = path.join(tools, 'anvil');
  fs.writeFileSync(fakeAnvil, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  const orphan = spawn(fakeAnvil, ['--fork-url', 'http://127.0.0.1:40001/'], { stdio: 'ignore' });
  const other = spawn(fakeAnvil, ['--fork-url', 'http://127.0.0.1:40002/'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-wallet-'));
  const write = (run: string, record: object) => {
    fs.mkdirSync(path.join(runs, run));
    fs.writeFileSync(path.join(runs, run, 'processes.json'), JSON.stringify(record));
  };
  write('killed', { runnerPid: deadPid(), anvilPid: orphan.pid, upstreamProxyPort: 40001, privateDir });
  // A live runner (this process), whose anvil must not be touched.
  write('live', { runnerPid: process.pid, anvilPid: other.pid, upstreamProxyPort: 40002, privateDir: '/tmp/none' });
  // A dead runner whose recorded pid now belongs to another program.
  write('reused', { runnerPid: deadPid(), anvilPid: other.pid, upstreamProxyPort: 40009, privateDir: '/tmp/none' });
  const done = recoverKilledRuns(runs);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(done).toEqual([`stopped anvil ${orphan.pid} of run killed`, 'removed the private directory of run killed']);
  expect(isAlive(orphan.pid as number)).toBe(false);
  expect(isAlive(other.pid as number)).toBe(true);
  expect(fs.existsSync(privateDir)).toBe(false);
  expect(fs.existsSync(path.join(runs, 'live', 'processes.json'))).toBe(true);
  expect(fs.existsSync(path.join(runs, 'killed', 'processes.json'))).toBe(false);
  // The record whose PID now belongs to another program stays, for a person to check.
  expect(fs.existsSync(path.join(runs, 'reused', 'processes.json'))).toBe(true);
  other.kill('SIGKILL');
  fs.rmSync(runs, { recursive: true, force: true });
  fs.rmSync(tools, { recursive: true, force: true });
});

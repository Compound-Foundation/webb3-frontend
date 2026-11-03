/**
 * @jest-environment node
 */
// The recovery after a runner killed with SIGKILL: it stops that run's own anvil only, never another
// session's, and removes the run's private directory.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRedactor, startFork, type Fork } from '../fork';
import { cleanUpSynchronously, isAlive, isRecordedAnvil, recoverKilledRuns } from '../runRecords';

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

test('the synchronous fallback after a start-up SIGINT stops anvil and removes its working directory and the private directory', async () => {
  // A stand-in for anvil that prints anvil's ready line and then waits, as anvil does.
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-tools-'));
  const fakeAnvil = path.join(tools, 'anvil');
  fs.writeFileSync(fakeAnvil, '#!/bin/sh\necho "Listening on 127.0.0.1:45678"\nexec sleep 60\n', { mode: 0o755 });
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-wallet-'));
  let anvilCwd: string | undefined;
  let fork: Fork | undefined;
  try {
    fork = await startFork({
      anvil: fakeAnvil,
      upstreamUrl: 'http://127.0.0.1:1/',
      target: { number: 1, hash: `0x${'00'.repeat(32)}`, timestamp: 0, mode: 'pinned' },
      log: () => undefined,
      redactor: createRedactor([]),
      onChild: (_, directory) => (anvilCwd = directory),
    });
    expect(anvilCwd).toMatch(/cf-browser-anvil-/);
    expect(fs.existsSync(anvilCwd as string)).toBe(true);
    // What the exit handler runs when SIGINT ends the runner before global setup returns its teardown.
    cleanUpSynchronously({ anvils: [{ child: fork.child, cwd: anvilCwd }], privateDir });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(fork.pid)).toBe(false);
    expect(fs.existsSync(anvilCwd as string)).toBe(false);
    expect(fs.existsSync(privateDir)).toBe(false);
  } finally {
    fork?.child.kill('SIGKILL');
    for (const directory of [tools, privateDir, anvilCwd]) {
      if (directory !== undefined) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("recovery removes a killed run's anvil working directory, and only one the harness made", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-runs-'));
  const anvilCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-anvil-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-unrelated-'));
  for (const [run, cwd] of [
    ['killed', anvilCwd],
    ['forged', elsewhere],
  ]) {
    fs.mkdirSync(path.join(runs, run));
    fs.writeFileSync(
      path.join(runs, run, 'processes.json'),
      JSON.stringify({ runnerPid: deadPid(), privateDir: '/tmp/none', anvilCwd: cwd })
    );
  }
  try {
    const done = recoverKilledRuns(runs);
    expect(done).toEqual(["removed anvil's working directory of run killed"]);
    expect(fs.existsSync(anvilCwd)).toBe(false);
    expect(fs.existsSync(elsewhere)).toBe(true);
  } finally {
    for (const directory of [anvilCwd, elsewhere, runs]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("recovery stops a cached run's anvil only when it still runs in the recorded working directory", async () => {
  // Every cached run forks from the same fixed proxy URL, so the command line alone cannot tell two cached
  // runs' anvils apart.
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-runs-'));
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-tools-'));
  const fakeAnvil = path.join(tools, 'anvil');
  fs.writeFileSync(fakeAnvil, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  const killedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-anvil-'));
  const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-anvil-'));
  const forkArgs = ['--fork-url', 'http://127.0.0.1:18546/'];
  const orphan = spawn(fakeAnvil, forkArgs, { stdio: 'ignore', cwd: killedCwd });
  const other = spawn(fakeAnvil, forkArgs, { stdio: 'ignore', cwd: otherCwd });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const write = (run: string, record: object) => {
    fs.mkdirSync(path.join(runs, run));
    fs.writeFileSync(path.join(runs, run, 'processes.json'), JSON.stringify(record));
  };
  const base = { runnerPid: deadPid(), upstreamProxyPort: 18546, privateDir: '/tmp/none' };
  write('killed', { ...base, anvilPid: orphan.pid, anvilCwd: killedCwd });
  // A dead run whose recorded PID now belongs to another session's cached anvil, in another directory.
  write('reused', { ...base, anvilPid: other.pid, anvilCwd: path.join(os.tmpdir(), 'cf-browser-anvil-gone') });
  const done = recoverKilledRuns(runs);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(done).toContain(`stopped anvil ${orphan.pid} of run killed`);
  expect(isAlive(orphan.pid as number)).toBe(false);
  expect(isAlive(other.pid as number)).toBe(true);
  expect(fs.existsSync(path.join(runs, 'reused', 'processes.json'))).toBe(true);
  other.kill('SIGKILL');
  for (const directory of [runs, tools, killedCwd, otherCwd]) fs.rmSync(directory, { recursive: true, force: true });
});

test('recovery stops an orphan whose working directory was removed, and not an anvil in another directory', async () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-runs-'));
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-tools-'));
  const fakeAnvil = path.join(tools, 'anvil');
  fs.writeFileSync(fakeAnvil, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  const removedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-anvil-'));
  const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-anvil-'));
  const recordedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-anvil-'));
  const forkArgs = ['--fork-url', 'http://127.0.0.1:18546/'];
  const orphan = spawn(fakeAnvil, forkArgs, { stdio: 'ignore', cwd: removedCwd });
  const other = spawn(fakeAnvil, forkArgs, { stdio: 'ignore', cwd: otherCwd });
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(removedCwd, { recursive: true, force: true });
  const write = (run: string, record: object) => {
    fs.mkdirSync(path.join(runs, run));
    fs.writeFileSync(path.join(runs, run, 'processes.json'), JSON.stringify(record));
  };
  const base = { runnerPid: deadPid(), upstreamProxyPort: 18546, privateDir: '/tmp/none' };
  write('removed', { ...base, anvilPid: orphan.pid, anvilCwd: removedCwd });
  // Another session's cached anvil, in a directory that exists but is not the recorded one.
  write('other', { ...base, anvilPid: other.pid, anvilCwd: recordedCwd });
  const done = recoverKilledRuns(runs);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(done).toContain(`stopped anvil ${orphan.pid} of run removed`);
  expect(isAlive(orphan.pid as number)).toBe(false);
  expect(isAlive(other.pid as number)).toBe(true);
  other.kill('SIGKILL');
  for (const directory of [runs, tools, otherCwd, recordedCwd]) fs.rmSync(directory, { recursive: true, force: true });
});

test('recovery stops every lane anvil of a killed run, each in its own recorded directory, and removes those directories', async () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-runs-'));
  const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-tools-'));
  const fakeAnvil = path.join(tools, 'anvil');
  fs.writeFileSync(fakeAnvil, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  const cwds = [0, 1, 2].map(() => fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-anvil-')));
  const forkArgs = ['--fork-url', 'http://127.0.0.1:18546/'];
  const [laneZero, laneOne, live] = cwds.map((cwd) => spawn(fakeAnvil, forkArgs, { stdio: 'ignore', cwd }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const write = (run: string, record: object) => {
    fs.mkdirSync(path.join(runs, run));
    fs.writeFileSync(path.join(runs, run, 'processes.json'), JSON.stringify(record));
  };
  const base = { upstreamProxyPort: 18546, privateDir: '/tmp/none' };
  write('killed', {
    ...base,
    runnerPid: deadPid(),
    anvils: [
      { pid: laneZero.pid, cwd: cwds[0] },
      { pid: laneOne.pid, cwd: cwds[1] },
    ],
  });
  write('live', { ...base, runnerPid: process.pid, anvils: [{ pid: live.pid, cwd: cwds[2] }] });
  try {
    const done = recoverKilledRuns(runs);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toEqual([
      `stopped anvil ${laneZero.pid} of run killed`,
      `stopped anvil ${laneOne.pid} of run killed`,
      "removed anvil's working directory of run killed",
      "removed anvil's working directory of run killed",
    ]);
    expect(isAlive(laneZero.pid as number)).toBe(false);
    expect(isAlive(laneOne.pid as number)).toBe(false);
    expect(isAlive(live.pid as number)).toBe(true);
    expect(cwds.map((cwd) => fs.existsSync(cwd))).toEqual([false, false, true]);
    expect(fs.existsSync(path.join(runs, 'killed', 'processes.json'))).toBe(false);
  } finally {
    for (const child of [laneZero, laneOne, live]) child.kill('SIGKILL');
    for (const directory of [runs, tools, ...cwds]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the synchronous fallback stops every lane anvil it was given, and skips one that has exited', () => {
  const running = spawn('sleep', ['60'], { stdio: 'ignore' });
  const exited = spawn('true', [], { stdio: 'ignore' });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-anvil-'));
  return new Promise<void>((resolve) => exited.once('exit', () => resolve())).then(async () => {
    cleanUpSynchronously({ anvils: [{ child: exited }, { child: running, cwd }], privateDir: undefined });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(running.pid as number)).toBe(false);
    expect(fs.existsSync(cwd)).toBe(false);
  });
});

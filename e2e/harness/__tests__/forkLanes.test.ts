/**
 * @jest-environment node
 */
// The pool of fork lanes: one per Playwright worker, started when the worker first leases it, kept for the
// worker that replaces it, restarted when its anvil has exited, and stopped together at teardown.
import http from 'node:http';

import { server as mswServer } from '../../../handlers/server';
import type { LaneCache } from '../fork';
import { createLanePool, startLaneServer, type LaneInfo, type StartedLane } from '../forkLanes';

beforeAll(() => mswServer.close());

const TOKEN = 'a'.repeat(64);

/** A stand-in lane, with a flag for whether its anvil is still running, that records its stop. */
function fakeLanes() {
  const started: { index: number; generation: number; isAlive: boolean; isStopped: boolean }[] = [];
  let failures = 0;
  const startLane = async (index: number, generation: number): Promise<StartedLane> => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (failures > 0) {
      failures -= 1;
      throw new Error(`lane ${index} failed to start`);
    }
    const record = { index, generation, isAlive: true, isStopped: false };
    started.push(record);
    const info: LaneInfo = {
      index,
      generation,
      forkUrl: `http://127.0.0.1:${9000 + index * 10 + generation}`,
      anvilPid: 1000 + index * 10 + generation,
      walletUrl: `http://127.0.0.1:${8000 + index * 10 + generation}`,
      cache: 'warm',
    };
    return {
      info,
      isAlive: () => record.isAlive,
      stop: async (): Promise<LaneCache> => {
        record.isStopped = true;
        record.isAlive = false;
        return {
          lane: index,
          runHome: `/private/anvil-home-${index}-${generation}`,
          methods: [],
          hasExitedCleanly: true,
          anvilVersion: 'anvil Version: 1.9.0',
          isProxyListening: true,
        };
      },
    };
  };
  return { started, startLane, failNext: (count = 1) => (failures = count) };
}

describe('the lane pool', () => {
  test('starts a lane once, on its first lease, however many leases wait on it', async () => {
    const lanes = fakeLanes();
    const pool = createLanePool({ count: 3, startLane: lanes.startLane });
    const [first, second] = await Promise.all([pool.lease(1), pool.lease(1)]);
    expect(first).toEqual(second);
    expect(lanes.started.map(({ index, generation }) => [index, generation])).toEqual([[1, 0]]);
    expect(pool.forkUrlOf(1)).toBe(first.forkUrl);
    expect(pool.forkUrlOf(0)).toBeUndefined();
    expect(pool.started().map((each) => each.index)).toEqual([1]);
  });

  test('gives each worker index its own lane, and refuses an index outside the pool', async () => {
    const lanes = fakeLanes();
    const pool = createLanePool({ count: 2, startLane: lanes.startLane });
    const [zero, one] = await Promise.all([pool.lease(0), pool.lease(1)]);
    expect(new Set([zero.forkUrl, one.forkUrl, zero.walletUrl, one.walletUrl]).size).toBe(4);
    await expect(pool.lease(2)).rejects.toThrow('no lane 2: the pool has 2');
    await expect(pool.lease(-1)).rejects.toThrow('no lane -1');
    await expect(pool.lease(0.5)).rejects.toThrow('no lane 0.5');
  });

  test('a worker that replaces another leases the same lane, still running', async () => {
    const lanes = fakeLanes();
    const pool = createLanePool({ count: 2, startLane: lanes.startLane });
    const before = await pool.lease(0);
    expect(await pool.lease(0)).toEqual(before);
    expect(lanes.started).toHaveLength(1);
  });

  test("restarts a lane whose anvil has exited, after stopping it, and keeps the stopped lane's cache for the promotion", async () => {
    const lanes = fakeLanes();
    const pool = createLanePool({ count: 1, startLane: lanes.startLane });
    const before = await pool.lease(0);
    lanes.started[0].isAlive = false;
    const after = await pool.lease(0);
    expect(after.generation).toBe(1);
    expect(after.forkUrl).not.toBe(before.forkUrl);
    expect(lanes.started[0].isStopped).toBe(true);
    expect(pool.forkUrlOf(0)).toBe(after.forkUrl);
    const caches = await pool.stop();
    expect(caches.map((each) => each.runHome)).toEqual(['/private/anvil-home-0-0', '/private/anvil-home-0-1']);
  });

  test('a lane that failed to start is started again by the next lease', async () => {
    const lanes = fakeLanes();
    const pool = createLanePool({ count: 1, startLane: lanes.startLane });
    lanes.failNext();
    await expect(pool.lease(0)).rejects.toThrow('lane 0 failed to start');
    expect(pool.forkUrlOf(0)).toBeUndefined();
    expect((await pool.lease(0)).generation).toBe(0);
  });

  test('stops every lane, one that was still starting included, returns their caches in lane order, and then refuses leases', async () => {
    const lanes = fakeLanes();
    const pool = createLanePool({ count: 3, startLane: lanes.startLane });
    await pool.lease(2);
    await pool.lease(0);
    const starting = pool.lease(1);
    const caches = await pool.stop();
    await starting.catch(() => undefined);
    expect(lanes.started.every((each) => each.isStopped)).toBe(true);
    expect(caches.map((each) => each.lane)).toEqual([0, 1, 2]);
    await expect(pool.lease(0)).rejects.toThrow('the harness is stopping');
    expect(pool.forkUrlOf(0)).toBeUndefined();
    // A second stop returns the same caches and stops nothing again.
    expect(await pool.stop()).toEqual(caches);
  });

  test('a lane given at creation, as the first lane started during set-up, is leased without a new start', async () => {
    const lanes = fakeLanes();
    const initial = await lanes.startLane(0, 0);
    const pool = createLanePool({ count: 2, startLane: lanes.startLane, initial });
    expect(await pool.lease(0)).toEqual(initial.info);
    expect(lanes.started).toHaveLength(1);
  });
});

describe('the lane server', () => {
  let close: () => Promise<void>;
  let url: string;
  const lanes = fakeLanes();
  beforeAll(async () => {
    const server = await startLaneServer({
      pool: createLanePool({ count: 2, startLane: lanes.startLane }),
      token: TOKEN,
    });
    close = server.close;
    url = server.url;
  });
  afterAll(() => close());

  const request = (method: string, path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const { port } = new URL(url);
      const outgoing = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, ...headers },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
          );
        }
      );
      outgoing.on('error', reject);
      outgoing.end();
    });

  test('leases a lane, and lists the started lanes', async () => {
    const leased = await request('POST', '/v1/lanes/1');
    expect(leased.status).toBe(200);
    expect(JSON.parse(leased.body)).toMatchObject({ index: 1, generation: 0, walletUrl: 'http://127.0.0.1:8010' });
    const listed = await request('GET', '/v1/lanes');
    expect(JSON.parse(listed.body).map((each: LaneInfo) => each.index)).toEqual([1]);
  });

  test('needs the run token, its own Host and no Origin, and names an unknown lane or path', async () => {
    const { port } = new URL(url);
    expect((await request('GET', '/v1/lanes', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await request('GET', '/v1/lanes', { host: `localhost:${port}` })).status).toBe(403);
    expect((await request('GET', '/v1/lanes', { origin: 'http://127.0.0.1:5173' })).status).toBe(403);
    expect((await request('POST', '/v1/lanes/9')).status).toBe(404);
    expect((await request('POST', '/v1/lanes/01')).status).toBe(404);
    expect((await request('DELETE', '/v1/lanes/1')).status).toBe(404);
  });
});

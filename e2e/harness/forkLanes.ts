// The run's fork lanes: one per Playwright worker, each an anvil fork with its own wallet server and screening
// partition, all forked through the run's one upstream proxy.
//
// A worker leases the lane of its `parallelIndex` when it first needs it, through the lane server, so a run
// that uses fewer workers than the pool allows starts fewer forks. Playwright gives a worker that replaces
// another, as after a failed test, the same `parallelIndex`, so it leases the same lane, and the wallet's
// reset before each test clears what the previous worker left. A lane whose anvil has exited is stopped and
// started again on its next lease. The lanes live in the runner, not in the workers, so a worker that crashes
// leaves no anvil behind, and the teardown stops every lane while the upstream proxy still holds its port.
import http from 'node:http';

import type { LaneCache } from './fork';
import { tokenMatches } from './walletServer';

/** What a worker needs to know about its lane. */
export type LaneInfo = {
  index: number;
  /** How many times this lane was started before this start: 0, unless its anvil exited and was replaced. */
  generation: number;
  forkUrl: string;
  anvilPid: number;
  walletUrl: string;
  /** The fork cache this lane's anvil started from. */
  cache: 'cold' | 'warm' | 'off';
};

/** A started lane: what workers read, whether its anvil still runs, and its stop, which returns its cache. */
export type StartedLane = {
  info: LaneInfo;
  isAlive: () => boolean;
  /** Stops the wallet server and anvil, and returns what the promotion needs, or undefined when not cached. */
  stop: () => Promise<LaneCache | undefined>;
};

export type LanePool = {
  count: number;
  /** The lane for worker `index`, started if it is not running. */
  lease: (index: number) => Promise<LaneInfo>;
  /** The fork URL of lane `index`, or undefined when it has not started or the pool is stopping. */
  forkUrlOf: (index: number) => string | undefined;
  started: () => LaneInfo[];
  /** Stops every lane, waiting for any still starting, and returns their caches by lane and start. */
  stop: () => Promise<LaneCache[]>;
};

export function createLanePool({
  count,
  startLane,
  initial,
}: {
  count: number;
  startLane: (index: number, generation: number) => Promise<StartedLane>;
  /** A lane already started, as lane 0 is during set-up to choose the upstream. */
  initial?: StartedLane;
}): LanePool {
  type Slot = { current?: StartedLane; starting?: Promise<StartedLane>; nextGeneration: number };
  const slots: Slot[] = Array.from({ length: count }, () => ({ nextGeneration: 0 }));
  const caches: { lane: number; generation: number; cache: LaneCache }[] = [];
  let stopping: Promise<LaneCache[]> | undefined;

  const retire = async (lane: StartedLane) => {
    const cache = await lane.stop();
    if (cache !== undefined) caches.push({ lane: lane.info.index, generation: lane.info.generation, cache });
  };

  if (initial !== undefined) {
    slots[initial.info.index].current = initial;
    slots[initial.info.index].nextGeneration = initial.info.generation + 1;
  }

  const lease = async (index: number): Promise<LaneInfo> => {
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new Error(`no lane ${index}: the pool has ${count}`);
    if (stopping !== undefined) throw new Error('the harness is stopping');
    const slot = slots[index];
    if (slot.starting === undefined) {
      if (slot.current?.isAlive()) return slot.current.info;
      const previous = slot.current;
      slot.current = undefined;
      slot.starting = (async () => {
        if (previous !== undefined) await retire(previous);
        const lane = await startLane(index, slot.nextGeneration);
        slot.nextGeneration += 1;
        if (stopping !== undefined) {
          await retire(lane);
          throw new Error('the harness is stopping');
        }
        slot.current = lane;
        return lane;
      })();
      slot.starting.then(
        () => (slot.starting = undefined),
        () => (slot.starting = undefined)
      );
    }
    return (await slot.starting).info;
  };

  return {
    count,
    lease,
    forkUrlOf: (index) => (stopping === undefined ? slots[index]?.current?.info.forkUrl : undefined),
    started: () => slots.flatMap((slot) => (slot.current === undefined ? [] : [slot.current.info])),
    stop: () =>
      (stopping ??= (async () => {
        await Promise.allSettled(slots.map((slot) => slot.starting));
        await Promise.all(
          slots.map(async (slot) => {
            const lane = slot.current;
            slot.current = undefined;
            if (lane !== undefined) await retire(lane);
          })
        );
        return caches.sort((a, b) => a.lane - b.lane || a.generation - b.generation).map((each) => each.cache);
      })()),
  };
}

/**
 * The lane server, on 127.0.0.1: `POST /v1/lanes/<index>` leases a lane and `GET /v1/lanes` lists the started
 * ones. Like the wallet server, it answers only a request with its own Host, no Origin header and the run's
 * bearer token, so no browser page can use it.
 */
export async function startLaneServer({
  pool,
  token,
}: {
  pool: LanePool;
  token: string;
}): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    const { port } = server.address() as { port: number };
    if (request.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'host' });
    if (request.headers.origin !== undefined) return send(403, { error: 'origin' });
    const authorization = request.headers.authorization ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (!tokenMatches(token, bearer)) return send(401, { error: 'unauthorized' });
    request.resume();
    request.on('end', async () => {
      const path = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
      if (request.method === 'GET' && path === '/v1/lanes') return send(200, pool.started());
      const leaseMatch = /^\/v1\/lanes\/(0|[1-9][0-9]{0,3})$/.exec(path);
      if (request.method !== 'POST' || leaseMatch === null || Number(leaseMatch[1]) >= pool.count) {
        return send(404, { error: 'no such lane or endpoint' });
      }
      try {
        send(200, await pool.lease(Number(leaseMatch[1])));
      } catch (error) {
        send(500, { error: String((error as Error)?.message ?? error).slice(0, 300) });
      }
    });
  });
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

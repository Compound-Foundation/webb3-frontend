// A stand-in for the screening worker, and the host of the harness's test extension page.
//
// `POST /screen` takes `{ address }`, as `src/helpers/screening.ts` sends it, and answers by the behaviour
// the harness set for that address. An address with no behaviour set is blocked. Every request is logged.
// `GET /extension/` serves the test extension (see `extensionPage.ts`), which the app loads in a frame.
import http from 'node:http';

import { EXTENSION_PAGE } from './extensionPage';

export const SCREENING_BEHAVIOURS = [
  'allowed',
  'blocked',
  /** Never answers. The app gives up after 10 s. */
  'timeout',
  /** Holds the request until `release`, so a test can act while screening is pending. */
  'hold',
  /** 200 with a body that is not JSON. */
  'malformed-text',
  /** 200 `{"flagged":"false"}`: a string, not a boolean. */
  'malformed-string',
  /** 200 `{}`. */
  'malformed-empty',
  /** 500. */
  'error',
] as const;

export type ScreeningBehaviour = (typeof SCREENING_BEHAVIOURS)[number];

export type ScreeningLogEntry = {
  address: string;
  origin: string | null;
  behaviour: ScreeningBehaviour;
  receivedAt: string;
  outcome: 'answered' | 'held' | 'released' | 'closed';
};

export type ScreeningStub = {
  origin: string;
  endpoint: string;
  extensionUrl: string;
  setBehaviour: (address: string, behaviour: ScreeningBehaviour) => void;
  behaviourOf: (address: string) => ScreeningBehaviour;
  /** Answers every held request for `address` as `outcome`. Returns how many it answered. */
  release: (address: string, outcome: 'allowed' | 'blocked') => number;
  log: () => ScreeningLogEntry[];
  reset: () => void;
  close: () => Promise<void>;
};

export const isAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);

/** Starts the stub on 127.0.0.1. CORS is allowed for `allowedOrigins` only, which is read on every request. */
export function startScreeningStub({
  allowedOrigins,
}: {
  allowedOrigins: ReadonlySet<string>;
}): Promise<ScreeningStub> {
  const behaviours = new Map<string, ScreeningBehaviour>();
  const entries: ScreeningLogEntry[] = [];
  /** Requests left unanswered: `timeout` until reset, `hold` until released. */
  const held = new Map<
    http.ServerResponse,
    { address: string; entry: ScreeningLogEntry; cors: Record<string, string> }
  >();

  const answer = (response: http.ServerResponse, behaviour: ScreeningBehaviour, cors: Record<string, string>) => {
    const json = (status: number, body: string) => {
      response.writeHead(status, { 'content-type': 'application/json', ...cors });
      response.end(body);
    };
    switch (behaviour) {
      case 'allowed':
        return json(200, '{"flagged":false}');
      case 'blocked':
        return json(200, '{"flagged":true}');
      case 'malformed-text':
        response.writeHead(200, { 'content-type': 'text/plain', ...cors });
        return response.end('not json');
      case 'malformed-string':
        return json(200, '{"flagged":"false"}');
      case 'malformed-empty':
        return json(200, '{}');
      case 'error':
        response.writeHead(500, { 'content-type': 'text/plain', ...cors });
        return response.end('internal error');
      default:
        throw new Error(`behaviour ${behaviour} has no immediate answer`);
    }
  };

  const server = http.createServer((request, response) => {
    const { port } = server.address() as { port: number };
    if (request.headers.host !== `127.0.0.1:${port}`) {
      response.writeHead(403);
      return response.end();
    }
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/extension/' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(EXTENSION_PAGE);
    }
    if (url.pathname !== '/screen') {
      response.writeHead(404);
      return response.end();
    }
    const origin = request.headers.origin ?? null;
    const cors: Record<string, string> =
      origin !== null && allowedOrigins.has(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    if (origin !== null && !allowedOrigins.has(origin)) {
      response.writeHead(403);
      return response.end();
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
      });
      return response.end();
    }
    if (request.method !== 'POST') {
      response.writeHead(405, cors);
      return response.end();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 4096) chunks.push(chunk);
      else request.destroy();
    });
    request.on('end', () => {
      let address: unknown;
      try {
        address = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.address;
      } catch {
        address = undefined;
      }
      if (!isAddress(address)) {
        response.writeHead(400, cors);
        return response.end();
      }
      const key = address.toLowerCase();
      const behaviour = behaviours.get(key) ?? 'blocked';
      const entry: ScreeningLogEntry = {
        address: key,
        origin,
        behaviour,
        receivedAt: new Date().toISOString(),
        outcome: 'answered',
      };
      entries.push(entry);
      if (behaviour === 'timeout' || behaviour === 'hold') {
        entry.outcome = 'held';
        held.set(response, { address: key, entry, cors });
        response.on('close', () => held.delete(response));
        return;
      }
      answer(response, behaviour, cors);
    });
  });

  const closeHeld = () => {
    for (const [response, { entry }] of held) {
      entry.outcome = 'closed';
      response.destroy();
    }
    held.clear();
  };

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve({
        origin,
        endpoint: `${origin}/screen`,
        extensionUrl: `${origin}/extension/`,
        setBehaviour: (address, behaviour) => {
          if (!isAddress(address)) throw new Error('screening: not an address');
          if (!SCREENING_BEHAVIOURS.includes(behaviour)) throw new Error('screening: unknown behaviour');
          behaviours.set(address.toLowerCase(), behaviour);
        },
        behaviourOf: (address) => behaviours.get(address.toLowerCase()) ?? 'blocked',
        release: (address, outcome) => {
          let count = 0;
          for (const [response, each] of held) {
            if (each.address !== address.toLowerCase() || each.entry.behaviour !== 'hold') continue;
            each.entry.outcome = 'released';
            held.delete(response);
            answer(response, outcome, each.cors);
            count += 1;
          }
          return count;
        },
        log: () => entries.map((entry) => ({ ...entry })),
        reset: () => {
          closeHeld();
          behaviours.clear();
          entries.length = 0;
        },
        close: () =>
          new Promise((done) => {
            closeHeld();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

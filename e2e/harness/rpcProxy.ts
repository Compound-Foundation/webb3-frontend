// The HTTPS JSON-RPC proxy that the app's RPC URLs point at. `envVars.ts` builds every RPC URL as
// `https://${VITE_V3_RPC_PROVIDER_HOST}/<network>`, so the harness sets that host to this proxy's address.
// `/ethereum-mainnet` goes to the local anvil fork, for reads only. Every other network answers a JSON-RPC
// error: the harness forks Ethereum alone and has no other-chain passthrough.
import https from 'node:https';

import { countIn, methodName } from './fork';

/** The reads the app makes. Every other method is refused on every route, so the page can neither write nor administer the fork. */
export const APP_READ_METHODS: ReadonlySet<string> = new Set([
  'eth_chainId',
  'net_version',
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getLogs',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
]);

export const FORK_ROUTE = '/ethereum-mainnet';
export const MAX_RPC_BODY_BYTES = 10 * 1024 * 1024;

export type RpcProxyStats = {
  /** Calls forwarded to anvil, by method. */
  forwarded: Map<string, number>;
  /** Calls refused, by method or reason. */
  refused: Map<string, number>;
  /** Calls to a network the harness does not serve, by route. */
  unserved: Map<string, number>;
};

export type RpcProxy = {
  url: string;
  host: string;
  port: number;
  stats: RpcProxyStats;
  close: () => Promise<void>;
};

const jsonRpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});

/**
 * Starts the proxy on 127.0.0.1 with `tls`. `allowedOrigins` is read on every request, so origins added after
 * start-up, such as a preview server's, take effect at once. A request is refused when its Host is not the
 * proxy's own address (DNS rebinding), when it carries an Origin outside `allowedOrigins`, when it is not a
 * JSON POST, or when its body is over 10 MB.
 */
export function startRpcProxy({
  tls,
  forkUrl,
  allowedOrigins,
}: {
  tls: { key: Buffer; cert: Buffer };
  forkUrl: () => string;
  allowedOrigins: ReadonlySet<string>;
}): Promise<RpcProxy> {
  const stats: RpcProxyStats = { forwarded: new Map(), refused: new Map(), unserved: new Map() };
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    const origin = request.headers.origin;
    const corsHeaders: Record<string, string> =
      origin !== undefined && allowedOrigins.has(origin)
        ? { 'access-control-allow-origin': origin, vary: 'Origin' }
        : {};
    const refuse = (status: number, reason: string) => {
      countIn(stats.refused, reason);
      response.writeHead(status, { 'content-type': 'text/plain', ...corsHeaders });
      response.end();
    };
    const { port } = server.address() as { port: number };
    if (request.headers.host !== `127.0.0.1:${port}`) return refuse(403, "<a Host other than the proxy's address>");
    if (origin !== undefined && !allowedOrigins.has(origin)) return refuse(403, '<an Origin outside the app>');
    const route = (request.url ?? '').split('?')[0];
    if (!/^\/[a-z0-9-]{1,64}$/.test(route)) return refuse(404, '<an unknown path>');
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...corsHeaders,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
      return response.end();
    }
    if (request.method !== 'POST') return refuse(405, '<a method other than POST>');
    if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
      return refuse(415, '<a content type other than JSON>');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_RPC_BODY_BYTES) chunks.push(chunk);
      else if (!request.destroyed) {
        countIn(stats.refused, '<a body over 10 MB>');
        request.destroy();
      }
    });
    request.on('end', async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return refuse(400, '<a body that is not JSON>');
      }
      const isBatch = Array.isArray(parsed);
      const calls = (isBatch ? parsed : [parsed]) as { [key: string]: unknown }[];
      if (calls.length === 0) return refuse(400, '<an empty batch>');
      const answer = (body: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json', ...corsHeaders });
        response.end(JSON.stringify(body));
      };
      const methods = calls.map((call) => methodName(call?.method));
      const outside = methods.filter((method) => !APP_READ_METHODS.has(method));
      if (outside.length > 0) {
        for (const method of outside) countIn(stats.refused, method);
        const errors = calls.map((call, index) =>
          APP_READ_METHODS.has(methods[index])
            ? jsonRpcError(call?.id, -32603, 'harness: not run, because the batch holds a refused method')
            : jsonRpcError(call?.id, -32601, 'harness: method refused')
        );
        return answer(isBatch ? errors : errors[0]);
      }
      if (route !== FORK_ROUTE) {
        countIn(stats.unserved, route);
        const errors = calls.map((call) => jsonRpcError(call?.id, -32000, 'harness: chain not served by the harness'));
        return answer(isBatch ? errors : errors[0]);
      }
      // Rebuilt from the four members that were checked.
      const checked = calls.map(({ jsonrpc, id, method, params }) => ({ jsonrpc, id, method, params }));
      for (const method of methods) countIn(stats.forwarded, method);
      try {
        const upstream = await fetch(forkUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(isBatch ? checked : checked[0]),
          signal: AbortSignal.timeout(60_000),
          redirect: 'error',
        });
        const text = await upstream.text();
        response.writeHead(upstream.ok ? 200 : 502, { 'content-type': 'application/json', ...corsHeaders });
        response.end(text);
      } catch {
        countIn(stats.refused, '<no answer from the fork>');
        const errors = calls.map((call) => jsonRpcError(call?.id, -32603, 'harness: no answer from the fork'));
        answer(isBatch ? errors : errors[0]);
      }
    });
  });
  server.keepAliveTimeout = 0;
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `https://127.0.0.1:${port}`,
        host: `127.0.0.1:${port}`,
        port,
        stats,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

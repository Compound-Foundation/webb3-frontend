// Small local servers for the harness's unit tests: a JSON-RPC node that answers from a table of handlers
// and records every call, and a helper to stop servers.
import http from 'node:http';

export type Call = { method: string; params: unknown[]; headers: http.IncomingHttpHeaders };
export type Handler = (params: unknown[]) => unknown;

export type FakeNode = {
  url: string;
  calls: Call[];
  handlers: Map<string, Handler>;
  close: () => Promise<void>;
};

/** A JSON-RPC node on 127.0.0.1. A method with no handler answers -32601. A handler that throws answers its message. */
export function startFakeNode(handlers: Record<string, Handler> = {}): Promise<FakeNode> {
  const table = new Map(Object.entries(handlers));
  const calls: Call[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      const answer = (call: { id?: unknown; method: string; params?: unknown[] }) => {
        calls.push({ method: call.method, params: call.params ?? [], headers: request.headers });
        const handler = table.get(call.method);
        if (handler === undefined)
          return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: `no ${call.method}` } };
        try {
          return { jsonrpc: '2.0', id: call.id, result: handler(call.params ?? []) };
        } catch (error) {
          return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: (error as Error).message } };
        }
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        calls,
        handlers: table,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      })
    )
  );
}

export const FORK_BLOCK = 26244888;
export const FORK_HASH = '0x440c51a6a6953b880568c1b60e4ad59044f3fa783e340e34d66793e466883839';

/** The handlers of a node that passes `verifyFork` for the pinned block. */
export function anvilHandlers(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  let snapshot = 0;
  return {
    eth_chainId: () => '0x1',
    web3_clientVersion: () => 'anvil/v1.2.3',
    anvil_metadata: () => ({ forkedNetwork: { forkBlockNumber: FORK_BLOCK, forkBlockHash: FORK_HASH } }),
    eth_getBlockByNumber: () => ({ hash: FORK_HASH, timestamp: '0x6a000000', number: '0x1907a18' }),
    evm_snapshot: () => `0x${(++snapshot).toString(16)}`,
    evm_revert: () => true,
    evm_setNextBlockTimestamp: () => null,
    anvil_impersonateAccount: () => null,
    anvil_stopImpersonatingAccount: () => null,
    anvil_setBalance: () => null,
    eth_sendTransaction: () => `0x${'ab'.repeat(32)}`,
    eth_blockNumber: () => '0x1907a18',
    ...overrides,
  };
}

// Runs before each fork suite. The suite talks to one node only: the local mainnet fork that
// `scripts/test-wrapped-lending-fork.js` started on the loopback interface. Any other destination
// fails, so no test can reach the upstream RPC, mainnet or any other service.
import http from 'http';
import https from 'https';
import net from 'net';

import { LOCAL_FORK_URL } from './fork';

const fork = new URL(LOCAL_FORK_URL);
const isForkHost = (hostname: unknown) => hostname === fork.hostname || hostname === 'localhost';

type RequestTarget = {
  protocol?: string;
  hostname?: string | null;
  host?: string | null;
  port?: string | number | null;
};

/**
 * The protocol, host and port a call to `http.request` or `https.request` connects to. Node merges
 * a URL argument with an options argument, and the options win.
 */
function requestTarget(args: unknown[]): RequestTarget {
  const [first, second] = args;
  const fromUrl: RequestTarget =
    typeof first === 'string' || first instanceof URL ? new URL(String(first)) : (first as RequestTarget) ?? {};
  const options: RequestTarget = typeof second === 'object' && second !== null ? (second as RequestTarget) : {};
  return {
    protocol: options.protocol ?? fromUrl.protocol,
    hostname: options.hostname ?? options.host ?? fromUrl.hostname ?? fromUrl.host,
    port: options.port ?? fromUrl.port,
  };
}

function refuseOtherHosts<T extends (...args: never[]) => unknown>(original: T, defaultProtocol: string): T {
  return function (this: unknown, ...args: Parameters<T>) {
    const target = requestTarget(args as unknown[]);
    const protocol = target.protocol ?? defaultProtocol;
    const hostname = String(target.hostname ?? '').split(':')[0];
    if (protocol !== 'http:' || !isForkHost(hostname) || String(target.port ?? '') !== fork.port) {
      throw new Error(
        `The fork suite only talks to the local fork, not ${protocol}//${hostname}:${target.port ?? ''}.`
      );
    }
    return original.apply(this, args);
  } as T;
}

http.request = refuseOtherHosts(http.request, 'http:');
http.get = refuseOtherHosts(http.get, 'http:');
https.request = refuseOtherHosts(https.request, 'https:');
https.get = refuseOtherHosts(https.get, 'https:');

// Every TCP connection, whichever library makes it, goes through `net.Socket#connect`. A call from
// `net.createConnection` passes its arguments already normalized, as an array whose first entry is
// the options. A connection with a `path`, or with no port, is a pipe, which the suite never needs.
// A custom `lookup` can resolve the fork's host name to another address, so the guard refuses it.
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const [first, second] = args;
  const normalized = Array.isArray(first) ? first[0] : first;
  const options =
    typeof normalized === 'object' && normalized !== null
      ? (normalized as { port?: unknown; host?: unknown; path?: unknown; lookup?: unknown })
      : { port: first, host: typeof second === 'string' ? second : undefined };
  const isTcp = !options.path && options.port !== undefined && options.port !== null;
  if (
    !isTcp ||
    options.lookup !== undefined ||
    !isForkHost(options.host ?? 'localhost') ||
    String(options.port) !== fork.port
  ) {
    throw new Error(
      `The fork suite only connects to the local fork, not ${String(options.host)}:${String(options.port)}.`
    );
  }
  return (connect as (...connectArgs: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

// Each market's scenarios run in order as one session of the app, so the rendered hooks must outlive
// a test. Each suite unmounts them itself, after its last scenario. Testing Library reads this when
// a suite first imports it.
process.env.RTL_SKIP_AUTO_CLEANUP = 'true';

// The hooks settle from network callbacks, outside `act`, which React reports on every update.
const reportError = console.error;
jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
  reportError(...args);
});

// ESM-only packages Jest does not load here, as in the unit suites. The transaction manager takes ids
// from uuid. `useLendingRoute` imports wagmi and the Web3 context, though `validateWrappedMarket`,
// the only part the fork suite calls, uses neither.
let mockNextId = 0;
jest.mock('uuid', () => ({ v4: () => `fork-transaction-${++mockNextId}` }));
jest.mock('wagmi', () => ({ useAccount: jest.fn(), useConnectorClient: jest.fn() }));
jest.mock('@contexts/Web3Context', () => ({ useWeb3Context: jest.fn() }));
jest.mock('@helpers/ethersAdapter', () => ({ useEthersProvider: jest.fn() }));

// Runs before each fork suite. The suite talks to one node only: the local mainnet fork that
// `scripts/test-wrapped-lending-fork.js` started on the loopback interface. Any other host fails the
// request, so no test can reach the upstream RPC, mainnet or any other service.
import http from 'http';
import https from 'https';

import { LOCAL_FORK_URL } from './fork';

const forkHost = new URL(LOCAL_FORK_URL).host;

function refuseOtherHosts<T extends (...args: never[]) => unknown>(original: T, protocol: string): T {
  return function (this: unknown, ...args: Parameters<T>) {
    const [target] = args as unknown[];
    const host =
      typeof target === 'string' || target instanceof URL
        ? new URL(String(target)).host
        : `${(target as { hostname?: string; host?: string }).hostname ?? (target as { host?: string }).host}:${
            (target as { port?: string | number }).port ?? ''
          }`;
    if (protocol !== 'http:' || host !== forkHost) {
      throw new Error(`The fork suite only talks to the local fork, not ${protocol}//${host}.`);
    }
    return original.apply(this, args);
  } as T;
}

http.request = refuseOtherHosts(http.request, 'http:');
http.get = refuseOtherHosts(http.get, 'http:');
https.request = refuseOtherHosts(https.request, 'https:');
https.get = refuseOtherHosts(https.get, 'https:');

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

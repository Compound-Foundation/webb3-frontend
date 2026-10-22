import { Interface } from '@ethersproject/abi';
import { JsonRpcProvider, Web3Provider } from '@ethersproject/providers';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { useAccount, useConnectorClient } from 'wagmi';

import {
  ANCHORAGE_CONNECTOR_ID,
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WrappedMarketRegistry,
} from '@constants/wrappedMarkets';
import { useWeb3Context, Web3 } from '@contexts/Web3Context';
import { useConflictedRdns } from '@helpers/eip6963Security';
import { useEthersProvider } from '@helpers/ethersAdapter';
import { LendingRoute } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { useLendingRoute } from '@hooks/useLendingRoute';
import { MarketData } from '@types';

import { mockWeb3 } from '../mocks/mockWeb3';

// wagmi ships ESM only, which Jest does not load here, so neither it nor the context that
// imports it is required for real.
jest.mock('wagmi', () => ({ useAccount: jest.fn(), useConnectorClient: jest.fn() }));
jest.mock('@contexts/Web3Context', () => ({ useWeb3Context: jest.fn() }));
jest.mock('@helpers/ethersAdapter', () => ({ useEthersProvider: jest.fn() }));
jest.mock('@helpers/eip6963Security', () => ({
  ...jest.requireActual('@helpers/eip6963Security'),
  useConflictedRdns: jest.fn(),
}));

const mockUseAccount = useAccount as jest.Mock;
const mockUseConnectorClient = useConnectorClient as jest.Mock;
const mockUseWeb3Context = useWeb3Context as jest.Mock;
const mockUseEthersProvider = useEthersProvider as jest.Mock;
const mockUseConflictedRdns = useConflictedRdns as jest.Mock;

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000bb2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const MARKET_CHAIN = {
  usdc: {
    comet: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    wrapper: '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73',
    base: USDC,
  },
  usdt: {
    comet: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
    wrapper: '0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf',
    base: USDT,
  },
  iusdc: {
    comet: '0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C',
    wrapper: '0xc7Eb9aA5B9ae154C1bAb08872E90fC44e522E463',
    base: USDC,
  },
};

const USDC_MARKET = getMarket(1, MARKET_CHAIN.usdc.comet) as MarketData;
const USDT_MARKET = getMarket(1, MARKET_CHAIN.usdt.comet) as MarketData;

const OPEN_REGISTRY = buildWrappedMarketRegistry({
  ...HARDCODED_WRAPPED_LENDING_SOURCE,
  markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
    ...market,
    depositsEnabled: true,
    exitsEnabled: true,
  })),
});

const READS = new Interface([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function baseToken() view returns (address)',
]);

type ChainState = {
  chainId?: number;
  assetOf?: Record<string, string>;
  wrapperDecimals?: number;
  baseTokenOf?: Record<string, string>;
  baseDecimals?: number;
  reject?: boolean;
  raw?: string;
};

/**
 * A stand-in for the configured chain's public provider. Every validation starts with one
 * `getNetwork()`; each returns a promise the test releases, so a test decides the order in
 * which rounds finish.
 */
function chainProvider(state: ChainState = {}) {
  const rounds: (() => void)[] = [];
  const configuredAssets = Object.fromEntries(
    Object.values(MARKET_CHAIN).map(({ wrapper, comet }) => [wrapper.toLowerCase(), comet]),
  );
  const configuredBases = Object.fromEntries(
    Object.values(MARKET_CHAIN).map(({ comet, base }) => [comet.toLowerCase(), base]),
  );
  const bases = new Set([USDC.toLowerCase(), USDT.toLowerCase()]);
  const provider = {
    getNetwork: jest.fn(
      () =>
        new Promise((resolve) => {
          rounds.push(() => resolve({ chainId: state.chainId ?? 1, name: 'homestead' }));
        }),
    ),
    call: jest.fn(async ({ to, data }: { to: string; data: string }) => {
      if (state.reject) throw new Error('RPC unavailable');
      if (state.raw !== undefined) return state.raw;
      const target = to.toLowerCase();
      const fragment = READS.getFunction(data.slice(0, 10));
      if (fragment.name === 'asset') {
        return READS.encodeFunctionResult('asset', [(state.assetOf ?? configuredAssets)[target]]);
      }
      if (fragment.name === 'baseToken') {
        return READS.encodeFunctionResult('baseToken', [(state.baseTokenOf ?? configuredBases)[target]]);
      }
      return READS.encodeFunctionResult('decimals', [
        bases.has(target) ? (state.baseDecimals ?? 6) : (state.wrapperDecimals ?? 18),
      ]);
    }),
  };
  /** Finish the oldest unfinished validation round. */
  const finishNext = async () => {
    const finish = rounds.shift();
    if (!finish) throw new Error('no validation round is waiting');
    await act(async () => {
      finish();
    });
  };
  /** Finish the round at `index` among those still waiting. */
  const finishAt = async (index: number) => {
    const [finish] = rounds.splice(index, 1);
    if (!finish) throw new Error(`no validation round at ${index}`);
    await act(async () => {
      finish();
    });
  };
  return { provider, finishNext, finishAt, waiting: () => rounds.length };
}

const walletProvider = () => new Web3Provider({ request: jest.fn() }, 1);

type SessionSetup = {
  connectorId?: string | undefined;
  uid?: string;
  account?: string | undefined;
  chainId?: number;
  status?: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
  screeningStatus?: Web3['screeningStatus'];
  provider?: Web3['write']['provider'];
  client?: { account: { address: string }; chain: { id: number } } | undefined;
  clientError?: boolean;
};

function setSession(setup: SessionSetup = {}) {
  const connectorId = 'connectorId' in setup ? setup.connectorId : ANCHORAGE_CONNECTOR_ID;
  const account = 'account' in setup ? setup.account : ACCOUNT;
  const chainId = setup.chainId ?? 1;
  const web3: Web3 = {
    ...mockWeb3,
    screeningStatus: setup.screeningStatus ?? 'allowed',
    write: {
      connector: connectorId === undefined ? undefined : ({ id: connectorId, uid: setup.uid ?? 'uid-1' } as never),
      chainId,
      account,
      isActive: true,
      provider: 'provider' in setup ? setup.provider : walletProvider(),
    },
  };
  mockUseWeb3Context.mockReturnValue(web3);
  mockUseAccount.mockReturnValue({ status: setup.status ?? 'connected' });
  mockUseConnectorClient.mockReturnValue({
    data:
      'client' in setup
        ? setup.client
        : account === undefined
          ? undefined
          : { account: { address: account }, chain: { id: chainId } },
    isError: setup.clientError ?? false,
  });
}

function renderRoute(market: MarketData, registry?: WrappedMarketRegistry, path = '/') {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
  );
  return renderHook(({ m }: { m: MarketData }) => useLendingRoute(m, registry), {
    initialProps: { m: market },
    wrapper,
  });
}

function wrapped(route: LendingRoute) {
  if (route.kind !== 'wrapped') throw new Error(`expected a wrapped route, got ${route.kind}`);
  return route;
}

const ELIGIBLE = { eligible: true };
const blocked = (reason: string, extra: object = {}) => ({ eligible: false, reason, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  mockUseConflictedRdns.mockReturnValue(new Set());
  setSession();
});

describe('useLendingRoute', () => {
  it('enables eligibility only after asset matches the selected Comet', async () => {
    const chain = chainProvider();
    mockUseEthersProvider.mockReturnValue(chain.provider);

    const { result } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
    const before = wrapped(result.current);
    expect(before.reads).toEqual(blocked('validation-pending'));
    expect(before.deposit).toEqual(blocked('validation-pending'));
    expect(before.exit).toEqual(blocked('validation-pending'));
    // The read goes to the configured chain's public provider, not the wallet.
    expect(mockUseEthersProvider).toHaveBeenCalledWith({ chainId: 1 });

    await chain.finishNext();
    await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    expect(wrapped(result.current).exit).toEqual(ELIGIBLE);
    expect(wrapped(result.current).reads).toEqual(ELIGIBLE);
    const assetCall = chain.provider.call.mock.calls.find(([tx]) => tx.data === READS.encodeFunctionData('asset'));
    expect(assetCall?.[0].to.toLowerCase()).toBe(MARKET_CHAIN.usdc.wrapper.toLowerCase());
  });

  it('enables reads but no write with the shipped registry', async () => {
    const chain = chainProvider();
    mockUseEthersProvider.mockReturnValue(chain.provider);

    const { result } = renderRoute(USDC_MARKET);
    await chain.finishNext();
    await waitFor(() => expect(wrapped(result.current).reads).toEqual(ELIGIBLE));
    expect(wrapped(result.current).deposit).toEqual(blocked('deposits-disabled'));
    expect(wrapped(result.current).exit).toEqual(blocked('exits-disabled'));
  });

  describe('fails closed on missing mapping, loading, RPC rejection and asset mismatch without direct fallback', () => {
    it('missing mapping', () => {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const routedOnly = buildWrappedMarketRegistry({
        routedMarkets: HARDCODED_WRAPPED_LENDING_SOURCE.routedMarkets,
        markets: [],
      });
      const { result } = renderRoute(USDC_MARKET, routedOnly);
      const route = wrapped(result.current);
      expect(route.market).toBeUndefined();
      expect(route.deposit).toEqual(blocked('missing-mapping'));
      expect(route.exit).toEqual(blocked('missing-mapping'));
      expect(chain.provider.call).not.toHaveBeenCalled();
      expect(chain.provider.getNetwork).not.toHaveBeenCalled();
    });

    it('loading', async () => {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
      await act(async () => undefined);
      expect(chain.waiting()).toBe(1);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
    });

    it.each<[string, ChainState, string]>([
      ['RPC rejection', { reject: true }, 'validation-failed'],
      ['malformed return data', { raw: '0x' }, 'validation-failed'],
      ['the wrong network', { chainId: 8453 }, 'validation-failed'],
      [
        'asset mismatch',
        { assetOf: { [MARKET_CHAIN.usdc.wrapper.toLowerCase()]: MARKET_CHAIN.usdt.comet } },
        'asset-mismatch',
      ],
      [
        'zero asset',
        { assetOf: { [MARKET_CHAIN.usdc.wrapper.toLowerCase()]: `0x${'0'.repeat(40)}` } },
        'asset-mismatch',
      ],
      ['base token mismatch', { baseTokenOf: { [MARKET_CHAIN.usdc.comet.toLowerCase()]: USDT } }, 'metadata-mismatch'],
      ['share decimals mismatch', { wrapperDecimals: 6 }, 'metadata-mismatch'],
      ['base decimals mismatch', { baseDecimals: 18 }, 'metadata-mismatch'],
    ])('%s', async (_label, state, reason) => {
      const chain = chainProvider(state);
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
      await chain.finishNext();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(blocked(reason)));
      const route = wrapped(result.current);
      expect(route.exit).toEqual(blocked(reason));
      expect(route.reads).toEqual(blocked(reason));
      expect(route.market?.wrapperAddress).toBe(MARKET_CHAIN.usdc.wrapper);
    });

    it('no provider for the configured chain', async () => {
      mockUseEthersProvider.mockReturnValue(undefined);
      const { result } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(blocked('validation-failed')));
    });
  });

  describe('rejects stale validation after account, connector, chain or market changes', () => {
    it.each<[string, SessionSetup]>([
      ['account', { account: OTHER_ACCOUNT }],
      ['connector', { uid: 'uid-2' }],
    ])('%s change', async (_label, change) => {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result, rerender } = renderRoute(USDC_MARKET, OPEN_REGISTRY);

      setSession(change);
      rerender({ m: USDC_MARKET });
      // Invalidated in the same render, before any effect runs.
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));

      // The previous route's success arrives late and must not enable this one.
      await chain.finishAt(0);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));

      await chain.finishNext();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    });

    it('chain change', async () => {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result, rerender } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
      await chain.finishNext();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));

      setSession({ chainId: 8453 });
      rerender({ m: USDC_MARKET });
      expect(wrapped(result.current).deposit).toEqual(blocked('wrong-chain', { requiredChainId: 1 }));

      // Back on Ethereum, the earlier success does not carry over.
      setSession();
      rerender({ m: USDC_MARKET });
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await act(async () => undefined);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));

      // The round started on the wrong chain finishes late and is dropped.
      await chain.finishAt(0);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await chain.finishNext();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    });

    it('market change', async () => {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result, rerender } = renderRoute(USDC_MARKET, OPEN_REGISTRY);

      rerender({ m: USDT_MARKET });
      const usdt = wrapped(result.current);
      expect(usdt.cometAddress).toBe(MARKET_CHAIN.usdt.comet);
      expect(usdt.deposit).toEqual(blocked('validation-pending'));

      // The USDC round succeeds late.
      await chain.finishAt(0);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));

      await chain.finishNext();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
      expect(wrapped(result.current).market?.wrapperAddress).toBe(MARKET_CHAIN.usdt.wrapper);
    });

    it('return to an earlier market', async () => {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result, rerender } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
      rerender({ m: USDT_MARKET });
      rerender({ m: USDC_MARKET });
      expect(chain.waiting()).toBe(3);

      // The first USDC round has the same key as the current one, but it belongs to an earlier visit.
      await chain.finishAt(0);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await chain.finishAt(0);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await chain.finishNext();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    });

    it('reconnect', async () => {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result, rerender } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
      await chain.finishNext();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));

      setSession({ status: 'reconnecting' });
      rerender({ m: USDC_MARKET });
      expect(wrapped(result.current).deposit).toEqual(blocked('reconnecting'));

      setSession();
      rerender({ m: USDC_MARKET });
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await act(async () => undefined);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await chain.finishAt(chain.waiting() - 1);
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    });
  });

  it('requires a connector client for the current account and chain', async () => {
    const chain = chainProvider();
    mockUseEthersProvider.mockReturnValue(chain.provider);
    const { result, rerender } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
    await chain.finishNext();
    await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));

    const cases: SessionSetup[] = [
      // A failed refresh leaves the old wallet provider in place.
      { clientError: true },
      { client: undefined },
      { client: { account: { address: OTHER_ACCOUNT }, chain: { id: 1 } } },
      { client: { account: { address: ACCOUNT }, chain: { id: 8453 } } },
      // The read-only fallback provider cannot sign.
      { provider: new JsonRpcProvider('http://localhost', 1) },
      { provider: undefined },
    ];
    for (const setup of cases) {
      setSession(setup);
      rerender({ m: USDC_MARKET });
      expect(wrapped(result.current).deposit).toEqual(blocked('no-signer'));
    }
  });

  it('blocks a conflicted connector without waiting for the context to disconnect it', () => {
    mockUseEthersProvider.mockReturnValue(chainProvider().provider);
    mockUseConflictedRdns.mockReturnValue(new Set([ANCHORAGE_CONNECTOR_ID]));
    const { result } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
    expect(wrapped(result.current).deposit).toEqual(blocked('connector-conflict'));
  });

  it('treats a URL watch-only session as unable to write', () => {
    mockUseEthersProvider.mockReturnValue(chainProvider().provider);
    // Web3Context drops the connector and provider when `?account=` is present, even empty.
    setSession({ connectorId: undefined, provider: undefined, client: undefined });
    for (const path of ['/?account=', `/?account=${OTHER_ACCOUNT}`]) {
      const { result } = renderRoute(USDC_MARKET, OPEN_REGISTRY, path);
      expect(result.current).toEqual({ kind: 'standard', writes: blocked('watch-only') });
    }
  });

  it('keeps other connectors standard', () => {
    const chain = chainProvider();
    mockUseEthersProvider.mockReturnValue(chain.provider);
    setSession({ connectorId: 'io.metamask' });
    const { result } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
    expect(result.current).toEqual({ kind: 'standard', writes: ELIGIBLE });
    expect(chain.provider.getNetwork).not.toHaveBeenCalled();
  });
});

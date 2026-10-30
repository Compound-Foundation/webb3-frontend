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
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const FACTORY_ADDRESS = '0xf77f675a383eB43fa032ea3c6d1dd4dC56B69BF6';
const WRAPPED_MARKET_ADDRESSES = {
  usdc: {
    comet: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    wrapper: '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73',
    base: USDC_ADDRESS,
  },
  usdt: {
    comet: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
    wrapper: '0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf',
    base: USDT_ADDRESS,
  },
  iusdc: {
    comet: '0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C',
    wrapper: '0xc7Eb9aA5B9ae154C1bAb08872E90fC44e522E463',
    base: USDC_ADDRESS,
  },
};
const USDC = WRAPPED_MARKET_ADDRESSES.usdc;

const USDC_MARKET = getMarket(1, USDC.comet) as MarketData;
const USDT_MARKET = getMarket(1, WRAPPED_MARKET_ADDRESSES.usdt.comet) as MarketData;

function openRegistry(baseDecimals = 6): WrappedMarketRegistry {
  return buildWrappedMarketRegistry({
    markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
      ...market,
      baseDecimals,
      isDepositEnabled: true,
      isExitEnabled: true,
    })),
  });
}
const OPEN_REGISTRY = openRegistry();

const READS = new Interface([
  'function getWrapper(address) view returns (address)',
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function baseToken() view returns (address)',
]);

const byLowercase = (entries: [string, string][]) =>
  Object.fromEntries(entries.map(([key, value]) => [key.toLowerCase(), value]));
const ADDRESSES = Object.values(WRAPPED_MARKET_ADDRESSES);
const CANONICAL_WRAPPER = byLowercase(ADDRESSES.map(({ comet, wrapper }) => [comet, wrapper]));
const WRAPPER_ASSET = byLowercase(ADDRESSES.map(({ wrapper, comet }) => [wrapper, comet]));
const COMET_BASE = byLowercase(ADDRESSES.map(({ comet, base }) => [comet, base]));

type ChainState = {
  chainId?: number;
  canonicalWrapperOf?: Record<string, string>;
  assetOf?: Record<string, string>;
  wrapperDecimals?: number;
  baseTokenOf?: Record<string, string>;
  baseDecimals?: number;
  reject?: boolean;
  raw?: string;
};

/**
 * A stand-in for the configured chain's public provider. Every validation starts with one
 * `getNetwork()`, and each returns a promise the test releases, so the test decides the order
 * in which rounds finish.
 */
function chainProvider(state: ChainState = {}) {
  const rounds: (() => void)[] = [];
  const bases = new Set([USDC_ADDRESS.toLowerCase(), USDT_ADDRESS.toLowerCase()]);
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
      switch (fragment.name) {
        case 'getWrapper': {
          if (target !== FACTORY_ADDRESS.toLowerCase()) throw new Error('not the factory');
          const [comet] = READS.decodeFunctionData('getWrapper', data);
          return READS.encodeFunctionResult('getWrapper', [
            (state.canonicalWrapperOf ?? CANONICAL_WRAPPER)[String(comet).toLowerCase()],
          ]);
        }
        case 'asset':
          return READS.encodeFunctionResult('asset', [(state.assetOf ?? WRAPPER_ASSET)[target]]);
        case 'baseToken':
          return READS.encodeFunctionResult('baseToken', [(state.baseTokenOf ?? COMET_BASE)[target]]);
        default:
          return READS.encodeFunctionResult('decimals', [
            bases.has(target) ? (state.baseDecimals ?? 6) : (state.wrapperDecimals ?? 18),
          ]);
      }
    }),
  };
  /** Finishes the round at `index` among those still waiting, the oldest by default. */
  const finish = async (index = 0) => {
    const [release] = rounds.splice(index, 1);
    if (!release) throw new Error(`no validation round at ${index}`);
    await act(async () => {
      release();
    });
  };
  return { provider, finish, waiting: () => rounds.length };
}

type Client = { account: { address: string }; chain: { id: number } | undefined; transport: object };

type SessionSetup = {
  connectorId?: string | undefined;
  uid?: string;
  account?: string | undefined;
  chainId?: number;
  status?: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
  screeningStatus?: Web3['screeningStatus'];
  /** Replaces the wallet provider built from the client's transport. */
  provider?: Web3['write']['provider'];
  client?: Client | undefined;
  isClientError?: boolean;
};

/**
 * Sets what Web3Context and wagmi report. By default the connector client matches the
 * account and chain, and the wallet provider is built from that client's transport, as
 * Web3Context builds it.
 */
function setSession(setup: SessionSetup = {}) {
  const connectorId = 'connectorId' in setup ? setup.connectorId : ANCHORAGE_CONNECTOR_ID;
  const account = 'account' in setup ? setup.account : ACCOUNT;
  const chainId = setup.chainId ?? 1;
  const transport = { request: jest.fn() };
  const client: Client | undefined =
    'client' in setup
      ? setup.client
      : account === undefined
        ? undefined
        : { account: { address: account }, chain: { id: chainId }, transport };
  const web3: Web3 = {
    ...mockWeb3,
    screeningStatus: setup.screeningStatus ?? 'allowed',
    write: {
      connector: connectorId === undefined ? undefined : ({ id: connectorId, uid: setup.uid ?? 'uid-1' } as never),
      chainId,
      account,
      isActive: true,
      status: setup.status ?? 'connected',
      provider: 'provider' in setup ? setup.provider : new Web3Provider(client?.transport ?? transport, 1),
    },
  };
  mockUseWeb3Context.mockReturnValue(web3);
  mockUseAccount.mockReturnValue({ status: setup.status ?? 'connected' });
  mockUseConnectorClient.mockReturnValue({ data: client, isError: setup.isClientError ?? false });
}

type Props = { market: MarketData; registry?: WrappedMarketRegistry };

/** Renders the hook and records the route of every render, committed or not. */
function renderRoute(market: MarketData, registry?: WrappedMarketRegistry, path = '/') {
  const history: LendingRoute[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
  );
  const rendered = renderHook(
    (props: Props) => {
      const route = useLendingRoute(props.market, props.registry);
      history.push(route);
      return route;
    },
    { initialProps: { market, registry }, wrapper },
  );
  return { ...rendered, history };
}

function wrapped(route: LendingRoute) {
  if (route.kind !== 'wrapped') throw new Error(`expected a wrapped route, got ${route.kind}`);
  return route;
}

const ELIGIBLE = { isEligible: true };
const blocked = (reason: string, extra: object = {}) => ({ isEligible: false, reason, ...extra });

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

    await chain.finish();
    await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    expect(wrapped(result.current).exit).toEqual(ELIGIBLE);
    expect(wrapped(result.current).reads).toEqual(ELIGIBLE);
    const assetCall = chain.provider.call.mock.calls.find(([tx]) => tx.data === READS.encodeFunctionData('asset'));
    expect(assetCall?.[0].to.toLowerCase()).toBe(USDC.wrapper.toLowerCase());
    // The factory kept in code vouches for the wrapper.
    const factoryCall = chain.provider.call.mock.calls.find(
      ([tx]) => tx.data === READS.encodeFunctionData('getWrapper', [USDC.comet]),
    );
    expect(factoryCall?.[0].to).toBe(FACTORY_ADDRESS);
  });

  it('enables reads, deposits and exits with the shipped registry', async () => {
    const chain = chainProvider();
    mockUseEthersProvider.mockReturnValue(chain.provider);

    const { result } = renderRoute(USDC_MARKET);
    await chain.finish();
    await waitFor(() => expect(wrapped(result.current).reads).toEqual(ELIGIBLE));
    expect(wrapped(result.current).deposit).toEqual(ELIGIBLE);
    expect(wrapped(result.current).exit).toEqual(ELIGIBLE);
  });

  describe('fails closed on missing mapping, loading, RPC rejection and asset mismatch without direct fallback', () => {
    it('missing mapping', () => {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result } = renderRoute(USDC_MARKET, buildWrappedMarketRegistry({ markets: [] }));
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

    const zero = `0x${'0'.repeat(40)}`;
    it.each<[string, ChainState, string]>([
      ['RPC rejection', { reject: true }, 'validation-failed'],
      ['malformed return data', { raw: '0x' }, 'validation-failed'],
      ['the wrong network', { chainId: 8453 }, 'validation-failed'],
      [
        'asset mismatch',
        { assetOf: { [USDC.wrapper.toLowerCase()]: WRAPPED_MARKET_ADDRESSES.usdt.comet } },
        'asset-mismatch',
      ],
      ['zero asset', { assetOf: { [USDC.wrapper.toLowerCase()]: zero } }, 'asset-mismatch'],
      // A contract that reads like the wrapper, but is not the one the factory names.
      [
        'non-canonical wrapper',
        { canonicalWrapperOf: { [USDC.comet.toLowerCase()]: WRAPPED_MARKET_ADDRESSES.iusdc.wrapper } },
        'not-canonical',
      ],
      ['no canonical wrapper', { canonicalWrapperOf: { [USDC.comet.toLowerCase()]: zero } }, 'not-canonical'],
      ['base token mismatch', { baseTokenOf: { [USDC.comet.toLowerCase()]: USDT_ADDRESS } }, 'metadata-mismatch'],
      ['share decimals mismatch', { wrapperDecimals: 6 }, 'metadata-mismatch'],
      ['base decimals mismatch', { baseDecimals: 18 }, 'metadata-mismatch'],
    ])('%s', async (_label, state, reason) => {
      const chain = chainProvider(state);
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
      await chain.finish();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(blocked(reason)));
      const route = wrapped(result.current);
      expect(route.exit).toEqual(blocked(reason));
      expect(route.reads).toEqual(blocked(reason));
      expect(route.market?.wrapperAddress).toBe(USDC.wrapper);
    });

    it('no provider for the configured chain', async () => {
      mockUseEthersProvider.mockReturnValue(undefined);
      const { result } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(blocked('validation-failed')));
    });
  });

  describe('rejects stale validation after account, connector, chain or market changes', () => {
    /** Renders USDC and waits until its first validation has enabled deposits. */
    async function validatedUsdc(registry: WrappedMarketRegistry = OPEN_REGISTRY) {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const rendered = renderRoute(USDC_MARKET, registry);
      await chain.finish();
      await waitFor(() => expect(wrapped(rendered.result.current).deposit).toEqual(ELIGIBLE));
      return { chain, ...rendered };
    }

    it.each<[string, SessionSetup]>([
      ['account', { account: OTHER_ACCOUNT }],
      ['connector', { uid: 'uid-2' }],
    ])('%s change', async (_label, change) => {
      const { chain, result, rerender, history } = await validatedUsdc();

      const changedAt = history.length;
      setSession(change);
      rerender({ market: USDC_MARKET, registry: OPEN_REGISTRY });
      // No render after the change, including the one before effects run, reuses the result.
      for (const route of history.slice(changedAt)) {
        expect(wrapped(route).deposit).toEqual(blocked('validation-pending'));
      }

      await chain.finish();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    });

    it('a late result for the previous account', async () => {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result, rerender } = renderRoute(USDC_MARKET, OPEN_REGISTRY);

      setSession({ account: OTHER_ACCOUNT });
      rerender({ market: USDC_MARKET, registry: OPEN_REGISTRY });
      // The first account's round succeeds late and must not enable the second.
      await chain.finish(0);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await chain.finish();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    });

    it('chain change', async () => {
      const { chain, result, rerender } = await validatedUsdc();

      setSession({ chainId: 8453 });
      rerender({ market: USDC_MARKET, registry: OPEN_REGISTRY });
      expect(wrapped(result.current).deposit).toEqual(blocked('wrong-chain', { requiredChainId: 1 }));

      // Back on Ethereum, the earlier success does not carry over.
      setSession();
      rerender({ market: USDC_MARKET, registry: OPEN_REGISTRY });
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await act(async () => undefined);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));

      // The round started on the wrong chain finishes late and is dropped.
      await chain.finish(0);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await chain.finish();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    });

    it('market change', async () => {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result, rerender } = renderRoute(USDC_MARKET, OPEN_REGISTRY);

      rerender({ market: USDT_MARKET, registry: OPEN_REGISTRY });
      const usdt = wrapped(result.current);
      expect(usdt.cometAddress).toBe(WRAPPED_MARKET_ADDRESSES.usdt.comet);
      expect(usdt.deposit).toEqual(blocked('validation-pending'));

      // The USDC round succeeds late.
      await chain.finish(0);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));

      await chain.finish();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
      expect(wrapped(result.current).market?.wrapperAddress).toBe(WRAPPED_MARKET_ADDRESSES.usdt.wrapper);
    });

    it('return to an earlier market', async () => {
      const chain = chainProvider();
      mockUseEthersProvider.mockReturnValue(chain.provider);
      const { result, rerender } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
      rerender({ market: USDT_MARKET, registry: OPEN_REGISTRY });
      rerender({ market: USDC_MARKET, registry: OPEN_REGISTRY });
      expect(chain.waiting()).toBe(3);

      // The first USDC round has the same key as the current one, but belongs to an earlier visit.
      await chain.finish(0);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await chain.finish(0);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await chain.finish();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    });

    it('reconnect', async () => {
      const { chain, result, rerender } = await validatedUsdc();

      setSession({ status: 'reconnecting' });
      rerender({ market: USDC_MARKET, registry: OPEN_REGISTRY });
      expect(wrapped(result.current).deposit).toEqual(blocked('reconnecting'));

      setSession();
      rerender({ market: USDC_MARKET, registry: OPEN_REGISTRY });
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await act(async () => undefined);
      expect(wrapped(result.current).deposit).toEqual(blocked('validation-pending'));
      await chain.finish(chain.waiting() - 1);
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    });

    it('public provider change', async () => {
      const { result, rerender, history } = await validatedUsdc();

      const replacement = chainProvider();
      mockUseEthersProvider.mockReturnValue(replacement.provider);
      const changedAt = history.length;
      rerender({ market: USDC_MARKET, registry: OPEN_REGISTRY });
      for (const route of history.slice(changedAt)) {
        expect(wrapped(route).deposit).toEqual(blocked('validation-pending'));
      }
      await replacement.finish();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));
    });

    it('mapping metadata change for the same addresses', async () => {
      const { chain, result, rerender, history } = await validatedUsdc();

      const changedAt = history.length;
      rerender({ market: USDC_MARKET, registry: openRegistry(7) });
      for (const route of history.slice(changedAt)) {
        expect(wrapped(route).deposit).toEqual(blocked('validation-pending'));
      }
      // The chain still reports 6 decimals, so the new mapping fails its check.
      await chain.finish();
      await waitFor(() => expect(wrapped(result.current).deposit).toEqual(blocked('metadata-mismatch')));
    });
  });

  it('requires a wallet provider built from the connector client for the current account and chain', async () => {
    const chain = chainProvider();
    mockUseEthersProvider.mockReturnValue(chain.provider);
    const { result, rerender } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
    await chain.finish();
    await waitFor(() => expect(wrapped(result.current).deposit).toEqual(ELIGIBLE));

    const transport = { request: jest.fn() };
    const cases: SessionSetup[] = [
      // A failed refresh leaves the old wallet provider in place.
      { isClientError: true },
      { client: undefined },
      { client: { account: { address: OTHER_ACCOUNT }, chain: { id: 1 }, transport } },
      { client: { account: { address: ACCOUNT }, chain: { id: 8453 }, transport } },
      // A wallet provider built from an earlier client, before Web3Context's effect caught up.
      { provider: new Web3Provider({ request: jest.fn() }, 1) },
      // The read-only fallback provider cannot sign.
      { provider: new JsonRpcProvider('http://localhost', 1) },
      { provider: undefined },
    ];
    for (const setup of cases) {
      setSession(setup);
      rerender({ market: USDC_MARKET, registry: OPEN_REGISTRY });
      expect(wrapped(result.current).deposit).toEqual(blocked('no-signer'));
    }
  });

  it('asks a wallet on a chain the app does not configure to switch to Ethereum', () => {
    mockUseEthersProvider.mockReturnValue(chainProvider().provider);
    // wagmi gives the connector client no chain when the wallet's chain is not configured.
    setSession({
      chainId: 56,
      client: { account: { address: ACCOUNT }, chain: undefined, transport: { request: jest.fn() } },
    });
    const { result } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
    expect(wrapped(result.current).deposit).toEqual(blocked('wrong-chain', { requiredChainId: 1 }));
  });

  it.each(['idle', 'checking', 'blocked'] as const)('passes screening status %s through', (screeningStatus) => {
    mockUseEthersProvider.mockReturnValue(chainProvider().provider);
    setSession({ screeningStatus });
    const { result } = renderRoute(USDC_MARKET, OPEN_REGISTRY);
    expect(wrapped(result.current).deposit).toEqual(blocked('screening'));
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

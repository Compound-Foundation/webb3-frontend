import { QueryClient, QueryClientProvider, type Query } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { MarketsProvider, useMarketsContext } from '@contexts/MarketsContext';
import { latestMarketSummaryQueryOptions } from '@helpers/latestMarketSummary';
import { fetchMarketRegistry, MARKET_REGISTRY_QUERY_KEY, shouldPersistQuery } from '@helpers/marketRegistry';
import { getLatestMarketSummaryEndpoint, getMarketRegistryEndpoint } from '@helpers/urls';
import { useSelectedMarketState } from '@hooks/useSelectedMarket';
import { StateType } from '@types';

import { rest, server } from '../../handlers/server';
import mockLatestMarketSummaryResponse from '../mocks/mockLatestMarketSummaryResponse.json';
import { MOCK_DEFAULT_MARKET, MOCK_MARKET_REGISTRY, MOCK_MARKETS, MockMarketsProvider } from '../mocks/mockMarkets';
import { mockWeb3 } from '../mocks/mockWeb3';

const renderMarketsContext = (queryClient: QueryClient) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MarketsProvider>{children}</MarketsProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useMarketsContext(), { wrapper });
};

describe('MarketsProvider', () => {
  test('is loading until the registry arrives, then exposes its markets', async () => {
    const { result } = renderMarketsContext(new QueryClient());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.markets).toEqual([]);
    expect(result.current.defaultMarket).toBeUndefined();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.markets).toEqual(MOCK_MARKETS);
    expect(result.current.defaultMarket).toEqual(MOCK_DEFAULT_MARKET);
    expect(result.current.registryVersionId).toEqual(MOCK_MARKET_REGISTRY.registryVersion.id);
    expect(result.current.getMarketDescriptors(MOCK_DEFAULT_MARKET.marketAddress, 1)).toEqual([
      'USDC',
      'Ethereum',
      'USD Coin',
    ]);
  });

  test('serves cached registry data immediately', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(MARKET_REGISTRY_QUERY_KEY, MOCK_MARKET_REGISTRY);
    const { result } = renderMarketsContext(queryClient);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.markets).toEqual(MOCK_MARKETS);
  });

  test('keeps cached data when a refetch fails', async () => {
    server.use(rest.get(getMarketRegistryEndpoint(), (_req, res, ctx) => res(ctx.status(500))));
    const queryClient = new QueryClient();
    queryClient.setQueryData(MARKET_REGISTRY_QUERY_KEY, MOCK_MARKET_REGISTRY, { updatedAt: 0 });
    const { result } = renderMarketsContext(queryClient);
    await waitFor(() =>
      expect(queryClient.getQueryState(MARKET_REGISTRY_QUERY_KEY)?.fetchFailureCount).toBeGreaterThan(0),
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.markets).toEqual(MOCK_MARKETS);
    // Stop the provider's endless retries so they don't outlive the test
    await queryClient.cancelQueries();
  });

  test('does not crash when the cached registry fails to map, and reports loading instead', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const queryClient = new QueryClient();
    queryClient.setQueryData(MARKET_REGISTRY_QUERY_KEY, { ...MOCK_MARKET_REGISTRY, networks: null });

    let result: ReturnType<typeof renderMarketsContext>['result'] | undefined;
    expect(() => {
      result = renderMarketsContext(queryClient).result;
    }).not.toThrow();

    expect(result?.current.isLoading).toBe(true);
    expect(result?.current.markets).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    await queryClient.cancelQueries();
    queryClient.clear();
  });
});

describe('MarketsProvider market statuses', () => {
  const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
  const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
  const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

  test('exposes market and collateral statuses from the latest summary', async () => {
    server.use(
      rest.get(getLatestMarketSummaryEndpoint(), (_req, res, ctx) =>
        res(
          ctx.json(
            mockLatestMarketSummaryResponse.map((summary) =>
              summary.comet.address === USDC_COMET.toLowerCase()
                ? { ...summary, status: 'error', collaterals: [{ address: WBTC, symbol: 'WBTC', status: 'error' }] }
                : summary
            )
          )
        )
      )
    );

    const { result } = renderMarketsContext(newQueryClient());

    await waitFor(() => expect(result.current.getMarketStatus(1, USDC_COMET)).toBe('error'));
    expect(result.current.getCollateralStatus(1, USDC_COMET, WBTC.toLowerCase())).toBe('error');
  });

  test('reports no statuses when the summary request fails', async () => {
    server.use(rest.get(getLatestMarketSummaryEndpoint(), (_req, res, ctx) => res(ctx.status(500))));
    const queryClient = newQueryClient();

    const { result } = renderMarketsContext(queryClient);

    await waitFor(() =>
      expect(queryClient.getQueryState(latestMarketSummaryQueryOptions.queryKey)?.status).toBe('error')
    );
    expect(result.current.getMarketStatus(1, USDC_COMET)).toBeUndefined();
    await queryClient.cancelQueries();
  });
});

describe('fetchMarketRegistry', () => {
  test('rejects on an HTTP error', async () => {
    server.use(rest.get(getMarketRegistryEndpoint(), (_req, res, ctx) => res(ctx.status(500))));
    await expect(fetchMarketRegistry()).rejects.toThrow('500');
  });

  test('rejects an invalid body', async () => {
    server.use(rest.get(getMarketRegistryEndpoint(), (_req, res, ctx) => res(ctx.json({ schemaVersion: 2 }))));
    await expect(fetchMarketRegistry()).rejects.toThrow();
  });
});

describe('useSelectedMarketState with the market registry', () => {
  const renderSelectedMarket = (isLoading: boolean, initialEntry: string) => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[initialEntry]}>
        <MockMarketsProvider isLoading={isLoading}>{children}</MockMarketsProvider>
      </MemoryRouter>
    );
    return renderHook(() => useSelectedMarketState(mockWeb3), { wrapper });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  test('stays in the loading state while the registry is loading', () => {
    const { result } = renderSelectedMarket(true, '/');

    expect(result.current.selectedMarket).toEqual([StateType.Loading, undefined]);
    expect(mockWeb3.switchReadNetwork).not.toHaveBeenCalled();
  });

  test('selects the market from the URL once the registry has loaded', async () => {
    const { result } = renderSelectedMarket(false, '/?market=weth-mainnet');

    await waitFor(() => expect(mockWeb3.switchReadNetwork).toHaveBeenCalledWith(1));
    await waitFor(() => expect(result.current.selectedMarket[1]?.baseAsset.symbol).toEqual('ETH'));
    expect(result.current.selectedMarket[1]?.chainInformation.chainId).toEqual(1);
  });
});

describe('shouldPersistQuery', () => {
  const query = (queryKey: unknown[], status: string) => ({ queryKey, state: { status } }) as unknown as Query;

  test('persists only a successful registry query', () => {
    expect(shouldPersistQuery(query(['marketRegistry'], 'success'))).toBe(true);
    expect(shouldPersistQuery(query(['marketRegistry'], 'error'))).toBe(false);
    expect(shouldPersistQuery(query(['marketOverviewState'], 'success'))).toBe(false);
  });
});

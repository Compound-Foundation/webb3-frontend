import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { MarketsProvider, useMarketsContext } from '@contexts/MarketsContext';
import { convertApiResponse } from '@helpers/functions';
import { latestMarketSummaryQueryOptions } from '@helpers/latestMarketSummary';
import { MARKET_LIST_QUERY_KEY, MarketListEntry, summaryToMarkets } from '@helpers/marketList';
import { getLatestMarketSummaryEndpoint } from '@helpers/urls';
import { useSelectedMarketState } from '@hooks/useSelectedMarket';
import { StateType } from '@types';

import { rest, server } from '../../handlers/server';
import mockLatestMarketSummaryResponse from '../mocks/mockLatestMarketSummaryResponse.json';
import { MOCK_MARKET_LIST, MOCK_MARKETS, MockMarketsProvider } from '../mocks/mockMarkets';
import { mockWeb3 } from '../mocks/mockWeb3';

const renderMarketsContext = (queryClient: QueryClient) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MarketsProvider>{children}</MarketsProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useMarketsContext(), { wrapper });
};

// The markets of the summary MSW serves
const SUMMARY_MARKET_LIST = summaryToMarkets(mockLatestMarketSummaryResponse.map(convertApiResponse) as MarketListEntry[]);

describe('MarketsProvider', () => {
  test('is loading until the summary arrives, then exposes its markets', async () => {
    const { result } = renderMarketsContext(new QueryClient());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.markets).toEqual([]);
    expect(result.current.defaultMarket).toBeUndefined();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.markets).toEqual(SUMMARY_MARKET_LIST.markets);
    expect(result.current.defaultMarket).toEqual(SUMMARY_MARKET_LIST.defaultMarket);
    expect(result.current.getMarketDescriptors(SUMMARY_MARKET_LIST.defaultMarket.marketAddress, 1)).toEqual([
      'USDC',
      'Ethereum',
      'USD Coin',
    ]);
  });

  test('serves the cached market list immediately', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(MARKET_LIST_QUERY_KEY, MOCK_MARKET_LIST);
    const { result } = renderMarketsContext(queryClient);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.markets).toEqual(MOCK_MARKETS);
  });

  test('keeps the cached market list when a refetch fails', async () => {
    server.use(rest.get(getLatestMarketSummaryEndpoint(), (_req, res, ctx) => res(ctx.status(500))));
    const queryClient = new QueryClient();
    queryClient.setQueryData(MARKET_LIST_QUERY_KEY, MOCK_MARKET_LIST, { updatedAt: 0 });
    const { result } = renderMarketsContext(queryClient);
    await waitFor(() =>
      expect(queryClient.getQueryState(MARKET_LIST_QUERY_KEY)?.fetchFailureCount).toBeGreaterThan(0),
    );
    expect(result.current.isLoading).toBe(false);
    expect(result.current.markets).toEqual(MOCK_MARKETS);
    // Stop the provider's endless retries so they don't outlive the test
    await queryClient.cancelQueries();
  });

  test('does not crash when the cached market list fails to map, and reports loading instead', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const queryClient = new QueryClient();
    queryClient.setQueryData(MARKET_LIST_QUERY_KEY, [{ chainId: 1, comet: { address: 'not-an-address' } }]);

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

describe('useSelectedMarketState with the market list', () => {
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

  test('stays in the loading state while the market list is loading', () => {
    const { result } = renderSelectedMarket(true, '/');

    expect(result.current.selectedMarket).toEqual([StateType.Loading, undefined]);
    expect(mockWeb3.switchReadNetwork).not.toHaveBeenCalled();
  });

  test('selects the market from the URL once the market list has loaded', async () => {
    const { result } = renderSelectedMarket(false, '/?market=weth-mainnet');

    await waitFor(() => expect(mockWeb3.switchReadNetwork).toHaveBeenCalledWith(1));
    await waitFor(() => expect(result.current.selectedMarket[1]?.baseAsset.symbol).toEqual('ETH'));
    expect(result.current.selectedMarket[1]?.chainInformation.chainId).toEqual(1);
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { convertApiResponse } from '@helpers/functions';
import { getLatestMarketSummaryEndpoint } from '@helpers/urls';
import { summaryToMarkets, useMarkets } from '@hooks/useMarkets';
import { useSelectedMarketState } from '@hooks/useSelectedMarket';
import { LatestMarketSummaryResponse, StateType } from '@types';

import { rest, server } from '../../handlers/server';
import { LEGACY_ADDRESSES } from '../mocks/legacyMarketAddresses';
import mockLatestMarketSummaryResponse from '../mocks/mockLatestMarketSummaryResponse.json';
import { MockMarketsProvider } from '../mocks/mockMarkets';
import { mockWeb3 } from '../mocks/mockWeb3';

const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const renderMarkets = (queryClient: QueryClient) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useMarkets(), { wrapper });
};

// The markets of the summary MSW serves
const SUMMARIES = mockLatestMarketSummaryResponse.map(convertApiResponse) as LatestMarketSummaryResponse[];
const SUMMARY_MARKET_LIST = summaryToMarkets(SUMMARIES);

describe('useMarkets', () => {
  test('is loading until the summary arrives, then exposes its markets', async () => {
    const { result } = renderMarkets(newQueryClient());
    expect(result.current).toEqual([StateType.Loading, { loadFailed: false }]);

    await waitFor(() => expect(result.current[0]).toBe(StateType.Hydrated));
    if (result.current[0] !== StateType.Hydrated) throw new Error('not hydrated');
    const { markets, defaultMarket, summaries } = result.current[1];
    expect(markets).toEqual(SUMMARY_MARKET_LIST.markets);
    expect(defaultMarket).toEqual(SUMMARY_MARKET_LIST.defaultMarket);
    expect(summaries).toEqual(SUMMARIES);
  });

  test('exposes market and collateral statuses from the latest summary', async () => {
    const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
    const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
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

    const { result } = renderMarkets(newQueryClient());

    await waitFor(() => expect(result.current[0]).toBe(StateType.Hydrated));
    if (result.current[0] !== StateType.Hydrated) throw new Error('not hydrated');
    const usdc = result.current[1].markets.find((market) => market.marketAddress === USDC_COMET);
    expect(usdc?.status).toBe('error');
    expect(usdc?.collaterals).toEqual([{ address: WBTC, symbol: 'WBTC', status: 'error' }]);
  });

  test('reports a failed load when the summary request fails', async () => {
    server.use(rest.get(getLatestMarketSummaryEndpoint(), (_req, res, ctx) => res(ctx.status(500))));

    const { result } = renderMarkets(newQueryClient());

    await waitFor(() => expect(result.current).toEqual([StateType.Loading, { loadFailed: true }]));
  });

  test('reports a failed load when the summary has no supported markets', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    server.use(
      rest.get(getLatestMarketSummaryEndpoint(), (_req, res, ctx) =>
        res(ctx.json([{ chain_id: 1, comet: { address: LEGACY_ADDRESSES.mainnetUSDC.comet }, status: 'success' }]))
      )
    );

    const { result } = renderMarkets(newQueryClient());

    await waitFor(() => expect(result.current).toEqual([StateType.Loading, { loadFailed: true }]));
    warn.mockRestore();
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

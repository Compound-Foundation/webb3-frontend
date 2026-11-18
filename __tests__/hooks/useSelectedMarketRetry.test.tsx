import { BigNumber } from '@ethersproject/bignumber';
import { JsonRpcProvider } from '@ethersproject/providers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import { REFRESH_INTERVAL } from '@helpers/numbers';
import { LATEST_MARKET_SUMMARY_QUERY_KEY } from '@hooks/useMarkets';
import { useSelectedMarketState } from '@hooks/useSelectedMarket';
import { MarketStatus, StateType } from '@types';

import { MOCK_DEFAULT_MARKET, MOCK_MARKET_LIST } from '../mocks/mockMarkets';
import { mockWeb3 } from '../mocks/mockWeb3';

const mockSleuthFetch = jest.fn();
jest.mock('@helpers/sleuth/sleuth', () => {
  const Sleuth = jest.fn().mockImplementation(() => ({ fetch: (...args: unknown[]) => mockSleuthFetch(...args) }));
  return { Sleuth: Object.assign(Sleuth, { querySol: jest.fn(() => 'query') }) };
});

const cometResponse = {
  baseAsset: {
    baseAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: BigNumber.from(6),
    minBorrow: BigNumber.from(0),
    name: 'USD Coin',
    priceFeed: '0x0000000000000000000000000000000000000001',
    symbol: 'USDC',
  },
  baseMinForRewards: BigNumber.from(0),
  baseTrackingBorrowSpeed: BigNumber.from(0),
  baseTrackingSupplySpeed: BigNumber.from(0),
  collateralAssets: [],
  trackingIndexScale: BigNumber.from(0),
};

const web3 = {
  ...mockWeb3,
  read: { ...mockWeb3.read, provider: { connection: { url: 'http://localhost' } } as unknown as JsonRpcProvider },
};

const summariesWithDefaultStatus = (status: MarketStatus) =>
  MOCK_MARKET_LIST.map((entry) =>
    entry.comet.address.toLowerCase() === MOCK_DEFAULT_MARKET.marketAddress.toLowerCase()
      ? { ...entry, status }
      : entry,
  );

beforeEach(() => {
  jest.useFakeTimers();
  window.localStorage.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

test('a retry that succeeds after the market list recovered keeps the refreshed status', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryDefaults(LATEST_MARKET_SUMMARY_QUERY_KEY, { enabled: false });
  queryClient.setQueryData(LATEST_MARKET_SUMMARY_QUERY_KEY, summariesWithDefaultStatus('error'));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={['/?market=usdc-mainnet']}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );

  mockSleuthFetch.mockRejectedValueOnce(new Error('base price feed reverted'));
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result } = renderHook(() => useSelectedMarketState(web3), { wrapper });

  await waitFor(() => expect(mockSleuthFetch).toHaveBeenCalledTimes(1));

  mockSleuthFetch.mockResolvedValue(cometResponse);
  act(() => {
    queryClient.setQueryData(LATEST_MARKET_SUMMARY_QUERY_KEY, summariesWithDefaultStatus('success'));
  });
  await waitFor(() => expect(result.current.selectedMarket[1]?.status).toBe('success'));

  await act(async () => {
    jest.advanceTimersByTime(REFRESH_INTERVAL);
  });

  await waitFor(() => expect(result.current.selectedMarket[0]).toBe(StateType.Hydrated));
  expect(result.current.selectedMarket[1]?.status).toBe('success');
});

import { renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import RewardsStateContext from '@contexts/RewardsStateContext';
import { Web3 } from '@contexts/Web3Context';
import { getMarkets } from '@helpers/markets';
import { getMarketDataUrlForMarket } from '@helpers/urls';
import { useMarketsState } from '@pages/markets/hooks/useMarketsState';
import { MarketDataLoaded, MarketDataState, StateType, V3MarketApiBucket } from '@types';

import { rest, server } from '../../../../handlers/server';

// On-chain reads return the value set in mockReads for that contract function, or 1e18,
// which is enough for the hook to build its state without a node
let mockReads: Record<string, bigint> = {};

jest.mock('ethers-multicall', () => {
  const { BigNumber } = jest.requireActual('@ethersproject/bignumber');
  return {
    Contract: jest.fn(() => new Proxy({}, { get: (_target, name) => () => name })),
    Provider: jest.fn(() => ({
      all: (calls: string[]) =>
        Promise.resolve(calls.map((name) => BigNumber.from((mockReads[name] ?? 10n ** 18n).toString()))),
    })),
  };
});

jest.mock('@ethersproject/providers', () => ({
  ...jest.requireActual('@ethersproject/providers'),
  StaticJsonRpcProvider: jest.fn(),
}));

const marketData = getMarkets(false).find((market) => market.chainInformation.chainId === 1 && !market.rewardsOverwrite);

if (marketData === undefined) {
  throw new Error('Expected a mainnet market without a rewards overwrite');
}

const market: MarketDataLoaded = {
  ...marketData,
  baseAsset: {
    ...marketData.baseAsset,
    address: '0x0000000000000000000000000000000000000001',
    decimals: 6,
    minBorrow: 0n,
    priceFeed: '0x0000000000000000000000000000000000000002',
  },
  baseMinForRewards: 0n,
  baseTrackingSupplySpeed: 0n,
  baseTrackingBorrowSpeed: 0n,
  collateralAssets: [],
  trackingIndexScale: 0n,
  type: 'MarketDataLoaded',
};

const marketState: MarketDataState = [StateType.Hydrated, market];
const web3 = { read: { provider: {} } } as unknown as Web3;

const Wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <RewardsStateContext.Provider value={[StateType.Hydrated, []]}>{children}</RewardsStateContext.Provider>
  </MemoryRouter>
);

const serveHistory = (buckets: V3MarketApiBucket[]) =>
  server.use(
    rest.get(`${getMarketDataUrlForMarket(market)}/historical/summary`, (_req, res, ctx) => res(ctx.json(buckets)))
  );

const renderMarketState = async () => {
  const { result } = renderHook(() => useMarketsState(web3, marketState), { wrapper: Wrapper });
  await waitFor(() => expect(result.current[0]).toEqual(StateType.Hydrated));

  if (result.current[0] !== StateType.Hydrated || result.current[1].type !== 'ProtocolAndMarketState') {
    throw new Error('Expected a hydrated market state');
  }
  return result.current[1];
};

const renderMarketHistory = async () => (await renderMarketState()).marketHistory;

afterEach(() => {
  mockReads = {};
});

describe('useMarketsState current APRs', () => {
  test('are the base rates when nothing is borrowed', async () => {
    const secondsPerYear = 31_536_000n;
    mockReads = {
      getUtilization: 0n,
      borrowPerSecondInterestRateBase: 475_646_879n,
      supplyPerSecondInterestRateBase: 317_097_919n,
    };

    const { borrowAPR, earnAPR } = await renderMarketState();

    expect(borrowAPR).toEqual(475_646_879n * secondsPerYear);
    expect(earnAPR).toEqual(317_097_919n * secondsPerYear);
  });
});

describe('useMarketsState history APRs', () => {
  test('parses the backend decimal APR strings at 18 decimals', async () => {
    serveHistory([
      {
        timestamp: 1_700_086_400,
        total_collateral_value: 2_000,
        total_borrow_value: 900,
        supply_apr: '0.123456789012345678',
        borrow_apr: '0.0',
      },
      {
        timestamp: 1_700_000_000,
        total_collateral_value: 1_000,
        total_borrow_value: 500,
        supply_apr: '0.0370178264052',
        borrow_apr: '0.0452017566288',
      },
    ]);

    expect(await renderMarketHistory()).toEqual([
      {
        blockTimestamp: 1_700_000_000_000,
        supplyTotal: 1_000,
        borrowTotal: 500,
        supplyRate: 37_017_826_405_200_000n,
        borrowRate: 45_201_756_628_800_000n,
      },
      {
        blockTimestamp: 1_700_086_400_000,
        supplyTotal: 2_000,
        borrowTotal: 900,
        supplyRate: 123_456_789_012_345_678n,
        borrowRate: 0n,
      },
    ]);
  });

  test('drops the whole history when an APR is not a decimal string', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    serveHistory([
      {
        timestamp: 1_700_000_000,
        total_collateral_value: 1_000,
        total_borrow_value: 500,
        supply_apr: '0.0370178264052',
        borrow_apr: '1e-7',
      },
    ]);

    expect(await renderMarketHistory()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('Error fetching historical market data: ', expect.any(Error));
  });
});

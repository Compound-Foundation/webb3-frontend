import { BigNumber } from '@ethersproject/bignumber';
import { renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import RewardsStateContext from '@contexts/RewardsStateContext';
import { Web3 } from '@contexts/Web3Context';
import { getMarkets } from '@helpers/markets';
import { CometStateResponse, CometWithReservesResponse, RateModelResponse } from '@helpers/sleuth/types';
import { getMarketDataUrlForMarket } from '@helpers/urls';
import { useMarketsState } from '@pages/markets/hooks/useMarketsState';
import { MarketDataLoaded, MarketDataState, StateType, V3MarketApiBucket } from '@types';

import { rest, server } from '../../../../handlers/server';

const mockSleuthFetch = jest.fn();
jest.mock('@helpers/sleuth/sleuth', () => {
  const Sleuth = jest.fn().mockImplementation(() => ({ fetch: (...args: unknown[]) => mockSleuthFetch(...args) }));
  return { Sleuth: Object.assign(Sleuth, { querySol: jest.fn(() => 'query') }) };
});

const mockReadContract = jest.fn();
jest.mock('@helpers/multicall', () => ({
  ...jest.requireActual('@helpers/multicall'),
  readClient: () => ({ readContract: (...args: unknown[]) => mockReadContract(...args) }),
}));

jest.mock('@ethersproject/providers', () => ({
  ...jest.requireActual('@ethersproject/providers'),
  StaticJsonRpcProvider: jest.fn(),
}));

const ONE = BigNumber.from((10n ** 18n).toString());

const rateModel = (base: bigint): RateModelResponse => ({
  kink: ONE,
  perSecondInterestRateBase: BigNumber.from(base.toString()),
  perSecondInterestRateSlopeLow: ONE,
  perSecondInterestRateSlopeHigh: ONE,
});

// Every number is 1e18 unless a test overrides it, which is enough for the hook to build its state
const cometResponse = (overrides: Partial<CometStateResponse> = {}) =>
  ({
    state: {
      baseAsset: { price: ONE, balanceOfComet: ONE },
      borrowRateModel: rateModel(10n ** 18n),
      collateralAssets: [],
      factorScale: ONE,
      nativeAssetInDollars: ONE,
      supplyRateModel: rateModel(10n ** 18n),
      totalBorrow: ONE,
      totalSupply: ONE,
      utilization: ONE,
      ...overrides,
    },
    reserves: ONE,
    targetReserves: ONE,
    collateralReserves: [],
  } as unknown as CometWithReservesResponse);

const marketData = getMarkets(false).find(
  (market) => market.chainInformation.chainId === 1 && !market.rewardsOverwrite
);

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

const renderMarketState = async (state: MarketDataState = marketState) => {
  const { result } = renderHook(() => useMarketsState(web3, state), { wrapper: Wrapper });
  await waitFor(() => expect(result.current[0]).toEqual(StateType.Hydrated));

  if (result.current[0] !== StateType.Hydrated || result.current[1].type !== 'ProtocolAndMarketState') {
    throw new Error('Expected a hydrated market state');
  }
  return result.current[1];
};

const renderMarketHistory = async () => (await renderMarketState()).marketHistory;

beforeEach(() => {
  mockSleuthFetch.mockResolvedValue(cometResponse());
});

describe('useMarketsState current APRs', () => {
  test('are the base rates when nothing is borrowed', async () => {
    const secondsPerYear = 31_536_000n;
    mockSleuthFetch.mockResolvedValue(
      cometResponse({
        utilization: BigNumber.from(0),
        borrowRateModel: rateModel(475_646_879n),
        supplyRateModel: rateModel(317_097_919n),
      })
    );

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

describe('useMarketsState when the Sleuth query fails', () => {
  const COLLATERAL_A = '0x00000000000000000000000000000000000000a1';
  const COLLATERAL_B = '0x00000000000000000000000000000000000000b1';
  const collateral = (address: string) =>
    ({ address, liquidationFactor: 9n * 10n ** 17n } as unknown as MarketDataLoaded['collateralAssets'][number]);
  const collateralInfo = (collateralAsset: string) => ({ collateralAsset, price: ONE, totalSupply: ONE });

  test('reads the state with query() and the reserves through readContract, skipping a collateral whose reserves revert', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const withCollaterals: MarketDataLoaded = {
      ...market,
      collateralAssets: [collateral(COLLATERAL_A), collateral(COLLATERAL_B)],
    };
    mockSleuthFetch.mockRejectedValueOnce(new Error('queryWithReserves reverted')).mockResolvedValueOnce(
      cometResponse({
        collateralAssets: [collateralInfo(COLLATERAL_A), collateralInfo(COLLATERAL_B)],
      } as unknown as Partial<CometStateResponse>).state
    );
    mockReadContract
      .mockResolvedValueOnce(7n)
      .mockResolvedValueOnce(8n)
      .mockResolvedValueOnce(9n)
      .mockRejectedValueOnce(new Error('getCollateralReserves reverted'));

    const state = await renderMarketState([StateType.Hydrated, withCollaterals]);

    expect(state.reserves).toEqual(7n);
    expect(state.targetReserves).toEqual(8n);
    expect(state.collateralAssets.map(({ address, reserves }) => [address, reserves])).toEqual([[COLLATERAL_A, 9n]]);
    expect(mockReadContract.mock.calls.map(([{ functionName }]) => functionName)).toEqual([
      'getReserves',
      'targetReserves',
      'getCollateralReserves',
      'getCollateralReserves',
    ]);
  });
});

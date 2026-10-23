import { JsonRpcProvider } from '@ethersproject/providers';
import { act, renderHook } from '@testing-library/react';
import { BigNumber } from 'ethers';

import { Web3 } from '@contexts/Web3Context';
import { useCometState } from '@hooks/useCometState';
import { queryCometData } from '@hooks/useSelectedMarket';
import { MarketData, MarketDataState, RewardsState, StateType, Transaction } from '@types';

import { mockMarket } from '../mocks/mockMarket';
import { mockWeb3NoWallet } from '../mocks/mockWeb3';

jest.mock('@hooks/useSelectedMarket', () => ({
  ...jest.requireActual('@hooks/useSelectedMarket'),
  queryCometData: jest.fn(),
}));

// Holds back every state update, as useWaiter does while a transaction is pending.
const heldUpdates: (() => Promise<void>)[] = [];
jest.mock('@hooks/useWaiter', () => ({
  useWaiter: () => ({
    waitFor: (_check: unknown, run: () => Promise<void>) => {
      heldUpdates.push(run);
    },
  }),
}));

// The per-account query goes through Sleuth. It never answers here, so only the queries the
// tests resolve can update the state.
jest.mock('@helpers/sleuth/sleuth', () => {
  const Sleuth = jest.fn().mockImplementation(() => ({ fetch: () => new Promise(() => undefined) }));
  return { Sleuth: Object.assign(Sleuth, { querySol: jest.fn(() => 'query') }) };
});

const mockQueryCometData = queryCometData as jest.Mock;

const cometResponse = (earnAPR: number) => ({
  totalSupply: BigNumber.from(0),
  totalBorrow: BigNumber.from(0),
  nativeAssetInDollars: BigNumber.from(0),
  borrowAPR: BigNumber.from(0),
  earnAPR: BigNumber.from(earnAPR),
  collateralAssets: [],
  baseAsset: {
    baseAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: BigNumber.from(6),
    minBorrow: BigNumber.from(0),
    priceFeed: '0x0000000000000000000000000000000000000001',
    balanceOfComet: BigNumber.from(0),
    price: BigNumber.from(100_000_000),
  },
});

const MARKET_A: MarketData = mockMarket({ marketAddress: '0x00000000000000000000000000000000000000aa' });
const MARKET_B: MarketData = mockMarket({ marketAddress: '0x00000000000000000000000000000000000000bb' });
const WEB3: Web3 = {
  ...mockWeb3NoWallet,
  read: {
    ...mockWeb3NoWallet.read,
    account: undefined,
    chainId: MARKET_A.chainInformation.chainId,
    provider: { connection: { url: 'http://localhost' } } as unknown as JsonRpcProvider,
  },
};
const REWARDS: RewardsState = [StateType.Loading];
const PENDING: Transaction[] = [];

describe('useCometState', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    heldUpdates.length = 0;
    mockQueryCometData.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('drops a held-back result for a market that is no longer selected', async () => {
    mockQueryCometData.mockResolvedValue(cometResponse(111));
    const { result, rerender } = renderHook(
      ({ market }: { market: MarketDataState }) => useCometState(WEB3, market, PENDING, REWARDS),
      { initialProps: { market: [StateType.Hydrated, MARKET_A] as MarketDataState } }
    );

    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(heldUpdates).toHaveLength(1);

    // The user switches markets while market A's result waits for a transaction to settle.
    mockQueryCometData.mockReturnValue(new Promise(() => undefined));
    rerender({ market: [StateType.Hydrated, MARKET_B] });
    expect(result.current[0]).toBe(StateType.Loading);

    await act(async () => {
      await heldUpdates[0]();
    });
    expect(result.current[0]).toBe(StateType.Loading);
  });

  it('applies a held-back result for the market still selected', async () => {
    mockQueryCometData.mockResolvedValue(cometResponse(111));
    const { result } = renderHook(() => useCometState(WEB3, [StateType.Hydrated, MARKET_A], PENDING, REWARDS));

    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    await act(async () => {
      await heldUpdates[0]();
    });

    expect(result.current[0]).toBe(StateType.NoWallet);
    expect(result.current[1]?.earnAPR).toBe(111n);
  });

  it('drops a held-back result read for an account that is no longer connected', async () => {
    mockQueryCometData.mockResolvedValue(cometResponse(111));
    const { result, rerender } = renderHook(
      ({ web3 }: { web3: Web3 }) => useCometState(web3, [StateType.Hydrated, MARKET_A], PENDING, REWARDS),
      { initialProps: { web3: WEB3 } }
    );

    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(heldUpdates).toHaveLength(1);

    // An account connects while the result read without one waits for a transaction to settle.
    rerender({ web3: { ...WEB3, read: { ...WEB3.read, account: '0x00000000000000000000000000000000000000b2' } } });
    await act(async () => {
      await heldUpdates[0]();
    });

    expect(result.current[0]).toBe(StateType.Loading);
  });
});

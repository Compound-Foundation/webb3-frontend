import { JsonRpcProvider } from '@ethersproject/providers';
import { act, renderHook } from '@testing-library/react';
import { BigNumber } from 'ethers';

import { Web3 } from '@contexts/Web3Context';
import { REFRESH_INTERVAL } from '@helpers/numbers';
import { useCometState } from '@hooks/useCometState';
import { queryCometData } from '@hooks/useSelectedMarket';
import { MarketData, MarketDataState, RewardsState, StateType, Transaction, TransactionState } from '@types';

import { mockMarket } from '../mocks/mockMarket';
import { mockWeb3NoWallet } from '../mocks/mockWeb3';

// uuid ships ESM only, which Jest does not load here.
jest.mock('uuid', () => ({ v4: () => 'transaction' }));

jest.mock('@hooks/useSelectedMarket', () => ({
  ...jest.requireActual('@hooks/useSelectedMarket'),
  queryCometData: jest.fn(),
}));

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

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const WRAPPER = '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73';
const COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const HASH = `0x${'ab'.repeat(32)}`;

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

/** A wrapper step's wallet request with no hash that nothing can follow, as after a reload. */
const INTERRUPTED_WRAPPER_REQUEST: Transaction = {
  id: 'interrupted',
  key: WRAPPER,
  networkId: 1,
  networkName: 'homestead',
  description: 'Supply USDC through the wrapper',
  nonce: 7,
  account: ACCOUNT,
  step: 'supply',
  state: TransactionState.AwaitingConfirmation,
  isInterrupted: true,
};

type Props = { market: MarketDataState; transactions: Transaction[] };

function renderCometState(initialProps: Props) {
  return renderHook(({ market, transactions }: Props) => useCometState(WEB3, market, transactions, REWARDS), {
    initialProps,
  });
}

/** Lets the first read, which waits 0.5 seconds for an account, run and resolve. */
async function runFirstRead() {
  await act(async () => {
    jest.advanceTimersByTime(500);
  });
}

describe('useCometState refresh barrier', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockQueryCometData.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hydrates a newly selected market while an interrupted wrapper request is tracked', async () => {
    mockQueryCometData.mockResolvedValue(cometResponse(111));
    const transactions = [INTERRUPTED_WRAPPER_REQUEST];
    const { result, rerender } = renderCometState({ market: [StateType.Hydrated, MARKET_A], transactions });
    await runFirstRead();

    mockQueryCometData.mockResolvedValue(cometResponse(222));
    rerender({ market: [StateType.Hydrated, MARKET_B], transactions });
    expect(result.current[0]).toBe(StateType.Loading);
    await runFirstRead();

    expect(result.current[0]).toBe(StateType.NoWallet);
    expect(result.current[1]?.earnAPR).toBe(222n);
  });

  it('keeps refreshing the selected market while an interrupted wrapper request is tracked', async () => {
    mockQueryCometData.mockResolvedValue(cometResponse(111));
    const { result } = renderCometState({
      market: [StateType.Hydrated, MARKET_A],
      transactions: [INTERRUPTED_WRAPPER_REQUEST],
    });
    await runFirstRead();
    expect(result.current[1]?.earnAPR).toBe(111n);

    mockQueryCometData.mockResolvedValue(cometResponse(333));
    await act(async () => {
      jest.advanceTimersByTime(REFRESH_INTERVAL);
    });

    expect(result.current[0]).toBe(StateType.NoWallet);
    expect(result.current[1]?.earnAPR).toBe(333n);
  });

  it.each<[string, Transaction]>([
    [
      'a broadcast standard transaction',
      {
        ...INTERRUPTED_WRAPPER_REQUEST,
        id: 'standard',
        key: COMET,
        step: undefined,
        isInterrupted: undefined,
        state: TransactionState.Pending,
        hash: HASH,
      } as Transaction,
    ],
    [
      'a broadcast wrapper transaction',
      {
        ...INTERRUPTED_WRAPPER_REQUEST,
        isInterrupted: undefined,
        state: TransactionState.Pending,
        hash: HASH,
      } as Transaction,
    ],
    ['a live wrapper request', { ...INTERRUPTED_WRAPPER_REQUEST, isInterrupted: false }],
    ['a live standard request', { ...INTERRUPTED_WRAPPER_REQUEST, key: COMET, step: undefined, isInterrupted: false }],
    [
      'a record keyed to a contract that is not a wrapper, marked interrupted',
      { ...INTERRUPTED_WRAPPER_REQUEST, key: COMET },
    ],
    ['a wrapper record with no step, marked interrupted', { ...INTERRUPTED_WRAPPER_REQUEST, step: undefined }],
    ['an interrupted wrapper request carrying a hash', { ...INTERRUPTED_WRAPPER_REQUEST, hash: HASH } as Transaction],
  ])('holds the refresh until %s settles', async (_name, transaction) => {
    mockQueryCometData.mockResolvedValue(cometResponse(111));
    const { result, rerender } = renderCometState({
      market: [StateType.Hydrated, MARKET_A],
      transactions: [transaction],
    });
    await runFirstRead();
    expect(result.current[0]).toBe(StateType.Loading);

    await act(async () => {
      rerender({ market: [StateType.Hydrated, MARKET_A], transactions: [] });
    });

    expect(result.current[0]).toBe(StateType.NoWallet);
    expect(result.current[1]?.earnAPR).toBe(111n);
  });

  it('applies a held refresh once a live wrapper request is marked interrupted', async () => {
    mockQueryCometData.mockResolvedValue(cometResponse(111));
    const liveRequest: Transaction = { ...INTERRUPTED_WRAPPER_REQUEST, isInterrupted: false };
    const { result, rerender } = renderCometState({
      market: [StateType.Hydrated, MARKET_A],
      transactions: [liveRequest],
    });
    await runFirstRead();
    expect(result.current[0]).toBe(StateType.Loading);

    // The manager replaces the record in place, keeping its id, when the wallet's answer is ambiguous.
    await act(async () => {
      rerender({
        market: [StateType.Hydrated, MARKET_A],
        transactions: [{ ...liveRequest, isInterrupted: true }],
      });
    });

    expect(result.current[0]).toBe(StateType.NoWallet);
    expect(result.current[1]?.earnAPR).toBe(111n);
  });

  it('holds the refresh for a broadcast transaction tracked beside an interrupted wrapper request', async () => {
    mockQueryCometData.mockResolvedValue(cometResponse(111));
    const broadcast = {
      ...INTERRUPTED_WRAPPER_REQUEST,
      id: 'standard',
      key: COMET,
      step: undefined,
      isInterrupted: undefined,
      state: TransactionState.Pending,
      hash: HASH,
    } as Transaction;
    const { result, rerender } = renderCometState({
      market: [StateType.Hydrated, MARKET_A],
      transactions: [INTERRUPTED_WRAPPER_REQUEST, broadcast],
    });
    await runFirstRead();
    expect(result.current[0]).toBe(StateType.Loading);

    await act(async () => {
      rerender({ market: [StateType.Hydrated, MARKET_A], transactions: [INTERRUPTED_WRAPPER_REQUEST] });
    });

    expect(result.current[0]).toBe(StateType.NoWallet);
    expect(result.current[1]?.earnAPR).toBe(111n);
  });
});

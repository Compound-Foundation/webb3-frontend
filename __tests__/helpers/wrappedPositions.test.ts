import { Interface } from '@ethersproject/abi';

import { WRAPPED_MARKET_REGISTRY, WrappedMarket } from '@constants/wrappedMarkets';
import CometAbi from '@helpers/abis/Comet';
import { LendingRoute } from '@helpers/lendingRoute';
import { MAX_UINT256 } from '@helpers/numbers';
import {
  CometStateWithMarket,
  isDirectWithdrawalRefused,
  isSameWalletSession,
  isSubmissionRefused,
  getFullExitCash,
  getGrossAssets,
  getRedeemBuffer,
  getWrappedPositionValueInDollars,
  getWrappedRouteWithdrawalLimits,
  readDirectBalance,
  readWrappedPosition,
  supplyIncentivesForRoute,
  waitForBlock,
  withdrawnFromReceipt,
  WrappedPositionReadError,
} from '@helpers/wrappedPositions';
import { WithdrawalLimits } from '@helpers/wrappedWithdrawals';
import { Action, ActionType, CometState, StateType } from '@types';

import { mockBaseAsset } from '../mocks/mockBaseAsset';

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';

function usdcMarket(): WrappedMarket {
  const lookup = WRAPPED_MARKET_REGISTRY.lookup(1, USDC_COMET);
  if (lookup.status !== 'valid') throw new Error('the USDC wrapper mapping must be valid');
  return lookup.market;
}

type ChainValues = {
  shares: bigint;
  totalSupply: bigint;
  totalAssets: bigint;
  asset: string;
  baseSupplyIndex: bigint;
  walletBalance: bigint;
  allowance: bigint;
  isWithdrawPaused: boolean;
};

/** A viem client stand-in whose multicall answers each call by contract address and function name. */
function fakeClient(market: WrappedMarket, values: ChainValues) {
  const answer = (target: string, name: string): unknown => {
    const address = target.toLowerCase();
    if (address === market.wrapperAddress.toLowerCase()) {
      if (name === 'balanceOf') return values.shares;
      if (name === 'totalSupply') return values.totalSupply;
      if (name === 'asset') return values.asset;
    }
    if (address === market.cometAddress.toLowerCase()) {
      if (name === 'balanceOf') return values.totalAssets;
      if (name === 'totalsBasic') return { baseSupplyIndex: values.baseSupplyIndex };
      if (name === 'isWithdrawPaused') return values.isWithdrawPaused;
    }
    if (address === market.baseTokenAddress.toLowerCase()) {
      if (name === 'balanceOf') return values.walletBalance;
      if (name === 'allowance') return values.allowance;
    }
    throw new Error(`unexpected call ${name} on ${target}`);
  };
  const multicall = jest.fn(async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
    contracts.map(({ address, functionName }) => answer(address, functionName))
  );
  return { multicall } as unknown as Parameters<typeof readWrappedPosition>[0] & { multicall: typeof multicall };
}

// 1,000.5 USDC of wrapper assets. With the 10 ** 12 virtual shares, the supply divides into
// 1,000 whole shares, so a quarter of it is worth 250.125 USDC before rounding.
const BASE_VALUES: ChainValues = {
  shares: 250n * 10n ** 18n,
  totalSupply: 1_000n * 10n ** 18n - 10n ** 12n,
  totalAssets: 1_000_500_000n,
  asset: USDC_COMET,
  baseSupplyIndex: 1_050_000_000_000_000n,
  walletBalance: 42_123_456n,
  allowance: 5_000_000n,
  isWithdrawPaused: false,
};

describe('getGrossAssets', () => {
  it('converts 18-decimal shares to 6-decimal assets with the wrapper formula, rounding down', () => {
    // shares * (totalAssets + 1) / (totalSupply + 10 ** (18 - 6)), floored, as OpenZeppelin's
    // `_convertToAssets(shares, Floor)` computes it.
    const expected = (BASE_VALUES.shares * (BASE_VALUES.totalAssets + 1n)) / (BASE_VALUES.totalSupply + 10n ** 12n);
    expect(getGrossAssets(BASE_VALUES.shares, BASE_VALUES.totalSupply, BASE_VALUES.totalAssets, 6)).toBe(expected);
    expect(expected).toBe(250_125_000n);
  });

  it('values one whole share of an empty wrapper at one base unit per 10 ** 12 shares', () => {
    expect(getGrossAssets(10n ** 18n, 0n, 0n, 6)).toBe(1_000_000n);
  });

  it('returns zero for zero shares', () => {
    expect(getGrossAssets(0n, BASE_VALUES.totalSupply, BASE_VALUES.totalAssets, 6)).toBe(0n);
  });
});

describe('getRedeemBuffer and getFullExitCash', () => {
  it('holds back baseSupplyIndex / 1e15 + 2 base units', () => {
    expect(getRedeemBuffer(1_050_000_000_000_000n)).toBe(3n);
    expect(getRedeemBuffer(1_000_999_999_999_999n)).toBe(3n);
  });

  it('pays the gross value less the buffer on a full exit', () => {
    expect(getFullExitCash(250_125_000n, 3n)).toBe(250_124_997n);
  });

  it('pays nothing when the position is worth no more than the buffer', () => {
    expect(getFullExitCash(3n, 3n)).toBe(0n);
    expect(getFullExitCash(2n, 3n)).toBe(0n);
  });
});

describe('getWrappedPositionValueInDollars', () => {
  it('prices underlying base units with the 8-decimal base price, keeping base decimals', () => {
    // 250.125 USDT at $0.9998
    expect(getWrappedPositionValueInDollars(250_125_000n, 99_980_000n, 'USDT')).toBe(250_074_975n);
  });

  it('values USDC at one dollar, as the rest of the app does', () => {
    expect(getWrappedPositionValueInDollars(250_125_000n, 99_980_000n, 'USDC')).toBe(250_125_000n);
  });
});

describe('readWrappedPosition', () => {
  it('reads every figure in one batch and keeps each in its own units', async () => {
    const market = usdcMarket();
    const client = fakeClient(market, BASE_VALUES);

    const position = await readWrappedPosition(client, market, ACCOUNT);

    expect(client.multicall).toHaveBeenCalledTimes(1);
    expect(position).toEqual({
      shares: 250n * 10n ** 18n,
      shareDecimals: 18,
      grossAssets: 250_125_000n,
      baseDecimals: 6,
      baseWalletBalance: 42_123_456n,
      wrapperAllowance: 5_000_000n,
      redeemBuffer: 3n,
      fullExitCash: 250_124_997n,
      isWithdrawPaused: false,
      snapshot: {
        totalSupply: 1_000n * 10n ** 18n - 10n ** 12n,
        totalAssets: 1_000_500_000n,
        baseSupplyIndex: 1_050_000_000_000_000n,
      },
    });
    const { contracts } = client.multicall.mock.calls[0][0];
    // The allowance is the base token's, with the wrapper as spender.
    expect(contracts).toContainEqual(
      expect.objectContaining({
        address: market.baseTokenAddress,
        functionName: 'allowance',
        args: [ACCOUNT, market.wrapperAddress],
      })
    );
    // The wrapper's assets are its Comet balance.
    expect(contracts).toContainEqual(
      expect.objectContaining({
        address: market.cometAddress,
        functionName: 'balanceOf',
        args: [market.wrapperAddress],
      })
    );
  });

  it('fails when the wrapper does not hold the configured Comet, instead of reading zero', async () => {
    const market = usdcMarket();
    const client = fakeClient(market, {
      ...BASE_VALUES,
      asset: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
    });
    await expect(readWrappedPosition(client, market, ACCOUNT)).rejects.toThrow(WrappedPositionReadError);
  });

  it('fails when the batch fails, instead of reading zero', async () => {
    const market = usdcMarket();
    const client = fakeClient(market, BASE_VALUES);
    client.multicall.mockRejectedValue(new Error('rpc down'));
    await expect(readWrappedPosition(client, market, ACCOUNT)).rejects.toThrow(WrappedPositionReadError);
  });
});

describe('waitForBlock', () => {
  const WAIT = { attempts: 20, intervalMs: 1_500 };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /** Tracks what a wait settled to, so a test can look before and after the clock moves. */
  function track(wait: Promise<number | undefined>) {
    const outcome: { settled: boolean; block?: number } = { settled: false };
    void wait.then((block) => Object.assign(outcome, { settled: true, block }));
    return outcome;
  }

  it('returns the provider block once it reaches the minimum block', async () => {
    let block = 100;
    const outcome = track(waitForBlock({ getBlockNumber: async () => block }, 101, WAIT));
    await jest.advanceTimersByTimeAsync(3_000);
    expect(outcome.settled).toBe(false);

    block = 102;
    await jest.advanceTimersByTimeAsync(1_500);
    expect(outcome).toEqual({ settled: true, block: 102 });
  });

  it('gives up at the time budget when the provider never answers', async () => {
    const outcome = track(waitForBlock({ getBlockNumber: () => new Promise<number>(() => undefined) }, 101, WAIT));
    await jest.advanceTimersByTimeAsync(29_999);
    expect(outcome.settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual({ settled: true, block: undefined });
  });

  it('gives up at the time budget when every answer is slow and behind', async () => {
    const getBlockNumber = jest.fn(() => new Promise<number>((resolve) => setTimeout(() => resolve(100), 5_000)));
    const outcome = track(waitForBlock({ getBlockNumber }, 101, WAIT));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(outcome).toEqual({ settled: true, block: undefined });
  });

  it('does not wait for a slow answer that would arrive after the budget', async () => {
    const outcome = track(
      waitForBlock(
        { getBlockNumber: () => new Promise<number>((resolve) => setTimeout(() => resolve(101), 60_000)) },
        101,
        WAIT
      )
    );
    await jest.advanceTimersByTimeAsync(31_000);
    expect(outcome).toEqual({ settled: true, block: undefined });
  });
});

describe('supplyIncentivesForRoute', () => {
  const incentives = { earnRewardsAPR: 12_000_000_000_000_000n, isInstitutional: true };

  it('shows no supply reward or institutional boost on the wrapped route', () => {
    expect(supplyIncentivesForRoute(true, 0n, incentives)).toEqual({ earnRewardsAPR: 0n, isInstitutional: false });
    expect(supplyIncentivesForRoute(true, -5n, incentives)).toEqual({ earnRewardsAPR: 0n, isInstitutional: false });
  });

  it('keeps the incentives a direct supply earns on the wrapped route', () => {
    expect(supplyIncentivesForRoute(true, 5n, incentives)).toEqual(incentives);
  });

  it('keeps the market incentives on the standard route', () => {
    expect(supplyIncentivesForRoute(false, 0n, incentives)).toEqual(incentives);
  });
});

describe('isSameWalletSession', () => {
  const SESSION = { account: ACCOUNT, connector: 'connector-a', chainId: 1 };

  it('accepts the same session, with the account in any case', () => {
    expect(isSameWalletSession(SESSION, { ...SESSION })).toBe(true);
    expect(isSameWalletSession(SESSION, { ...SESSION, account: ACCOUNT.toUpperCase().replace('0X', '0x') })).toBe(true);
  });

  it('refuses another account, connector or wallet network', () => {
    expect(isSameWalletSession(SESSION, { ...SESSION, account: '0x0000000000000000000000000000000000000bb2' })).toBe(
      false
    );
    expect(isSameWalletSession(SESSION, { ...SESSION, connector: 'connector-b' })).toBe(false);
    expect(isSameWalletSession(SESSION, { ...SESSION, chainId: 10 })).toBe(false);
  });

  it('refuses a session without an account', () => {
    const disconnected = { account: undefined, connector: undefined, chainId: undefined };
    expect(isSameWalletSession(disconnected, disconnected)).toBe(false);
  });
});

describe('isSubmissionRefused', () => {
  const USDC = { chainId: 1, cometAddress: USDC_COMET };
  const OTHER_ROUTED = { chainId: 1, cometAddress: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840' };
  const UNROUTED = { chainId: 1, cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94' };
  const wrapped: LendingRoute = {
    kind: 'wrapped',
    chainId: 1,
    cometAddress: USDC_COMET,
    lookup: { status: 'valid', market: usdcMarket() },
    market: usdcMarket(),
    validationKey: 'key',
    reads: { isEligible: true },
    deposit: { isEligible: false, reason: 'deposits-disabled' },
    exit: { isEligible: false, reason: 'exits-disabled' },
  };
  const standard: LendingRoute = { kind: 'standard', writes: { isEligible: true } };
  const wrappedClosed = wrapped;
  const baseAsset = { ...mockBaseAsset(), walletBalance: 10n ** 12n };

  const hydrated = (balance: bigint, market = USDC, account = ACCOUNT): CometStateWithMarket => ({
    market,
    account,
    state: [
      StateType.Hydrated,
      { baseAsset: { ...baseAsset, balance }, collateralAssets: [] },
    ] as unknown as CometState,
  });
  const repay = (amount: bigint): Action => [ActionType.Repay, { ...baseAsset }, amount] as Action;
  const supply: Action = [ActionType.Supply, { ...baseAsset }, 1_000_000n] as Action;

  it('checks the live debt, not the debt when the dialog opened', () => {
    const live = { route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(-90_000_000n) };
    expect(isSubmissionRefused(live, USDC, [repay(100_000_000n)])).toBe(true);
    expect(isSubmissionRefused(live, USDC, [repay(90_000_000n)])).toBe(false);
  });

  it('refuses a base supply on the wrapped route', () => {
    const live = { route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(0n) };
    expect(isSubmissionRefused(live, USDC, [supply])).toBe(true);
  });

  it('refuses on the wrapped route until the live balances are for the same market', () => {
    const loading = { market: USDC, account: ACCOUNT, state: [StateType.Loading, undefined] as CometState };
    expect(
      isSubmissionRefused({ route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: loading }, USDC, [repay(1n)])
    ).toBe(true);
    expect(
      isSubmissionRefused(
        { route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(-10n, OTHER_ROUTED) },
        USDC,
        [repay(1n)]
      )
    ).toBe(true);
  });

  it('refuses on the wrapped route when the live balances were read for another account', () => {
    const live = {
      route: wrapped,
      account: ACCOUNT,
      selectedMarket: USDC,
      comet: hydrated(-100_000_000n, USDC, '0x0000000000000000000000000000000000000bb2'),
    };
    expect(isSubmissionRefused(live, USDC, [repay(100_000_000n)])).toBe(true);
  });

  it('leaves the standard route on the selected market alone', () => {
    const live = { route: standard, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(0n) };
    expect(isSubmissionRefused(live, USDC, [supply])).toBe(false);
  });

  it('refuses a dialog kept from a routed market after another market was selected', () => {
    const live = { route: standard, account: ACCOUNT, selectedMarket: UNROUTED, comet: hydrated(0n, UNROUTED) };
    expect(isSubmissionRefused(live, USDC, [supply])).toBe(true);
  });

  it('leaves a dialog for an unrouted market alone', () => {
    const live = { route: standard, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(0n) };
    expect(isSubmissionRefused(live, UNROUTED, [supply])).toBe(false);
  });

  it('still refuses every base withdrawal to Comet on the wrapped route, with or without a direct supply', () => {
    for (const balance of [0n, 250_000_000n]) {
      const live = { route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(balance) };
      for (const amount of [1n, 100_000_000n, MAX_UINT256]) {
        expect(isSubmissionRefused(live, USDC, [[ActionType.Withdraw, { ...baseAsset }, amount] as Action])).toBe(true);
      }
    }
  });

  it('refuses a borrow on the wrapped route while a direct supply remains, since Comet would withdraw it first', () => {
    const borrow: Action = [ActionType.Borrow, { ...baseAsset }, 100_000_000n] as Action;
    const withSupply = { route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(250_000_000n) };
    const withoutSupply = { route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(0n) };
    expect(isSubmissionRefused(withSupply, USDC, [borrow])).toBe(true);
    expect(isSubmissionRefused(withoutSupply, USDC, [borrow])).toBe(false);
  });

  describe('isDirectWithdrawalRefused', () => {
    // The wrapped route with its exits open, as a release opens them.
    const wrapped = { ...wrappedClosed, exit: { isEligible: true } } as LendingRoute;

    it('allows the planned Comet step while the live Comet state shows a direct supply', () => {
      const live = { route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(250_000_000n) };
      expect(isDirectWithdrawalRefused(live, USDC)).toBe(false);
      const dust = { route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(1n) };
      expect(isDirectWithdrawalRefused(dust, USDC)).toBe(false);
    });

    it('refuses it once the live Comet state shows no direct supply, or a borrow', () => {
      const none = { route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(0n) };
      expect(isDirectWithdrawalRefused(none, USDC)).toBe(true);
      const borrower = { route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(-1n) };
      expect(isDirectWithdrawalRefused(borrower, USDC)).toBe(true);
    });

    it('refuses it off the wrapped route, for another market, or without live balances for the account', () => {
      const covered = hydrated(250_000_000n);
      expect(
        isDirectWithdrawalRefused({ route: standard, account: ACCOUNT, selectedMarket: USDC, comet: covered }, USDC)
      ).toBe(true);
      expect(
        isDirectWithdrawalRefused(
          { route: wrapped, account: ACCOUNT, selectedMarket: OTHER_ROUTED, comet: covered },
          USDC
        )
      ).toBe(true);
      const loading = { market: USDC, account: ACCOUNT, state: [StateType.Loading, undefined] as CometState };
      expect(
        isDirectWithdrawalRefused({ route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: loading }, USDC)
      ).toBe(true);
      const otherAccount = hydrated(250_000_000n, USDC, '0x0000000000000000000000000000000000000bb2');
      expect(
        isDirectWithdrawalRefused({ route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: otherAccount }, USDC)
      ).toBe(true);
      expect(
        isDirectWithdrawalRefused(
          { route: wrapped, account: ACCOUNT, selectedMarket: USDC, comet: hydrated(250_000_000n, OTHER_ROUTED) },
          USDC
        )
      ).toBe(true);
    });

    it('refuses it while exits are closed or the route cannot withdraw', () => {
      const covered = hydrated(250_000_000n);
      expect(
        isDirectWithdrawalRefused(
          { route: wrappedClosed, account: ACCOUNT, selectedMarket: USDC, comet: covered },
          USDC
        )
      ).toBe(true);
      const conflicted = {
        ...wrappedClosed,
        exit: { isEligible: false, reason: 'connector-conflict' },
      } as LendingRoute;
      expect(
        isDirectWithdrawalRefused({ route: conflicted, account: ACCOUNT, selectedMarket: USDC, comet: covered }, USDC)
      ).toBe(true);
    });
  });
});

describe('readDirectBalance', () => {
  const COMET_ABI = new Interface(CometAbi);

  it("reads Comet's balanceOf for the account at the given block", async () => {
    const provider = { call: jest.fn(async () => COMET_ABI.encodeFunctionResult('balanceOf', [250_000_000n])) };
    await expect(readDirectBalance(provider, USDC_COMET, ACCOUNT, 1_234)).resolves.toBe(250_000_000n);
    expect(provider.call).toHaveBeenCalledWith(
      { to: USDC_COMET, data: '0x70a08231' + ACCOUNT.slice(2).toLowerCase().padStart(64, '0') },
      1_234
    );
  });

  it('fails, rather than returning zero, when the read fails', async () => {
    const provider = { call: jest.fn(async () => Promise.reject(new Error('rate limited'))) };
    await expect(readDirectBalance(provider, USDC_COMET, ACCOUNT, 1_234)).rejects.toThrow('rate limited');
  });
});

describe('withdrawnFromReceipt', () => {
  const COMET_ABI = new Interface(CometAbi);
  const withdrawLog = (address: string, src: string, amount: bigint) => ({
    address,
    ...COMET_ABI.encodeEventLog(COMET_ABI.getEvent('Withdraw'), [src, src, amount]),
  });

  it("reads the amount from Comet's Withdraw event for the account", () => {
    const receipt = { logs: [withdrawLog(USDC_COMET, ACCOUNT, 250_000_007n)] } as never;
    expect(withdrawnFromReceipt(receipt, USDC_COMET, ACCOUNT)).toBe(250_000_007n);
  });

  it("is undefined without such an event, and ignores another contract's or account's", () => {
    const other = '0x0000000000000000000000000000000000000bb2';
    const receipt = {
      logs: [withdrawLog(other, ACCOUNT, 1n), withdrawLog(USDC_COMET, other, 2n)],
    } as never;
    expect(withdrawnFromReceipt(receipt, USDC_COMET, ACCOUNT)).toBeUndefined();
    expect(withdrawnFromReceipt({ logs: [] } as never, USDC_COMET, ACCOUNT)).toBeUndefined();
  });
});

describe('getWrappedRouteWithdrawalLimits', () => {
  const CASH = 10_000_000_000n;
  // The wrapper's limits within `cash`: a 500 USDC full exit, of which the cash can pay at most `cash`.
  const wrapperLimits = (fullExitCash: bigint) =>
    jest.fn(
      (cash: bigint): WithdrawalLimits => ({
        fullExitCash,
        maxPartialCash: fullExitCash <= cash ? fullExitCash : cash,
        canExitFully: fullExitCash > 0n && fullExitCash <= cash,
      })
    );

  it("gives the wrapper's own limits within the market's cash without a direct supply", () => {
    const wrapperLimitsAt = wrapperLimits(500_000_000n);
    expect(
      getWrappedRouteWithdrawalLimits({
        directSupply: 0n,
        cometCash: CASH,
        hasShares: true,
        isWithdrawPaused: false,
        wrapperLimitsAt,
      })
    ).toEqual({ maxPartialCash: 500_000_000n, canWithdrawAll: true, fullExitCash: 500_000_000n });
    expect(wrapperLimitsAt).toHaveBeenCalledWith(CASH);
  });

  it('adds the direct supply first, and limits the wrapper to the cash the direct part leaves', () => {
    const wrapperLimitsAt = wrapperLimits(500_000_000n);
    expect(
      getWrappedRouteWithdrawalLimits({
        directSupply: 250_000_000n,
        cometCash: CASH,
        hasShares: true,
        isWithdrawPaused: false,
        wrapperLimitsAt,
      })
    ).toEqual({ maxPartialCash: 750_000_000n, canWithdrawAll: true, fullExitCash: 750_000_000n });
    expect(wrapperLimitsAt).toHaveBeenCalledWith(CASH - 250_000_000n);

    // The market holds 600 USDC: 250 for the direct part, and 350 of the wrapper's 500.
    expect(
      getWrappedRouteWithdrawalLimits({
        directSupply: 250_000_000n,
        cometCash: 600_000_000n,
        hasShares: true,
        isWithdrawPaused: false,
        wrapperLimitsAt,
      })
    ).toEqual({ maxPartialCash: 600_000_000n, canWithdrawAll: false, fullExitCash: 750_000_000n });
  });

  it('pays only the cash, from the direct part, when the market holds less than the direct supply', () => {
    expect(
      getWrappedRouteWithdrawalLimits({
        directSupply: 250_000_000n,
        cometCash: 100_000_000n,
        hasShares: true,
        isWithdrawPaused: false,
        wrapperLimitsAt: wrapperLimits(500_000_000n),
      })
    ).toEqual({ maxPartialCash: 100_000_000n, canWithdrawAll: false, fullExitCash: 750_000_000n });
  });

  it('lets Max withdraw a direct supply alone without wrapper shares, and not beside shares too small to exit', () => {
    const limits = (hasShares: boolean, fullExitCash: bigint) =>
      getWrappedRouteWithdrawalLimits({
        directSupply: 250_000_000n,
        cometCash: CASH,
        hasShares,
        isWithdrawPaused: false,
        wrapperLimitsAt: wrapperLimits(fullExitCash),
      });
    expect(limits(false, 0n)).toEqual({
      maxPartialCash: 250_000_000n,
      canWithdrawAll: true,
      fullExitCash: 250_000_000n,
    });
    expect(limits(true, 0n)).toEqual({
      maxPartialCash: 250_000_000n,
      canWithdrawAll: false,
      fullExitCash: 250_000_000n,
    });
  });

  it('pays nothing while Comet withdrawals are paused, which stops the direct part too', () => {
    expect(
      getWrappedRouteWithdrawalLimits({
        directSupply: 250_000_000n,
        cometCash: CASH,
        hasShares: true,
        isWithdrawPaused: true,
        wrapperLimitsAt: wrapperLimits(500_000_000n),
      })
    ).toEqual({ maxPartialCash: 0n, canWithdrawAll: false, fullExitCash: 750_000_000n });
  });

  it("is unknown while the wrapper's limits are", () => {
    const unknown = () => undefined;
    expect(
      getWrappedRouteWithdrawalLimits({
        directSupply: 0n,
        cometCash: CASH,
        hasShares: true,
        isWithdrawPaused: false,
        wrapperLimitsAt: unknown,
      })
    ).toBeUndefined();
    expect(
      getWrappedRouteWithdrawalLimits({
        directSupply: 1n,
        cometCash: CASH,
        hasShares: true,
        isWithdrawPaused: false,
        wrapperLimitsAt: unknown,
      })
    ).toBeUndefined();
  });
});

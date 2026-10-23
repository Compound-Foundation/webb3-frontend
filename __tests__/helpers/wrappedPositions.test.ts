import { BigNumber } from 'ethers';

import { WRAPPED_MARKET_REGISTRY, WrappedMarket } from '@constants/wrappedMarkets';
import { LendingRoute } from '@helpers/lendingRoute';
import {
  CometStateWithMarket,
  isSubmissionRefused,
  getFullExitCash,
  getGrossAssets,
  getRedeemBuffer,
  getWithdrawableCash,
  getWrappedPositionValueInDollars,
  readWrappedPosition,
  supplyIncentivesForRoute,
  WrappedPositionReadError,
} from '@helpers/wrappedPositions';
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

type RecordedCall = { address: string; name: string; params: unknown[] };

/** A multicall stand-in that answers each call by contract address and function name. */
function fakeMulticall(market: WrappedMarket, values: ChainValues, calls: RecordedCall[] = []) {
  return {
    all: jest.fn(async (batch: { contract: { address: string }; name: string; params: unknown[] }[]) => {
      return batch.map(({ contract, name, params }) => {
        calls.push({ address: contract.address, name, params });
        const address = contract.address.toLowerCase();
        if (address === market.wrapperAddress.toLowerCase()) {
          if (name === 'balanceOf') return BigNumber.from(values.shares);
          if (name === 'totalSupply') return BigNumber.from(values.totalSupply);
          if (name === 'asset') return values.asset;
        }
        if (address === market.cometAddress.toLowerCase()) {
          if (name === 'balanceOf') return BigNumber.from(values.totalAssets);
          if (name === 'totalsBasic') return { baseSupplyIndex: BigNumber.from(values.baseSupplyIndex) };
          if (name === 'isWithdrawPaused') return values.isWithdrawPaused;
        }
        if (address === market.baseTokenAddress.toLowerCase()) {
          if (name === 'balanceOf') return BigNumber.from(values.walletBalance);
          if (name === 'allowance') return BigNumber.from(values.allowance);
        }
        throw new Error(`unexpected call ${name} on ${contract.address}`);
      });
    }),
  };
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

describe('getWithdrawableCash', () => {
  it('is the full-exit payout when the market can pay it', () => {
    expect(getWithdrawableCash(250_124_997n, false, 10n ** 12n)).toEqual({ amount: 250_124_997n, limit: 'none' });
  });

  it('is capped by the base token the market holds', () => {
    expect(getWithdrawableCash(250_124_997n, false, 50_000_000n)).toEqual({ amount: 50_000_000n, limit: 'liquidity' });
  });

  it('is zero while Comet withdrawals are paused', () => {
    expect(getWithdrawableCash(250_124_997n, true, 10n ** 12n)).toEqual({ amount: 0n, limit: 'paused' });
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
    const calls: RecordedCall[] = [];
    const multicall = fakeMulticall(market, BASE_VALUES, calls);

    const position = await readWrappedPosition(multicall, market, ACCOUNT);

    expect(multicall.all).toHaveBeenCalledTimes(1);
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
    // The allowance is the base token's, with the wrapper as spender.
    expect(calls).toContainEqual({
      address: market.baseTokenAddress,
      name: 'allowance',
      params: [ACCOUNT, market.wrapperAddress],
    });
    // The wrapper's assets are its Comet balance.
    expect(calls).toContainEqual({ address: market.cometAddress, name: 'balanceOf', params: [market.wrapperAddress] });
  });

  it('reads an empty account as zero shares and zero cash', async () => {
    const market = usdcMarket();
    const position = await readWrappedPosition(
      fakeMulticall(market, { ...BASE_VALUES, shares: 0n, allowance: 0n }),
      market,
      ACCOUNT
    );
    expect(position.shares).toBe(0n);
    expect(position.grossAssets).toBe(0n);
    expect(position.fullExitCash).toBe(0n);
  });

  it('fails when the wrapper does not hold the configured Comet, instead of reading zero', async () => {
    const market = usdcMarket();
    const multicall = fakeMulticall(market, {
      ...BASE_VALUES,
      asset: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
    });
    await expect(readWrappedPosition(multicall, market, ACCOUNT)).rejects.toThrow(WrappedPositionReadError);
  });

  it('fails when the batch fails, instead of reading zero', async () => {
    const market = usdcMarket();
    const multicall = { all: jest.fn().mockRejectedValue(new Error('rpc down')) };
    await expect(readWrappedPosition(multicall, market, ACCOUNT)).rejects.toThrow(WrappedPositionReadError);
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
});

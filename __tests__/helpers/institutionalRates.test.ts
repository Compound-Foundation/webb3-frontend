import {
  institutionalBoostCapReached,
  institutionalNetSupplyRate,
  institutionalSupplyRewardRate,
  institutionalSupplyRewards,
} from '@helpers/institutionalRates';
import { getMarkets } from '@helpers/markets';
import { FACTOR_PRECISION, PRICE_PRECISION } from '@helpers/numbers';
import { Token } from '@types';

const dollars = (amount: number) => BigInt(amount) * 10n ** BigInt(PRICE_PRECISION);
const rate = (fraction: number) => BigInt(Math.round(fraction * 10 ** 6)) * 10n ** BigInt(FACTOR_PRECISION - 6);

const institutionalMarket = getMarkets(true).find((market) => market.institutional);
const standardMarket = getMarkets(true).find((market) => !market.institutional);

if (institutionalMarket === undefined || standardMarket === undefined) {
  throw new Error('Expected both an institutional and a standard market to be configured');
}

const usdc: Token = { address: '0xbase', decimals: 6, name: 'USD Coin', symbol: 'USDC' };
const comp: Token = { address: '0xcomp', decimals: 18, name: 'Compound', symbol: 'COMP' };

describe('institutionalSupplyRewardRate', () => {
  test('pays nothing below the first level', () => {
    // TEMP FOR TEAM TESTING — REVERT BEFORE PROD DEPLOY OR MERGE.
    // Production expectation is 0n for both (no reward below the first level).
    expect(institutionalSupplyRewardRate(dollars(0))).toEqual(rate(1.6));
    expect(institutionalSupplyRewardRate(dollars(499_999))).toEqual(rate(1.6));
  });

  test('pays the rate of the largest level reached', () => {
    expect(institutionalSupplyRewardRate(dollars(500_000))).toEqual(rate(1.6));
    expect(institutionalSupplyRewardRate(dollars(999_999))).toEqual(rate(1.6));
    expect(institutionalSupplyRewardRate(dollars(1_000_000))).toEqual(rate(0.8));
    expect(institutionalSupplyRewardRate(dollars(1_200_000))).toEqual(rate(0.8));
    expect(institutionalSupplyRewardRate(dollars(1_500_000))).toEqual(
      (800_000n * 10n ** BigInt(FACTOR_PRECISION)) / 1_500_000n,
    );
    expect(institutionalSupplyRewardRate(dollars(2_000_000))).toEqual(rate(0.4));
    expect(institutionalSupplyRewardRate(dollars(5_000_000))).toEqual(rate(0.16));
    expect(institutionalSupplyRewardRate(dollars(10_000_000))).toEqual(rate(0.08));
    expect(institutionalSupplyRewardRate(dollars(20_000_000))).toEqual(rate(0.04));
  });

  test('holds the last level rate as the market grows past it', () => {
    expect(institutionalSupplyRewardRate(dollars(100_000_000))).toEqual(rate(0.04));
  });
});

describe('institutionalBoostCapReached', () => {
  test('reached only at the last level and above', () => {
    expect(institutionalBoostCapReached(dollars(0))).toBe(false);
    expect(institutionalBoostCapReached(dollars(19_999_999))).toBe(false);
    expect(institutionalBoostCapReached(dollars(20_000_000))).toBe(true);
    expect(institutionalBoostCapReached(dollars(100_000_000))).toBe(true);
  });
});

describe('institutionalNetSupplyRate', () => {
  test('adds the reward rate on top of the floating rate for institutional markets', () => {
    // TEMP FOR TEAM TESTING — REVERT BEFORE PROD DEPLOY OR MERGE. Production expectation: rate(0.03).
    expect(institutionalNetSupplyRate(institutionalMarket, rate(0.03), dollars(0))).toEqual(rate(1.63));
    expect(institutionalNetSupplyRate(institutionalMarket, rate(0.03), dollars(500_000))).toEqual(rate(1.63));
    expect(institutionalNetSupplyRate(institutionalMarket, rate(0.03), dollars(10_000_000))).toEqual(rate(0.11));
    expect(institutionalNetSupplyRate(institutionalMarket, rate(0.2), dollars(5_000_000))).toEqual(rate(0.36));
  });

  test('leaves other markets unchanged', () => {
    expect(institutionalNetSupplyRate(standardMarket, rate(0.03), dollars(30_000_000))).toEqual(rate(0.03));
    expect(institutionalNetSupplyRate(undefined, rate(0.03), dollars(30_000_000))).toEqual(rate(0.03));
  });
});

describe('institutionalSupplyRewards', () => {
  test('shows the program reward as base-asset rewards and marks it institutional', () => {
    expect(institutionalSupplyRewards(institutionalMarket, undefined, undefined, usdc, dollars(10_000_000))).toEqual({
      earnRewardsAPR: rate(0.08),
      rewardsAsset: usdc,
      isInstitutionalReward: true,
    });
  });

  test('folds regular rewards into the amount so the displayed total is preserved', () => {
    expect(institutionalSupplyRewards(institutionalMarket, rate(0.01), comp, usdc, dollars(10_000_000))).toEqual({
      earnRewardsAPR: rate(0.09),
      rewardsAsset: usdc,
      isInstitutionalReward: true,
    });
  });

  test('passes rewards through unchanged while the program is not paying', () => {
    // TEMP FOR TEAM TESTING — REVERT BEFORE PROD DEPLOY OR MERGE.
    // Production expectation: pass-through unchanged with isInstitutionalReward false.
    expect(institutionalSupplyRewards(institutionalMarket, undefined, undefined, usdc, dollars(0))).toEqual({
      earnRewardsAPR: rate(1.6),
      rewardsAsset: usdc,
      isInstitutionalReward: true,
    });
    expect(institutionalSupplyRewards(institutionalMarket, rate(0.01), comp, usdc, dollars(499_999))).toEqual({
      earnRewardsAPR: rate(1.61),
      rewardsAsset: usdc,
      isInstitutionalReward: true,
    });
  });

  test('leaves other markets unchanged', () => {
    expect(institutionalSupplyRewards(standardMarket, rate(0.01), comp, usdc, dollars(30_000_000))).toEqual({
      earnRewardsAPR: rate(0.01),
      rewardsAsset: comp,
      isInstitutionalReward: false,
    });
    expect(institutionalSupplyRewards(undefined, undefined, undefined, usdc, dollars(0))).toEqual({
      earnRewardsAPR: undefined,
      rewardsAsset: undefined,
      isInstitutionalReward: false,
    });
  });
});

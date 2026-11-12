import {
  institutionalSupplyRewardRate,
} from '@helpers/institutionalRates';
import { getMarkets } from '@helpers/markets';
import { FACTOR_PRECISION, PRICE_PRECISION } from '@helpers/numbers';

const dollars = (amount: number) => BigInt(amount) * 10n ** BigInt(PRICE_PRECISION);
const rate = (fraction: number) => BigInt(Math.round(fraction * 10 ** 6)) * 10n ** BigInt(FACTOR_PRECISION - 6);

const institutionalMarket = getMarkets(true).find((market) => market.institutional);
const standardMarket = getMarkets(true).find((market) => !market.institutional);

if (institutionalMarket === undefined || standardMarket === undefined) {
  throw new Error('Expected both an institutional and a standard market to be configured');
}

describe('institutionalSupplyRewardRate', () => {
  test('pays nothing below the first level', () => {
    expect(institutionalSupplyRewardRate(dollars(0), 'usdc-institutional')).toEqual(0n);
    expect(institutionalSupplyRewardRate(dollars(499_999), 'usdc-institutional')).toEqual(0n);
  });

  test('pays the rate of the largest level reached', () => {
    expect(institutionalSupplyRewardRate(dollars(500_000), 'usdc-institutional')).toEqual(rate(1.6));
    expect(institutionalSupplyRewardRate(dollars(999_999), 'usdc-institutional')).toEqual(rate(1.6));
    expect(institutionalSupplyRewardRate(dollars(1_000_000), 'usdc-institutional')).toEqual(rate(0.8));
    expect(institutionalSupplyRewardRate(dollars(1_200_000), 'usdc-institutional')).toEqual(rate(0.8));
    expect(institutionalSupplyRewardRate(dollars(1_500_000), 'usdc-institutional')).toEqual(
      (800_000n * 10n ** BigInt(FACTOR_PRECISION)) / 1_500_000n,
    );
    expect(institutionalSupplyRewardRate(dollars(2_000_000), 'usdc-institutional')).toEqual(rate(0.4));
    expect(institutionalSupplyRewardRate(dollars(5_000_000), 'usdc-institutional')).toEqual(rate(0.16));
    expect(institutionalSupplyRewardRate(dollars(10_000_000), 'usdc-institutional')).toEqual(rate(0.08));
    expect(institutionalSupplyRewardRate(dollars(20_000_000), 'usdc-institutional')).toEqual(rate(0.04));
  });

  test('holds the last level rate as the market grows past it', () => {
    expect(institutionalSupplyRewardRate(dollars(100_000_000), 'usdc-institutional')).toEqual(rate(0.04));
  });

  test('falls back to the USDC program for markets without a configured program', () => {
    expect(institutionalSupplyRewardRate(dollars(500_000))).toEqual(rate(1.6));
    expect(institutionalSupplyRewardRate(dollars(500_000), 'some-future-market')).toEqual(rate(1.6));
  });

  // PLACEHOLDER coverage: the USDG program mirrors the USDC schedule until
  // product finalizes its own formula. When the real schedule lands, replace
  // these expectations with the USDG program's values.
  test('the USDG program currently mirrors the USDC schedule', () => {
    for (const supplied of [0, 499_999, 500_000, 1_000_000, 10_000_000, 100_000_000]) {
      expect(institutionalSupplyRewardRate(dollars(supplied), 'usdg-institutional')).toEqual(
        institutionalSupplyRewardRate(dollars(supplied), 'usdc-institutional'),
      );
    }
  });
});

import { aprAt, RateModel } from '@helpers/interestRates';

const SECONDS_PER_YEAR = 31_536_000n;
const FACTOR_SCALE = 10n ** 18n;

const percent = (value: number) => (BigInt(value) * FACTOR_SCALE) / 100n;

// Per-second rates: 1e9 base, 2e9 slope below the kink, 3e10 slope above it
const rateModel: RateModel = {
  kink: percent(80),
  base: 1_000_000_000n,
  slopeLow: 2_000_000_000n,
  slopeHigh: 30_000_000_000n,
};

const apr = (perSecondRate: bigint) => perSecondRate * SECONDS_PER_YEAR;

describe('aprAt', () => {
  test('is the base rate when nothing is borrowed', () => {
    expect(aprAt(0n, rateModel, FACTOR_SCALE)).toEqual(apr(1_000_000_000n));
  });

  test('follows the low slope below the kink', () => {
    expect(aprAt(percent(50), rateModel, FACTOR_SCALE)).toEqual(apr(2_000_000_000n));
  });

  test('uses the low slope at the kink', () => {
    expect(aprAt(percent(80), rateModel, FACTOR_SCALE)).toEqual(apr(2_600_000_000n));
  });

  test('adds the high slope just above the kink', () => {
    expect(aprAt(percent(81), rateModel, FACTOR_SCALE)).toEqual(apr(2_900_000_000n));
  });

  test('keeps the high slope above 100% utilization', () => {
    expect(aprAt(percent(120), rateModel, FACTOR_SCALE)).toEqual(apr(14_600_000_000n));
  });
});

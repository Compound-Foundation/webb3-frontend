import { RateModelResponse } from './sleuth/types';

const SECONDS_PER_YEAR = BigInt(60 * 60 * 24 * 365);

export type RateModel = {
  kink: bigint;
  base: bigint;
  slopeLow: bigint;
  slopeHigh: bigint;
};

export const toRateModel = (rateModel: RateModelResponse): RateModel => ({
  kink: rateModel.kink.toBigInt(),
  base: rateModel.perSecondInterestRateBase.toBigInt(),
  slopeLow: rateModel.perSecondInterestRateSlopeLow.toBigInt(),
  slopeHigh: rateModel.perSecondInterestRateSlopeHigh.toBigInt(),
});

function perSecondRateAt(
  utilization: bigint,
  { kink, base, slopeLow, slopeHigh }: RateModel,
  factorScale: bigint
): bigint {
  if (utilization <= kink) {
    return base + (slopeLow * utilization) / factorScale;
  }
  return base + (slopeLow * kink) / factorScale + (slopeHigh * (utilization - kink)) / factorScale;
}

export function aprAt(utilization: bigint, rateModel: RateModel, factorScale: bigint): bigint {
  return perSecondRateAt(utilization, rateModel, factorScale) * SECONDS_PER_YEAR;
}

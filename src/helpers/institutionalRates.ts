import { FACTOR_PRECISION, PRICE_PRECISION } from '@helpers/numbers';

// Display rules for institutional market supply rates.
//
// Institutional markets pay rewards denominated in the market's base asset
// (base-asset terms) on top of the market's regular floating net supply rate.
// Each market's program distributes a fixed annual budget across the market's
// total supplied value in fixed-size levels: the reward APR is
// budget / (the largest level reached), so it steps down as the market grows.
// No rewards are paid before the first level is reached, and the last level's
// rate applies from there on up.
//
// For the USDC program this reproduces the rate schedule exactly
// ($500k -> 160%, $1M -> 80%, $1.5M -> 53.33%, ... $10M -> 8%, ... $20M+ -> 4%).
// To adjust a program, edit its entry in INSTITUTIONAL_REWARDS_PROGRAMS below.
// Dollar amounts are whole dollars.
export type InstitutionalRewardsProgram = {
  rewardsBudgetDollarsPerYear: number;
  levelStepDollars: number;
  firstLevelDollars: number;
  lastLevelDollars: number;
};

const USDC_INSTITUTIONAL_PROGRAM: InstitutionalRewardsProgram = {
  rewardsBudgetDollarsPerYear: 800_000,
  levelStepDollars: 500_000,
  firstLevelDollars: 500_000,
  lastLevelDollars: 20_000_000,
};

// PLACEHOLDER: the USDG market runs its own boosted-yield program, but its
// schedule is still being finalized by product. It mirrors the USDC program
// until the real formula lands — update this entry (or the formula in
// institutionalSupplyRewardRate, if the program's shape differs) before the
// USDG program's terms are announced.
const USDG_INSTITUTIONAL_PROGRAM: InstitutionalRewardsProgram = {
  ...USDC_INSTITUTIONAL_PROGRAM,
};

// Programs are keyed by the market's slug (MarketData['slug']). A market whose
// slug has no entry falls back to the USDC program, preserving the behavior
// from when there was a single institutional market.
const INSTITUTIONAL_REWARDS_PROGRAMS: { [slug: string]: InstitutionalRewardsProgram } = {
  'usdc-institutional': USDC_INSTITUTIONAL_PROGRAM,
  'usdg-institutional': USDG_INSTITUTIONAL_PROGRAM,
};

// The date through which the boosted yield programs apply, shown on the
// whitelisted card. Update when a program is extended.
// TODO: both programs currently share this end date; if they ever diverge, the
// label needs to move into InstitutionalRewardsProgram and be threaded through
// BoostedSupplyRates / WhitelistStatusBanner per market.
export const INSTITUTIONAL_BOOST_END_DATE = new Date(2026, 11, 8); // December 8, 2026
// Display form of the end date, formatted once at module load
export const INSTITUTIONAL_BOOST_END_DATE_LABEL = INSTITUTIONAL_BOOST_END_DATE.toLocaleDateString('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const DOLLAR_SCALE = 10n ** BigInt(PRICE_PRECISION);

/**
 * The base-asset-terms reward supply rate a market's program pays at a given
 * market size.
 * @param totalSuppliedUsd the market's total supplied value in dollars, at PRICE_PRECISION
 * @param marketSlug the market's slug, used to select its rewards program
 * @returns the reward supply rate, at FACTOR_PRECISION
 */
export function institutionalSupplyRewardRate(totalSuppliedUsd: bigint, marketSlug?: string): bigint {
  const program =
    (marketSlug !== undefined ? INSTITUTIONAL_REWARDS_PROGRAMS[marketSlug] : undefined) ?? USDC_INSTITUTIONAL_PROGRAM;

  if (totalSuppliedUsd < BigInt(program.firstLevelDollars) * DOLLAR_SCALE) {
    return 0n;
  }
  const cappedUsd = BigInt(program.lastLevelDollars) * DOLLAR_SCALE;
  const suppliedUsd = totalSuppliedUsd < cappedUsd ? totalSuppliedUsd : cappedUsd;
  const levelDollars = (suppliedUsd / (BigInt(program.levelStepDollars) * DOLLAR_SCALE)) * BigInt(program.levelStepDollars);
  return (BigInt(program.rewardsBudgetDollarsPerYear) * 10n ** BigInt(FACTOR_PRECISION)) / levelDollars;
}

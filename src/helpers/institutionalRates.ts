import { FACTOR_PRECISION, PRICE_PRECISION } from '@helpers/numbers';

// Display rules for institutional market supply rates.
//
// Institutional markets pay rewards denominated in the market's base asset (USDC
// terms) on top of the market's regular floating net supply rate. The program
// distributes a fixed annual budget across the market's total supplied value in
// $500k levels: the reward APR is budget / (the largest level reached), so it steps
// down as the market grows. No rewards are paid before the first level is reached,
// and the last level's rate applies from there on up.
//
// This reproduces the program's rate schedule exactly ($500k -> 160%, $1M -> 80%,
// $1.5M -> 53.33%, ... $10M -> 8%, ... $20M+ -> 4%). To adjust the program, edit
// the constants below. Dollar amounts are whole dollars.
const REWARDS_BUDGET_DOLLARS_PER_YEAR = 800_000;

// The date through which the boosted yield program applies, shown on the
// whitelisted card. Update when the program is extended.
export const INSTITUTIONAL_BOOST_END_DATE = new Date(2026, 11, 8); // December 8, 2026
// Display form of the end date, formatted once at module load
export const INSTITUTIONAL_BOOST_END_DATE_LABEL = INSTITUTIONAL_BOOST_END_DATE.toLocaleDateString('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const LEVEL_STEP_DOLLARS = 500_000;
const FIRST_LEVEL_DOLLARS = 500_000;
const LAST_LEVEL_DOLLARS = 20_000_000;

const DOLLAR_SCALE = 10n ** BigInt(PRICE_PRECISION);

/**
 * The USDC-terms reward supply rate the program pays at a given market size.
 * @param totalSuppliedUsd the market's total supplied value in dollars, at PRICE_PRECISION
 * @returns the reward supply rate, at FACTOR_PRECISION
 */
export function institutionalSupplyRewardRate(totalSuppliedUsd: bigint): bigint {
  if (totalSuppliedUsd < BigInt(FIRST_LEVEL_DOLLARS) * DOLLAR_SCALE) {
    return 0n;
  }
  const cappedUsd = BigInt(LAST_LEVEL_DOLLARS) * DOLLAR_SCALE;
  const suppliedUsd = totalSuppliedUsd < cappedUsd ? totalSuppliedUsd : cappedUsd;
  const levelDollars = (suppliedUsd / (BigInt(LEVEL_STEP_DOLLARS) * DOLLAR_SCALE)) * BigInt(LEVEL_STEP_DOLLARS);
  return (BigInt(REWARDS_BUDGET_DOLLARS_PER_YEAR) * 10n ** BigInt(FACTOR_PRECISION)) / levelDollars;
}

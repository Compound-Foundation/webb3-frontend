import { FACTOR_PRECISION, PRICE_PRECISION } from '@helpers/numbers';
import { MarketData, MarketDataLoaded, Token } from '@types';

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
    // TEMP FOR TEAM TESTING — REVERT BEFORE PROD DEPLOY OR MERGE.
    // Pays the first-level rate below the first level so the reward UI is
    // visible on the shared build while the market is at ~$0 TVL.
    // Production behavior: return 0n here (no reward below the first level).
    return (BigInt(REWARDS_BUDGET_DOLLARS_PER_YEAR) * 10n ** BigInt(FACTOR_PRECISION)) / BigInt(FIRST_LEVEL_DOLLARS);
  }
  const cappedUsd = BigInt(LAST_LEVEL_DOLLARS) * DOLLAR_SCALE;
  const suppliedUsd = totalSuppliedUsd < cappedUsd ? totalSuppliedUsd : cappedUsd;
  const levelDollars = (suppliedUsd / (BigInt(LEVEL_STEP_DOLLARS) * DOLLAR_SCALE)) * BigInt(LEVEL_STEP_DOLLARS);
  return (BigInt(REWARDS_BUDGET_DOLLARS_PER_YEAR) * 10n ** BigInt(FACTOR_PRECISION)) / levelDollars;
}

/**
 * The net supply rate to display for a market: institutional markets add the program's
 * reward rate for their current size on top of the market's regular rate; all other
 * markets show the rate unchanged.
 * @param netSupplyRate the market's regular net supply rate, at FACTOR_PRECISION
 * @param totalSuppliedUsd the market's total supplied value in dollars, at PRICE_PRECISION
 */
export function institutionalNetSupplyRate(
  market: MarketData | MarketDataLoaded | undefined,
  netSupplyRate: bigint,
  totalSuppliedUsd: bigint,
): bigint {
  if (!market?.institutional) {
    return netSupplyRate;
  }
  return netSupplyRate + institutionalSupplyRewardRate(totalSuppliedUsd);
}

/**
 * The rewards component of the displayed net supply rate, and the asset it is
 * denominated in. When an institutional market's program is paying rewards, they are
 * shown in the market's base asset (USDC terms) and isInstitutionalReward is set; any
 * regular rewards are folded into the amount so the displayed total stays
 * earnAPR + earnRewardsAPR. Otherwise the market's regular rewards pass through
 * unchanged.
 */
export function institutionalSupplyRewards(
  market: MarketData | MarketDataLoaded | undefined,
  earnRewardsAPR: bigint | undefined,
  rewardsAsset: Token | undefined,
  baseAsset: Token,
  totalSuppliedUsd: bigint,
): { earnRewardsAPR: bigint | undefined; rewardsAsset: Token | undefined; isInstitutionalReward: boolean } {
  if (!market?.institutional) {
    return { earnRewardsAPR, rewardsAsset, isInstitutionalReward: false };
  }
  const rewardRate = institutionalSupplyRewardRate(totalSuppliedUsd);
  if (rewardRate === 0n) {
    return { earnRewardsAPR, rewardsAsset, isInstitutionalReward: false };
  }
  return { earnRewardsAPR: rewardRate + (earnRewardsAPR ?? 0n), rewardsAsset: baseAsset, isInstitutionalReward: true };
}

import { getMarketRewardsAPRs } from '@helpers/rewards';
import { RewardsState, StateType } from '@types';

const LOADING_REWARDS_STATE: RewardsState = [StateType.Loading];

describe('getMarketRewardsAPRs', () => {
  it('institutional market: uses institutionalSupplyRewardRate, borrowRewardsAPR is 0', () => {
    const market = { institutional: true, chainInformation: { chainId: 1 } } as any;
    const result = getMarketRewardsAPRs(market, LOADING_REWARDS_STATE, 1_000_000n, 500_000n);

    expect(result.isInstitutional).toBe(true);
    expect(result.borrowRewardsAPR).toBe(0n);
    expect(result.supplyRewardsAPR).toBeGreaterThan(0n);
  });

  it('market without rewards data available yet: returns 0n APRs, no throw', () => {
    const market = {
      rewardsOverwrite: {
        borrowCompPerDay: 10n * 10n ** 18n,
        supplyCompPerDay: 20n * 10n ** 18n,
        rewardsAssetSymbol: 'COMP',
      },
      marketAddress: '0xAbC0000000000000000000000000000000AbC0',
      chainInformation: { chainId: 1 },
    } as any;

    const result = getMarketRewardsAPRs(market, LOADING_REWARDS_STATE, 1_000_000n, 500_000n);

    expect(result.borrowRewardsAPR).toBe(0n);
    expect(result.supplyRewardsAPR).toBe(0n);
  });

  it('rewardsOverwrite market with explicit APR override: uses the override directly, ignores compPerDay math', () => {
    const market = {
      rewardsOverwrite: {
        borrowRewardsAPR: 123n,
        supplyRewardsAPR: 456n,
        rewardsAssetSymbol: 'COMP',
      },
      chainInformation: { chainId: 1 },
    } as any;

    const result = getMarketRewardsAPRs(market, LOADING_REWARDS_STATE, 1_000_000n, 500_000n);

    expect(result.borrowRewardsAPR).toBe(123n);
    expect(result.supplyRewardsAPR).toBe(456n);
  });

  it('rewardsOverwrite market without explicit APR: computes via getRewardsAPR using rewardsState lookup', () => {
    const market = {
      rewardsOverwrite: {
        borrowCompPerDay: 10n * 10n ** 18n,
        supplyCompPerDay: 20n * 10n ** 18n,
        rewardsAssetSymbol: 'COMP',
      },
      marketAddress: '0xAbC0000000000000000000000000000000AbC0',
      chainInformation: { chainId: 1 },
    } as any;

    const rewardsState: RewardsState = [
      StateType.Hydrated,
      [[1, { rewardsStates: [{ comet: '0xabc0000000000000000000000000000000abc0', rewardAsset: { price: 60n * 10n ** 8n } }] }]],
    ] as any;

    const result = getMarketRewardsAPRs(market, rewardsState, 1_000_000n * 10n ** 8n, 500_000n * 10n ** 8n);

    expect(result.borrowRewardsAPR).toBeGreaterThan(0n);
    expect(result.supplyRewardsAPR).toBeGreaterThan(0n);
  });

  it('plain market (no rewardsOverwrite, not institutional): both APRs are 0', () => {
    const market = { chainInformation: { chainId: 1 } } as any;
    const result = getMarketRewardsAPRs(market, LOADING_REWARDS_STATE, 1_000_000n, 500_000n);

    expect(result.borrowRewardsAPR).toBe(0n);
    expect(result.supplyRewardsAPR).toBe(0n);
  });
});
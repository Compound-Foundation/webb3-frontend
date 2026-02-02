import { ProposalStateEnum, VoteValueEnum } from '@types';

const currentTime = Date.now() / 1000;
const futureTime = Math.floor(currentTime + 100800);

export const pendingProposal = {
  abstainVotes: BigInt(0),
  againstVotes: BigInt(0),
  description:
    "## Simple Summary\n\nGauntlet provides this initial proposal for Compound V2 -> V3 Migration.\n\n## Background\n\nFollowing community feedback, please see below an initial migration plan to align with the community's strategic preference. See the [forum post](https://www.comp.xyz/t/cip-3-compound-v2-to-v3-migration/4046/7?u=pauljlei) for more detail.\n\n\n\n- Decrease v2 daily USDC supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily USDC borrow COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI borrow COMP rewards from 241.20 to 211.20 (-30)\n- Increase v3 daily USDC borrow COMP rewards from 161.41 to 281.41 (+120)\n- Increase v3 ETH supply cap from 150k to 350k\n- Increase v3 WBTC supply cap from 6k to 12k\n- Increase storefront price factor from 50% to 60%\n\n\n## Specification\n\nThis proposal implements a number of changes using several different contracts:\n\n- v2 daily COMP rewards are updated using `_setCompSpeeds` on the `Comptroller` contract\n- v3 USDC daily COMP rewards are updated using `setBaseTrackingBorrowSpeed` on the `Configurator` contract\n- v3 USDC supply caps are updated using `updateAssetSupplyCap` on the `Configurator` contract\n- v3 USDC storefront price factor is updated using `setStoreFrontPriceFactor` on the `Configurator` contract\n\n\n*By approving this proposal, you agree that any services provided by Gauntlet shall be governed by the terms of service available at gauntlet.network/tos.*",
  endBlock: BigInt(16796793),
  eta: BigInt(1678120559),
  forVotes: BigInt(0),
  id: BigInt(154),
  proposer: '0x683a4F9915D6216f73d6Df50151725036bD26C02',
  startBlock: BigInt(16736783),
  state: {
    startTime: currentTime,
    endTime: currentTime + 116400,
    state: ProposalStateEnum.Pending,
  },
  title: 'Resume cUSDC minting',
};

export const queuedProposal = {
  abstainVotes: BigInt(0),
  againstVotes: BigInt(1),
  description:
    "## Simple Summary\n\nGauntlet provides this initial proposal for Compound V2 -> V3 Migration.\n\n## Background\n\nFollowing community feedback, please see below an initial migration plan to align with the community's strategic preference. See the [forum post](https://www.comp.xyz/t/cip-3-compound-v2-to-v3-migration/4046/7?u=pauljlei) for more detail.\n\n\n\n- Decrease v2 daily USDC supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily USDC borrow COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI borrow COMP rewards from 241.20 to 211.20 (-30)\n- Increase v3 daily USDC borrow COMP rewards from 161.41 to 281.41 (+120)\n- Increase v3 ETH supply cap from 150k to 350k\n- Increase v3 WBTC supply cap from 6k to 12k\n- Increase storefront price factor from 50% to 60%\n\n\n## Specification\n\nThis proposal implements a number of changes using several different contracts:\n\n- v2 daily COMP rewards are updated using `_setCompSpeeds` on the `Comptroller` contract\n- v3 USDC daily COMP rewards are updated using `setBaseTrackingBorrowSpeed` on the `Configurator` contract\n- v3 USDC supply caps are updated using `updateAssetSupplyCap` on the `Configurator` contract\n- v3 USDC storefront price factor is updated using `setStoreFrontPriceFactor` on the `Configurator` contract\n\n\n*By approving this proposal, you agree that any services provided by Gauntlet shall be governed by the terms of service available at gauntlet.network/tos.*",
  endBlock: BigInt(16796793),
  eta: BigInt(futureTime),
  forVotes: BigInt(9),
  id: BigInt(150),
  proposer: '0x683a4F9915D6216f73d6Df50151725036bD26C02',
  startBlock: BigInt(16736783),
  state: {
    startTime: currentTime,
    endTime: currentTime + 100800,
    state: ProposalStateEnum.Queued,
  },
  title: 'CGP Hackathon Sponsorships in 2023',
};

export const activeProposal = {
  abstainVotes: BigInt(1),
  againstVotes: BigInt(0),
  description:
    "## Simple Summary\n\nGauntlet provides this initial proposal for Compound V2 -> V3 Migration.\n\n## Background\n\nFollowing community feedback, please see below an initial migration plan to align with the community's strategic preference. See the [forum post](https://www.comp.xyz/t/cip-3-compound-v2-to-v3-migration/4046/7?u=pauljlei) for more detail.\n\n\n\n- Decrease v2 daily USDC supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily USDC borrow COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI borrow COMP rewards from 241.20 to 211.20 (-30)\n- Increase v3 daily USDC borrow COMP rewards from 161.41 to 281.41 (+120)\n- Increase v3 ETH supply cap from 150k to 350k\n- Increase v3 WBTC supply cap from 6k to 12k\n- Increase storefront price factor from 50% to 60%\n\n\n## Specification\n\nThis proposal implements a number of changes using several different contracts:\n\n- v2 daily COMP rewards are updated using `_setCompSpeeds` on the `Comptroller` contract\n- v3 USDC daily COMP rewards are updated using `setBaseTrackingBorrowSpeed` on the `Configurator` contract\n- v3 USDC supply caps are updated using `updateAssetSupplyCap` on the `Configurator` contract\n- v3 USDC storefront price factor is updated using `setStoreFrontPriceFactor` on the `Configurator` contract\n\n\n*By approving this proposal, you agree that any services provided by Gauntlet shall be governed by the terms of service available at gauntlet.network/tos.*",
  endBlock: BigInt(16796793),
  eta: BigInt(1678120559),
  forVotes: BigInt(9),
  id: BigInt(153),
  proposer: '0x683a4F9915D6216f73d6Df50151725036bD26C02',
  startBlock: BigInt(16736783),
  state: {
    startTime: currentTime,
    endTime: currentTime + 116400,
    state: ProposalStateEnum.Active,
  },
  title: 'Risk Parameter Updates for V2 and V3 WETH Comet',
};

export const proposalToExecute = {
  abstainVotes: BigInt(0),
  againstVotes: BigInt(1),
  description:
    "## Simple Summary\n\nGauntlet provides this initial proposal for Compound V2 -> V3 Migration.\n\n## Background\n\nFollowing community feedback, please see below an initial migration plan to align with the community's strategic preference. See the [forum post](https://www.comp.xyz/t/cip-3-compound-v2-to-v3-migration/4046/7?u=pauljlei) for more detail.\n\n\n\n- Decrease v2 daily USDC supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily USDC borrow COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI borrow COMP rewards from 241.20 to 211.20 (-30)\n- Increase v3 daily USDC borrow COMP rewards from 161.41 to 281.41 (+120)\n- Increase v3 ETH supply cap from 150k to 350k\n- Increase v3 WBTC supply cap from 6k to 12k\n- Increase storefront price factor from 50% to 60%\n\n\n## Specification\n\nThis proposal implements a number of changes using several different contracts:\n\n- v2 daily COMP rewards are updated using `_setCompSpeeds` on the `Comptroller` contract\n- v3 USDC daily COMP rewards are updated using `setBaseTrackingBorrowSpeed` on the `Configurator` contract\n- v3 USDC supply caps are updated using `updateAssetSupplyCap` on the `Configurator` contract\n- v3 USDC storefront price factor is updated using `setStoreFrontPriceFactor` on the `Configurator` contract\n\n\n*By approving this proposal, you agree that any services provided by Gauntlet shall be governed by the terms of service available at gauntlet.network/tos.*",
  endBlock: BigInt(16796793),
  eta: BigInt(16796793),
  forVotes: BigInt(9),
  id: BigInt(149),
  proposer: '0x683a4F9915D6216f73d6Df50151725036bD26C02',
  startBlock: BigInt(16736783),
  state: {
    startTime: currentTime,
    endTime: currentTime,
    state: ProposalStateEnum.Queued,
  },
  title: 'Increase cbETH Supply Cap in cWETHv3',
};

export const succeededProposal = {
  abstainVotes: BigInt(1),
  againstVotes: BigInt(0),
  description:
    "## Simple Summary\n\nGauntlet provides this initial proposal for Compound V2 -> V3 Migration.\n\n## Background\n\nFollowing community feedback, please see below an initial migration plan to align with the community's strategic preference. See the [forum post](https://www.comp.xyz/t/cip-3-compound-v2-to-v3-migration/4046/7?u=pauljlei) for more detail.\n\n\n\n- Decrease v2 daily USDC supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily USDC borrow COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI borrow COMP rewards from 241.20 to 211.20 (-30)\n- Increase v3 daily USDC borrow COMP rewards from 161.41 to 281.41 (+120)\n- Increase v3 ETH supply cap from 150k to 350k\n- Increase v3 WBTC supply cap from 6k to 12k\n- Increase storefront price factor from 50% to 60%\n\n\n## Specification\n\nThis proposal implements a number of changes using several different contracts:\n\n- v2 daily COMP rewards are updated using `_setCompSpeeds` on the `Comptroller` contract\n- v3 USDC daily COMP rewards are updated using `setBaseTrackingBorrowSpeed` on the `Configurator` contract\n- v3 USDC supply caps are updated using `updateAssetSupplyCap` on the `Configurator` contract\n- v3 USDC storefront price factor is updated using `setStoreFrontPriceFactor` on the `Configurator` contract\n\n\n*By approving this proposal, you agree that any services provided by Gauntlet shall be governed by the terms of service available at gauntlet.network/tos.*",
  endBlock: BigInt(16796793),
  eta: 0n,
  forVotes: BigInt(9),
  id: BigInt(151),
  proposer: '0x683a4F9915D6216f73d6Df50151725036bD26C02',
  startBlock: BigInt(16736783),
  state: {
    startTime: currentTime,
    endTime: 0,
    state: ProposalStateEnum.Succeeded,
  },
  title: 'Initialize cUSDCv3 on Polygon',
};

export const activeProposalNoVote = {
  abstainVotes: BigInt(0),
  againstVotes: BigInt(1),
  description:
    "## Simple Summary\n\nGauntlet provides this initial proposal for Compound V2 -> V3 Migration.\n\n## Background\n\nFollowing community feedback, please see below an initial migration plan to align with the community's strategic preference. See the [forum post](https://www.comp.xyz/t/cip-3-compound-v2-to-v3-migration/4046/7?u=pauljlei) for more detail.\n\n\n\n- Decrease v2 daily USDC supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily USDC borrow COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI supply COMP rewards from 241.20 to 211.20 (-30)\n- Decrease v2 daily DAI borrow COMP rewards from 241.20 to 211.20 (-30)\n- Increase v3 daily USDC borrow COMP rewards from 161.41 to 281.41 (+120)\n- Increase v3 ETH supply cap from 150k to 350k\n- Increase v3 WBTC supply cap from 6k to 12k\n- Increase storefront price factor from 50% to 60%\n\n\n## Specification\n\nThis proposal implements a number of changes using several different contracts:\n\n- v2 daily COMP rewards are updated using `_setCompSpeeds` on the `Comptroller` contract\n- v3 USDC daily COMP rewards are updated using `setBaseTrackingBorrowSpeed` on the `Configurator` contract\n- v3 USDC supply caps are updated using `updateAssetSupplyCap` on the `Configurator` contract\n- v3 USDC storefront price factor is updated using `setStoreFrontPriceFactor` on the `Configurator` contract\n\n\n*By approving this proposal, you agree that any services provided by Gauntlet shall be governed by the terms of service available at gauntlet.network/tos.*",
  endBlock: BigInt(16796793),
  eta: BigInt(1678120559),
  forVotes: BigInt(9),
  id: BigInt(152),
  proposer: '0x683a4F9915D6216f73d6Df50151725036bD26C02',
  startBlock: BigInt(16736783),
  state: {
    startTime: currentTime,
    endTime: currentTime + 116400,
    state: ProposalStateEnum.Active,
  },
  title: 'Compound V2 -> V3 Migration Phase 1',
};

export const formattedProposals = [
  pendingProposal,
  activeProposal,
  activeProposalNoVote,
  succeededProposal,
  queuedProposal,
];

export const mockReceipts = new Map();
mockReceipts.set(BigInt(153), {
  voted: true,
  value: VoteValueEnum.For,
  proposalId: BigInt(153),
});

mockReceipts.set(BigInt(152), {
  voted: false,
  value: 0,
  proposalId: BigInt(152),
});

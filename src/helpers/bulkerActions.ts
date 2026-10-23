import { defaultAbiCoder } from '@ethersproject/abi';
import { Contract } from '@ethersproject/contracts';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ethers } from 'ethers';

import MainnetBulker from '@helpers/abis/MainnetBulker';
import { Action, ActionType, BaseAssetWithAccountState, MarketDataLoaded, TokenWithAccountState } from '@types';

import { sanitizedAmountForAction } from './actions';
import { MAX_UINT256 } from './numbers';
import { isStETH } from './steth';

enum BulkerActions {
  ACTION_SUPPLY_ASSET = 'ACTION_SUPPLY_ASSET',
  ACTION_SUPPLY_NATIVE_TOKEN = 'ACTION_SUPPLY_NATIVE_TOKEN',
  ACTION_TRANSFER_ASSET = 'ACTION_TRANSFER_ASSET',
  ACTION_WITHDRAW_ASSET = 'ACTION_WITHDRAW_ASSET',
  ACTION_WITHDRAW_NATIVE_TOKEN = 'ACTION_WITHDRAW_NATIVE_TOKEN',
  ACTION_CLAIM_REWARD = 'ACTION_CLAIM_REWARD',
  ACTION_SUPPLY_STETH = 'ACTION_SUPPLY_STETH',
  ACTION_WITHDRAW_STETH = 'ACTION_WITHDRAW_STETH',
}

export interface BulkerTrxData {
  bulker: Contract;
  bulkerActions: string[];
  bulkerCallData: string[];
  bulkerCallValue: bigint;
}

export function getBulkerTrxData(
  sender: string,
  provider: JsonRpcProvider,
  market: MarketDataLoaded,
  baseAssetPre: BaseAssetWithAccountState,
  collateralAssetsPre: TokenWithAccountState[],
  actions: Action[]
): BulkerTrxData {
  const signer = provider.getSigner(sender).connectUnchecked();

  const bulker = new Contract(market.bulkerAddress, MainnetBulker, signer);
  const optimizedActions: Action[] = optimizeActions(baseAssetPre, collateralAssetsPre, actions);

  const bulkerActions: string[] = optimizedActions.map((action) =>
    ethers.utils.formatBytes32String(bulkerActionStringForAction(market, action))
  );
  const bulkerCallData: string[] = optimizedActions.map((action) =>
    bulkerActionCallDataForAction(market, sender, action)
  );
  const bulkerCallValue: bigint = bulkerActionsCallValue(market, baseAssetPre.balance, optimizedActions);

  return {
    bulker: bulker,
    bulkerActions: bulkerActions,
    bulkerCallData: bulkerCallData,
    bulkerCallValue: bulkerCallValue,
  };
}

// Applies heuristics for optimizing Bulker actions
function optimizeActions(
  baseAssetPre: BaseAssetWithAccountState,
  collateralAssetsPre: TokenWithAccountState[],
  actions: Action[]
): Action[] {
  // If we see a repay max followed by a supply max, remove the repay max and
  // set the supply amount to be the wallet balance + repay amount
  // OR If we see a withdraw max followed by a borrow max, remove the withdraw max and
  // set the withdraw amount to be the protocol balance + borrowCapacity
  let repayMaxIndex = -1;
  let repayAmount = 0n;
  let withdrawMaxIndex = -1;
  let withdrawAmount = 0n;
  const indicesToRemove: Set<number> = new Set();
  const indicesToSwap: [number, number][] = [];
  // The logic below assumes we can only have one repay and one supply action
  // in the list of actions
  const optimizedActions: Action[] = actions.map((action, i) => {
    const [type] = action;
    if (type === ActionType.Repay && action[2] === MAX_UINT256) {
      repayAmount = -action[1].balance;
      repayMaxIndex = i;
    } else if (type === ActionType.Supply) {
      if (repayMaxIndex !== -1) {
        indicesToSwap.push([repayMaxIndex, i]);
        indicesToRemove.add(i);
      }
      // We construct a new action instead of updating the old one to keep the
      // optimized transaction action state separate from the UI action state
      // e.g. what shows on the UI is different from what exactly gets executed
      // on-chain
      const supplyAmount = sanitizedAmountForAction(baseAssetPre, collateralAssetsPre, actions.slice(0, i), action);
      return [action[0], action[1], supplyAmount + repayAmount];
    } else if (type === ActionType.Withdraw && action[2] === MAX_UINT256) {
      withdrawAmount = action[1].balance;
      withdrawMaxIndex = i;
    } else if (type === ActionType.Borrow) {
      if (withdrawMaxIndex !== -1) indicesToRemove.add(withdrawMaxIndex);
      // We construct a new action instead of updating the old one to keep the
      // optimized transaction action state separate from the UI action state
      // e.g. what shows on the UI is different from what exactly gets executed
      // on-chain
      const borrowAmount = sanitizedAmountForAction(baseAssetPre, collateralAssetsPre, actions.slice(0, i), action);
      return [action[0], action[1], borrowAmount + withdrawAmount];
    }
    return action;
  });

  return indicesToSwap
    .reduce((accum: Action[], swap: [number, number]) => {
      const [from, to] = swap;
      const tempAction = accum[from];

      accum[from] = accum[to];
      accum[to] = tempAction;
      return accum;
    }, optimizedActions)
    .filter((_actions, actionIndex) => !indicesToRemove.has(actionIndex));
}

function bulkerActionStringForAction(market: MarketDataLoaded, action: Action): string {
  const [type] = action;
  switch (type) {
    case ActionType.Borrow:
    case ActionType.Withdraw:
    case ActionType.WithdrawCollateral:
      if (action[1].symbol === market.chainInformation.nativeToken.symbol) {
        return BulkerActions.ACTION_WITHDRAW_NATIVE_TOKEN;
      }
      if (isStETH(action[1].symbol)) {
        return BulkerActions.ACTION_WITHDRAW_STETH;
      }
      return BulkerActions.ACTION_WITHDRAW_ASSET;
    case ActionType.Repay:
    case ActionType.Supply:
    case ActionType.SupplyCollateral:
      if (action[1].symbol === market.chainInformation.nativeToken.symbol) {
        return BulkerActions.ACTION_SUPPLY_NATIVE_TOKEN;
      }
      if (isStETH(action[1].symbol)) {
        return BulkerActions.ACTION_SUPPLY_STETH;
      }
      return BulkerActions.ACTION_SUPPLY_ASSET;
    case ActionType.ClaimRewards:
      return BulkerActions.ACTION_CLAIM_REWARD;
    default:
      throw new Error(`Bulker action ${type} not supported`);
  }
}

function bulkerActionCallDataForAction(market: MarketDataLoaded, sender: string, action: Action): string {
  const [type] = action;
  switch (type) {
    case ActionType.Borrow:
    case ActionType.Withdraw:
    case ActionType.WithdrawCollateral:
      if (action[1].symbol === market.chainInformation.nativeToken.symbol) {
        return defaultAbiCoder.encode(['address', 'address', 'uint'], [market.marketAddress, sender, action[2]]);
      }
      if (isStETH(action[1].symbol)) {
        return defaultAbiCoder.encode(['address', 'address', 'uint'], [market.marketAddress, sender, action[2]]);
      }
      return defaultAbiCoder.encode(
        ['address', 'address', 'address', 'uint'],
        [market.marketAddress, sender, action[1].address, action[2]]
      );
    case ActionType.Repay:
    case ActionType.Supply:
    case ActionType.SupplyCollateral:
      if (action[1].symbol === market.chainInformation.nativeToken.symbol) {
        return defaultAbiCoder.encode(['address', 'address', 'uint'], [market.marketAddress, sender, action[2]]);
      }
      if (isStETH(action[1].symbol)) {
        return defaultAbiCoder.encode(['address', 'address', 'uint'], [market.marketAddress, sender, action[2]]);
      }
      return defaultAbiCoder.encode(
        ['address', 'address', 'address', 'uint'],
        [market.marketAddress, sender, action[1].address, action[2]]
      );
    case ActionType.ClaimRewards: {
      const [, , , rewardState] = action;
      return defaultAbiCoder.encode(
        ['address', 'address', 'address', 'bool'],
        [rewardState.comet, rewardState.cometRewards, sender, true]
      );
    }
    default:
      throw new Error(`Bulker action ${type} not supported`);
  }
}

function bulkerActionsCallValue(market: MarketDataLoaded, baseAssetBalance: bigint, actions: Action[]): bigint {
  const maybeSupplyNativeTokenAction = actions.find(
    (action) =>
      (action[0] === ActionType.Repay ||
        action[0] === ActionType.Supply ||
        action[0] === ActionType.SupplyCollateral) &&
      action[1].symbol === market.chainInformation.nativeToken.symbol
  );

  if (maybeSupplyNativeTokenAction === undefined) return 0n;

  const amount = maybeSupplyNativeTokenAction[2];
  // If amount is uint256.max, it implies the user is repaying all their borrow so we set `value` to be their borrow balance + buffer
  if (amount === ethers.constants.MaxUint256.toBigInt()) {
    if (maybeSupplyNativeTokenAction[0] !== ActionType.Repay || baseAssetBalance > 0)
      throw Error(`Invalid repay action: ${maybeSupplyNativeTokenAction}`);
    return (-baseAssetBalance * 1000005n) / 1000000n;
  } else {
    return amount;
  }
}

import { Contract } from '@ethersproject/contracts';

import type { Web3 } from '@contexts/Web3Context';
import Comet from '@helpers/abis/Comet';
import Rewards from '@helpers/abis/Rewards';
import { sanitizedAmountForAction, validateAllowanceForAction } from '@helpers/actions';
import { BulkerTrxData, getBulkerTrxData } from '@helpers/bulkerActions';
import {
  Action,
  ActionType,
  BaseAssetWithAccountState,
  ChainInformation,
  MarketDataLoaded,
  TokenWithAccountState,
} from '@types';

const GAS_MASK = 10000;
const GAS_SUFFIX: string = import.meta.env.VITE_V3_GAS_SUFFIX || '1234';

export enum PreEstimatedAction {
  Approve = 'approve',
  AllowOperator = 'allow-operator',
  Drip = 'drip',
  Delegate = 'delegate',
  CastVote = 'cast-vote',
  QueueProposal = 'queue-proposal',
  ExecuteProposal = 'execute-proposal',
}

export function initialEstimatedGasMap(chainInformation: ChainInformation | undefined): Map<string, number> {
  const initialGasMap = new Map();
  const chainId = chainInformation ? chainInformation.chainId : undefined;
  if (!chainId || chainId === 1 || chainId === 5) {
    //Approve Chainlink was: 58402
    //Approve USDC was: 72770
    initialGasMap.set(PreEstimatedAction.Approve, 72770);
    initialGasMap.set(PreEstimatedAction.AllowOperator, 70315);
    initialGasMap.set(PreEstimatedAction.Drip, 60000);
    initialGasMap.set(PreEstimatedAction.Delegate, 116610);
    initialGasMap.set(PreEstimatedAction.CastVote, 117824);
    initialGasMap.set(PreEstimatedAction.QueueProposal, 162020);
    initialGasMap.set(PreEstimatedAction.ExecuteProposal, 200447);
  } else if (chainId === 137) {
    //Approve Dai was: 55750
    //Approve USDC was: 78950
    initialGasMap.set(PreEstimatedAction.Approve, 78950);
    initialGasMap.set(PreEstimatedAction.AllowOperator, 72912);
    initialGasMap.set(PreEstimatedAction.Drip, 60000);
  }
  return initialGasMap;
}

export function getKeyForActions(actions: Action[]): string {
  return actions.reduce((acc, action) => {
    const [actionType, assetInfo, actionAmount] = action;
    return acc + ':' + actionType.toString() + '-' + assetInfo.symbol + '-' + actionAmount.toString();
  }, '');
}

export async function estimateGasForActions(
  web3: Web3,
  selectedMarket: MarketDataLoaded,
  baseAsset: BaseAssetWithAccountState,
  collateralAssets: TokenWithAccountState[],
  actions: Action[]
) {
  const estResult = await estimateGas(web3, selectedMarket, baseAsset, collateralAssets, actions);
  return applyGasMaskAndSuffix(estResult);
}

export function applyGasMaskAndSuffix(gasEstimate: number): number {
  if (gasEstimate === 0) {
    return 0;
  } else {
    const maskedGas = Math.floor(gasEstimate / GAS_MASK) * GAS_MASK;
    return maskedGas + Number(GAS_SUFFIX);
  }
}

async function estimateGas(
  web3: Web3,
  market: MarketDataLoaded,
  baseAsset: BaseAssetWithAccountState,
  collateralAssets: TokenWithAccountState[],
  actions: Action[]
): Promise<number> {
  let isSingleActionForBulker = false;
  if (actions.length == 1) {
    const nativeTokenSymbol = market.chainInformation.nativeToken.symbol;
    const actionAssetSymbol = actions[0][1].symbol;
    isSingleActionForBulker = actionAssetSymbol === nativeTokenSymbol || actionAssetSymbol === 'stETH';
  }

  if (actions.length == 0) {
    return 0;
  } else if (actions.length == 1 && !isSingleActionForBulker) {
    const singleAction = actions[0];
    const [actionType, assetInfo, singleActionAmount] = singleAction;
    const amount =
      actionType === ActionType.Supply || actionType === ActionType.Borrow
        ? sanitizedAmountForAction(baseAsset, collateralAssets, [], singleAction)
        : singleActionAmount;

    let trxEstimateGasFn = undefined;
    let trxFnArgs: (string | boolean)[] = [];

    switch (actionType) {
      case ActionType.Repay:
      case ActionType.Supply:
      case ActionType.SupplyCollateral:
        if (
          web3.write.provider !== undefined &&
          web3.write.chainId === web3.read.chainId &&
          web3.write.account !== undefined
        ) {
          const sender = web3.write.account;
          const signer = web3.write.provider.getSigner(sender).connectUnchecked();

          const comet = new Contract(market.marketAddress, Comet, signer);

          trxEstimateGasFn = comet.estimateGas.supply;
          trxFnArgs = [assetInfo.address, amount.toString()];

          if ((assetInfo as BaseAssetWithAccountState | TokenWithAccountState).allowance < amount) {
            return 0;
          }
        }
        break;
      case ActionType.Borrow:
      case ActionType.Withdraw:
      case ActionType.WithdrawCollateral:
        if (web3.write.provider !== undefined && web3.write.chainId === web3.read.chainId && web3.write.account) {
          const sender = web3.write.account;
          const signer = web3.write.provider.getSigner(sender).connectUnchecked();

          const comet = new Contract(market.marketAddress, Comet, signer);

          trxEstimateGasFn = comet.estimateGas.withdraw;
          trxFnArgs = [assetInfo.address, amount.toString()];
        }
        break;
      case ActionType.ClaimRewards:
        {
          const rewardsAccountState = singleAction[3];
          if (
            web3.write.provider !== undefined &&
            web3.write.chainId === web3.read.chainId &&
            web3.write.account !== undefined
          ) {
            const sender = web3.write.account;
            const signer = web3.write.provider.getSigner(sender).connectUnchecked();

            const rewards = new Contract(rewardsAccountState.cometRewards, Rewards, signer);

            trxEstimateGasFn = rewards.estimateGas.claim;
            trxFnArgs = [rewardsAccountState.comet, sender, true];
          }
        }
        break;
      default:
        throw new Error(`Cannot execute ActionType ${actionType} as a single action`);
    }

    let gasLimit = 0;

    if (trxEstimateGasFn) {
      try {
        const estimatedGasUsage = (await trxEstimateGasFn(...trxFnArgs, { value: 0n })).toNumber();
        gasLimit = Math.round(Number(estimatedGasUsage * 1.2));
      } catch (e) {
        console.log('Error estimating gas: ', e);
        gasLimit = 0;
      }
    } else {
      console.error('Could not estimate gas for: ', actions);
      gasLimit = 0;
    }

    return gasLimit;
  } else if (
    isSingleActionForBulker &&
    validateAllowanceForAction(baseAsset, collateralAssets, actions, actions[0]) !== 'ok'
  ) {
    return 0;
  } else {
    let gasLimit = 0;
    if (web3.write.provider !== undefined && web3.write.chainId === web3.read.chainId && web3.write.account) {
      const { bulker, bulkerActions, bulkerCallData, bulkerCallValue }: BulkerTrxData = getBulkerTrxData(
        web3.write.account,
        web3.write.provider,
        market,
        baseAsset,
        collateralAssets,
        actions
      );

      const trxEstimateGasFn = bulker.estimateGas.invoke;
      const trxFnArgs = [bulkerActions, bulkerCallData];

      try {
        const estimatedGasUsage = (await trxEstimateGasFn(...trxFnArgs, { value: bulkerCallValue })).toNumber();
        gasLimit = Math.round(Number(estimatedGasUsage * 1.2));
      } catch (e) {
        console.log('Error estimating gas: ', e);
        gasLimit = 0;
      }
    }

    return gasLimit;
  }
}

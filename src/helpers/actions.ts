import { Action, ActionType, BaseAssetWithAccountState, PendingAction, Token, TokenWithAccountState } from '@types';

import { MAX_UINT256, getCapacity, getCollateralValue, takePercentage, BORROW_MAX_SCALE, formatValue } from './numbers';
import { isStETH } from './steth';
import { isWrappedActionEntry } from './wrappedActions';

export function isSameToken(token1: Token, token2: Token): boolean {
  return token1.address === token2.address && token1.symbol === token2.symbol;
}

export function isSameAction(action1: Action | PendingAction, action2: Action | PendingAction): boolean {
  if (action1[0] === ActionType.ClaimRewards) {
    return isSameClaimAction(action1, action2);
  }
  return action1[0] === action2[0] && isSameToken(action1[1], action2[1]);
}

export function isSameClaimAction(action1: Action | PendingAction, action2: Action | PendingAction): boolean {
  return (
    action1[0] === ActionType.ClaimRewards &&
    action2[0] === ActionType.ClaimRewards &&
    action1[3].comet === action2[3].comet
  );
}

export function displayTextForActionType(type: ActionType): string {
  switch (type) {
    case ActionType.Borrow:
      return 'Borrow';
    case ActionType.ClaimRewards:
      return 'Claim';
    case ActionType.Repay:
      return 'Repay';
    case ActionType.Supply:
    case ActionType.SupplyCollateral:
      return 'Supply';
    case ActionType.Withdraw:
    case ActionType.WithdrawCollateral:
      return 'Withdraw';
    default:
      return '';
  }
}

type ActionsReducer = {
  [key: string]: { balance: bigint; walletBalance: bigint };
};

type UpdatedBalances = {
  baseAsset: BaseAssetWithAccountState;
  collateralAssets: TokenWithAccountState[];
  collateralValue: bigint;
  liquidationCapacity: bigint;
};

export const calculateUpdatedBalances = (
  baseAsset: BaseAssetWithAccountState,
  collateralAssets: TokenWithAccountState[],
  actions: Action[]
): UpdatedBalances => {
  const tokensWithUpdatedBalances = actions.reduce((acc, action, index) => {
    const [actionType, asset, amount] = action;
    if (actionType === ActionType.ClaimRewards) {
      return acc;
    }
    const dataForAsset: { balance: bigint; walletBalance: bigint } = acc[asset.address] || {
      balance: 0n,
      walletBalance: 0n,
    };

    if (
      actionType === ActionType.SupplyCollateral ||
      actionType === ActionType.Supply ||
      actionType === ActionType.Repay
    ) {
      let difference: bigint;

      if (amount === MAX_UINT256) {
        difference = sanitizedAmountForAction(baseAsset, collateralAssets, actions.slice(0, index), action);
      } else {
        difference = amount;
      }

      dataForAsset.balance += difference;
      dataForAsset.walletBalance -= difference;
    } else if (
      actionType === ActionType.WithdrawCollateral ||
      actionType === ActionType.Withdraw ||
      actionType === ActionType.Borrow
    ) {
      let difference: bigint;

      if (amount === MAX_UINT256) {
        difference = sanitizedAmountForAction(baseAsset, collateralAssets, actions.slice(0, index), action);
      } else {
        difference = amount;
      }

      dataForAsset.balance -= difference;
      dataForAsset.walletBalance += difference;
    }
    return {
      ...acc,
      [asset.address]: dataForAsset,
    };
  }, {} as ActionsReducer);

  const maybeUpdatedBaseAsset = tokensWithUpdatedBalances[baseAsset.address] || { balance: 0n, walletBalance: 0n };
  const updatedCollateralAssets = collateralAssets.map((asset) => {
    const maybeUpdatedAsset = tokensWithUpdatedBalances[asset.address] || { balance: 0n, walletBalance: 0n };
    return {
      ...asset,
      balance: asset.balance + maybeUpdatedAsset.balance,
      walletBalance: asset.walletBalance + maybeUpdatedAsset.walletBalance,
    };
  });

  return {
    baseAsset: {
      ...baseAsset,
      balance: baseAsset.balance + maybeUpdatedBaseAsset.balance,
      walletBalance: baseAsset.walletBalance + maybeUpdatedBaseAsset.walletBalance,
      borrowCapacity: getCapacity(
        'borrow',
        baseAsset.decimals,
        baseAsset.price,
        baseAsset.symbol,
        updatedCollateralAssets
      ),
    },
    collateralAssets: updatedCollateralAssets,
    collateralValue: getCollateralValue(updatedCollateralAssets),
    liquidationCapacity: getCapacity(
      'liquidation',
      baseAsset.decimals,
      baseAsset.price,
      baseAsset.symbol,
      updatedCollateralAssets
    ),
  };
};

export function sanitizedAmountForAction(
  baseAssetPre: BaseAssetWithAccountState,
  collateralAssetsPre: TokenWithAccountState[],
  actions: Action[],
  actionToAdd: Action
): bigint {
  const [actionType, , amount] = actionToAdd;
  if (actionType === ActionType.Supply && amount === MAX_UINT256) {
    const { baseAsset } = calculateUpdatedBalances(baseAssetPre, collateralAssetsPre, actions);
    return baseAsset.walletBalance;
  } else if (actionType === ActionType.Borrow && amount === MAX_UINT256) {
    const { baseAsset } = calculateUpdatedBalances(baseAssetPre, collateralAssetsPre, actions);
    const borrowBalance = baseAsset.balance < 0n ? -baseAsset.balance : 0n;
    return takePercentage(baseAsset.borrowCapacity - borrowBalance, BORROW_MAX_SCALE);
  } else if (actionType === ActionType.Repay && amount === MAX_UINT256) {
    return -actionToAdd[1].balance;
  } else if (actionType === ActionType.Withdraw && amount === MAX_UINT256) {
    return actionToAdd[1].balance;
  } else if (actionType === ActionType.WithdrawCollateral && amount === MAX_UINT256) {
    return actionToAdd[1].balance;
  }

  return amount;
}

type Validity = 'ok' | [false, string];

/**
 * Why `action` would lend or withdraw the base token as a direct Comet supplier, given the base
 * balance the earlier actions leave: a base supply or a base withdrawal always would, and so would a
 * repay larger than the debt. A full repay (`MAX_UINT256`) repays the debt exactly.
 */
function directBaseLendingProblem(baseAsset: BaseAssetWithAccountState, action: Action): string | undefined {
  const [actionType, , amount] = action;
  if (actionType === ActionType.Supply || actionType === ActionType.Withdraw) {
    return 'Base Lending Goes Through The Wrapper';
  }
  return actionType === ActionType.Repay ? excessRepayProblem(baseAsset, amount) : undefined;
}

/** Why a repay of `amount` would leave a direct Comet supply: it is larger than the debt. */
function excessRepayProblem(baseAsset: BaseAssetWithAccountState, amount: bigint): string | undefined {
  const borrowBalance = baseAsset.balance < 0n ? -baseAsset.balance : 0n;
  return amount !== MAX_UINT256 && amount > borrowBalance ? 'Amount Exceeds Borrow Balance' : undefined;
}

/**
 * The selected market's base supply and withdrawal go through its wrapper for this session. The
 * wrapper's approval is requested at submission, for exactly the amount, so a base supply needs no
 * allowance when it is queued.
 */
export type WrappedBaseRules = {
  /** Why a base supply cannot be queued now, as the amount form shows it, or undefined. */
  supplyBlockedReason: string | undefined;
  /** Why a base withdrawal cannot be queued now, as the amount form shows it, or undefined. */
  withdrawBlockedReason: string | undefined;
  /**
   * The most a partial withdrawal through the wrapper pays now, in base units: the position less
   * the wrapper's rounding buffer, within the market's cash. Undefined until the position is read.
   */
  maxPartialWithdrawal: bigint | undefined;
  /** Whether a full exit can pay now. A maximum withdrawal is a full exit. */
  canWithdrawAll: boolean;
  /**
   * What a full exit pays, in base units: the position less the wrapper's rounding buffer.
   * Undefined until the position is read.
   */
  fullExitCash?: bigint;
};

export type ActionRules = {
  /** Set on the wrapped route, where the market's wrapper carries out base supply and withdrawal. */
  wrappedBase?: WrappedBaseRules;
};

/**
 * Why `actionToAdd` cannot be queued on the wrapped route, after `actions`. A base supply or
 * withdrawal needs its release control open and the route eligible. A queue holds at most one of
 * the two, since each is a separate wrapper action. A supply waits until a direct borrow is repaid
 * in its own submission: the wrapper's steps go before the direct actions, so the supply could
 * spend what a queued repay needs. A withdrawal pays at most what the wrapper pays now. A repay may
 * not exceed the debt, since the excess would be a direct Comet supply.
 */
function wrappedBaseProblem(
  rules: WrappedBaseRules,
  baseAssetPre: BaseAssetWithAccountState,
  baseAsset: BaseAssetWithAccountState,
  actions: Action[],
  actionToAdd: Action
): string | undefined {
  const [actionType, , amount] = actionToAdd;
  const hasQueued = (type: ActionType) => actions.some((action) => action[0] === type);
  switch (actionType) {
    case ActionType.Supply:
      if (rules.supplyBlockedReason !== undefined) return rules.supplyBlockedReason;
      if (baseAssetPre.balance < 0n || hasQueued(ActionType.Repay)) return 'Repay Your Borrow First, Separately';
      return hasQueued(ActionType.Withdraw) ? 'Submit Supply And Withdrawal Separately' : undefined;
    case ActionType.Withdraw:
      if (rules.withdrawBlockedReason !== undefined) return rules.withdrawBlockedReason;
      if (hasQueued(ActionType.Supply)) return 'Submit Supply And Withdrawal Separately';
      if (rules.maxPartialWithdrawal === undefined) return 'Balance Not Loaded Yet';
      if (amount === MAX_UINT256) return rules.canWithdrawAll ? undefined : 'Withdrawal Unavailable Now';
      return amount > rules.maxPartialWithdrawal ? 'Amount Exceeds Withdrawable Balance' : undefined;
    case ActionType.Repay:
      return excessRepayProblem(baseAsset, amount);
    default:
      return undefined;
  }
}

export function validateAddingAction(
  baseAssetPre: BaseAssetWithAccountState,
  collateralAssetsPre: TokenWithAccountState[],
  actions: Action[],
  actionToAdd: Action,
  rules: ActionRules = {}
): Validity {
  // A wrapper action has its own review and is never queued with direct actions.
  if (isWrappedActionEntry(actionToAdd)) {
    return [false, 'Wrapped Actions Are Submitted Separately'];
  }
  const { baseAsset, collateralAssets } = calculateUpdatedBalances(baseAssetPre, collateralAssetsPre, actions);

  const [actionType] = actionToAdd;
  const wrappedProblem =
    rules.wrappedBase === undefined
      ? undefined
      : wrappedBaseProblem(rules.wrappedBase, baseAssetPre, baseAsset, actions, actionToAdd);
  if (wrappedProblem !== undefined) {
    return [false, wrappedProblem];
  }

  switch (actionType) {
    case ActionType.Borrow: {
      const amount = actionToAdd[2];

      const borrowBalance = baseAsset.balance < 0n ? -baseAsset.balance : 0n;
      const newBorrowBalance = borrowBalance + amount;

      const isMax = amount === MAX_UINT256;
      const amountExceedsBorrowCapacity = !isMax && newBorrowBalance > baseAsset.borrowCapacity;
      const maxBorrowAmount = takePercentage(baseAsset.borrowCapacity - borrowBalance, BORROW_MAX_SCALE);
      const lessThanMinBorrow =
        (!isMax && newBorrowBalance < baseAsset.minBorrow) ||
        (isMax && maxBorrowAmount + borrowBalance < baseAsset.minBorrow);
      const notEnoughLiquidity =
        (!isMax && amount > baseAsset.balanceOfComet) || (isMax && maxBorrowAmount > baseAsset.balanceOfComet);

      if (amountExceedsBorrowCapacity) {
        return [false, 'Amount Exceeds Borrow Capacity'];
      } else if (lessThanMinBorrow) {
        const minBorrowAmount = formatValue(baseAssetPre.decimals, baseAssetPre.minBorrow);
        return [false, `Minimum Borrow of ${minBorrowAmount} ${baseAssetPre.symbol}`];
      } else if (notEnoughLiquidity) {
        return [false, 'Not Enough Market Liquidity'];
      } else if (baseAsset.balance > 0n) {
        return [false, `Must Withdraw Full ${baseAsset.symbol} Balance`];
      }

      break;
    }
    case ActionType.Supply: {
      const amount = actionToAdd[2];

      const isMax = amount === MAX_UINT256;
      if (!isMax && amount > baseAsset.walletBalance) {
        return [false, 'Amount Exceeds Wallet Balance'];
      } else if (baseAsset.balance < 0n) {
        return [false, 'Must Repay Borrow First'];
      }
      break;
    }
    case ActionType.Repay: {
      const amount = actionToAdd[2];
      const borrowBalance = baseAsset.balance < 0n ? -baseAsset.balance : 0n;

      const isMax = amount === MAX_UINT256;
      if ((isMax && baseAsset.walletBalance < borrowBalance) || (!isMax && amount > baseAsset.walletBalance)) {
        return [false, 'Amount Exceeds Wallet Balance'];
      }
      break;
    }
    case ActionType.SupplyCollateral: {
      const collateralAsset = collateralAssets.find((asset) => isSameToken(asset, actionToAdd[1]));
      if (collateralAsset === undefined) {
        return [false, "Collateral Asset Doesn't Exist"];
      }

      const amount = actionToAdd[2];
      const amountExceedsWalletBalance = amount > collateralAsset.walletBalance;
      const overSupplyCap = amount + collateralAsset.totalSupply > collateralAsset.supplyCap;
      if (amountExceedsWalletBalance) {
        return [false, 'Amount Exceeds Wallet Balance'];
      } else if (overSupplyCap) {
        return [false, 'Amount Exceeds Supply Cap'];
      }
      break;
    }
    case ActionType.Withdraw: {
      const amount = actionToAdd[2];
      const [borrowBalance, earnBalance] = baseAsset.balance < 0n ? [-baseAsset.balance, 0n] : [0n, baseAsset.balance];

      const isMax = amount === MAX_UINT256;
      const mustRepayBorrow = borrowBalance > 0n;
      // On the wrapped route the wrapper pays the withdrawal, and `wrappedBaseProblem` has checked it
      // against what the wrapper pays now, net of its buffer and within the market's cash. The
      // gross balance is never withdrawn from Comet, so it is not compared with the market's cash.
      const isWrapped = rules.wrappedBase !== undefined;
      const amountExceedsBalance = !isWrapped && !isMax && amount > earnBalance;
      const notEnoughLiquidity =
        !isWrapped &&
        ((isMax && earnBalance > baseAsset.balanceOfComet) || (!isMax && amount > baseAsset.balanceOfComet));
      if (mustRepayBorrow) {
        return [false, 'Must Repay Borrow First'];
      } else if (amountExceedsBalance) {
        return [false, 'Amount Exceeds Balance'];
      } else if (notEnoughLiquidity) {
        return [false, 'Not Enough Market Liquidity'];
      }
      break;
    }
    case ActionType.WithdrawCollateral: {
      const collateralAsset = collateralAssets.find((asset) => isSameToken(asset, actionToAdd[1]));
      if (collateralAsset === undefined) {
        return [false, "Collateral Asset Doesn't Exist"];
      }
      const amount = actionToAdd[2];
      const borrowBalance = baseAsset.balance < 0n ? -baseAsset.balance : 0n;

      const assetWithInputValue: TokenWithAccountState = { ...collateralAsset, balance: amount };
      const borrowCapacityDecrease = getCapacity('borrow', baseAsset.decimals, baseAsset.price, baseAsset.symbol, [
        assetWithInputValue,
      ]);
      const newBorrowCapacity = baseAsset.borrowCapacity - borrowCapacityDecrease;
      const isMax = amount === MAX_UINT256;
      const amountExceedsBalance = !isMax && amount > collateralAsset.balance;
      const undercollateralizedBorrow = borrowBalance !== 0n && newBorrowCapacity < borrowBalance;
      if (amountExceedsBalance) {
        return [false, 'Amount Exceeds Balance'];
      } else if (undercollateralizedBorrow) {
        return [false, 'Borrow Balance Will Exceed Capacity'];
      }
    }
  }
  return 'ok';
}

/**
 * Whether any action in the queue would lend or withdraw the base token as a direct Comet supplier:
 * a base supply, a base withdrawal, or a repay larger than the debt the earlier actions leave. On
 * the wrapped route the wrapper carries out base supply and withdrawal, so none of these may reach
 * Comet or the Bulker.
 */
export function lendsBaseDirectly(
  baseAssetPre: BaseAssetWithAccountState,
  collateralAssetsPre: TokenWithAccountState[],
  actions: Action[]
): boolean {
  return actions.some((action, index) => {
    const { baseAsset } = calculateUpdatedBalances(baseAssetPre, collateralAssetsPre, actions.slice(0, index));
    return directBaseLendingProblem(baseAsset, action) !== undefined;
  });
}

export function validateAllowanceForAction(
  baseAssetPre: BaseAssetWithAccountState,
  collateralAssetsPre: TokenWithAccountState[],
  actions: Action[],
  actionToAdd: Action,
  rules: ActionRules = {}
): Validity {
  const { baseAsset, collateralAssets } = calculateUpdatedBalances(baseAssetPre, collateralAssetsPre, actions);

  const [actionType] = actionToAdd;
  // The wrapper's approval is requested at submission, for exactly the supplied amount.
  if (rules.wrappedBase !== undefined && actionType === ActionType.Supply) {
    return 'ok';
  }

  switch (actionType) {
    case ActionType.Supply: {
      const amount = actionToAdd[2];
      const isMax = amount === MAX_UINT256;
      if ((isMax && baseAsset.allowance < baseAsset.walletBalance) || (!isMax && baseAsset.allowance < amount)) {
        return [false, 'Approval Failed'];
      }

      break;
    }
    case ActionType.Repay: {
      const amount = actionToAdd[2];
      const isMax = amount === MAX_UINT256;
      if ((isMax && baseAsset.allowance < baseAsset.walletBalance) || (!isMax && baseAsset.allowance < amount)) {
        return [false, 'Approval Failed'];
      }
      break;
    }
    case ActionType.SupplyCollateral: {
      const collateralAsset = collateralAssets.find((asset) => isSameToken(asset, actionToAdd[1]));
      if (collateralAsset === undefined) {
        return [false, "Collateral Asset Doesn't Exist"];
      }

      const amount = actionToAdd[2];
      const isMax = amount === MAX_UINT256;

      const needsAllowance =
        (isMax && collateralAsset.allowance < collateralAsset.allowance) ||
        (!isMax && collateralAsset.allowance < amount);

      // TODO: the collateral asset should determine it's own allowance against bulker
      // so we can cut down on explicit bulker allow checks
      const needsBulkerAllowance =
        (isMax && collateralAsset.bulkerAllowance < collateralAsset.bulkerAllowance) ||
        (!isMax && collateralAsset.bulkerAllowance < amount);

      if (
        (!isStETH(collateralAsset.symbol) && needsAllowance) ||
        (isStETH(collateralAsset.symbol) && needsBulkerAllowance)
      ) {
        return [false, 'Approval Failed'];
      }
      break;
    }
  }
  return 'ok';
}

export function getActionFromPendingAction(pendingAction: PendingAction, amount: bigint): Action {
  return [pendingAction[0], pendingAction[1], amount] as Action;
}

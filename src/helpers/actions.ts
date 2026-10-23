import { Action, ActionType, BaseAssetWithAccountState, PendingAction, Token, TokenWithAccountState } from '@types';

import { MAX_UINT256, getCapacity, getCollateralValue, takePercentage, BORROW_MAX_SCALE, formatValue } from './numbers';
import { isStETH } from './steth';

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

export function validateAddingAction(
  baseAssetPre: BaseAssetWithAccountState,
  collateralAssetsPre: TokenWithAccountState[],
  actions: Action[],
  actionToAdd: Action
): Validity {
  const { baseAsset, collateralAssets } = calculateUpdatedBalances(baseAssetPre, collateralAssetsPre, actions);

  const [actionType] = actionToAdd;
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
      const amountExceedsBalance = !isMax && amount > earnBalance;
      const notEnoughLiquidity =
        (isMax && earnBalance > baseAsset.balanceOfComet) || (!isMax && amount > baseAsset.balanceOfComet);
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

export function validateAllowanceForAction(
  baseAssetPre: BaseAssetWithAccountState,
  collateralAssetsPre: TokenWithAccountState[],
  actions: Action[],
  actionToAdd: Action
): Validity {
  const { baseAsset, collateralAssets } = calculateUpdatedBalances(baseAssetPre, collateralAssetsPre, actions);

  const [actionType] = actionToAdd;

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

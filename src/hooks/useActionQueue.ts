import { useEffect, useReducer, useRef, useState } from 'react';

import { isSameAction, isSameToken } from '@helpers/actions';
import { filterMap } from '@helpers/functions';
import { getRewardsForMarket } from '@helpers/rewards';
import {
  Action,
  ActionType,
  ActionQueue,
  BaseAssetWithAccountState,
  MarketDataState,
  PendingAction,
  RewardsState,
  TokenWithAccountState,
} from '@types';

enum QueueActionType {
  AddOrUpdate = 'add-or-update',
  Clear = 'clear',
  Remove = 'remove',
}

type AddOrUpdateAction = [QueueActionType.AddOrUpdate, Action];
type ClearAction = [QueueActionType.Clear];
type RemoveAction = [QueueActionType.Remove, Action];

type QueueAction = AddOrUpdateAction | ClearAction | RemoveAction;

function actionReducer(currentActions: Action[], queueAction: QueueAction): Action[] {
  const [type] = queueAction;
  let actions: Action[];
  switch (type) {
    case QueueActionType.AddOrUpdate: {
      const actionIndex = currentActions.findIndex((action) => isSameAction(action, queueAction[1]));

      if (actionIndex === -1) {
        actions = [...currentActions, queueAction[1]];
      } else {
        actions = currentActions.map((action, index) => (index === actionIndex ? queueAction[1] : action));
      }
      break;
    }
    case QueueActionType.Clear:
      actions = [];
      break;
    case QueueActionType.Remove:
      actions = currentActions.filter((currentAction) => !isSameAction(currentAction, queueAction[1]));
      break;
    default:
      throw new Error();
  }
  return actions;
}

/**
 * useActionQueue is a hook that keeps track of pending bulker actions.
 */
export function useActionQueue(
  market: MarketDataState,
  onActionsChanged: (actions: Action[]) => void,
  account?: string
): ActionQueue {
  const [actions, updateActions] = useReducer(actionReducer, []);
  const [pendingAction, setPendingAction] = useState<PendingAction | undefined>(undefined);
  const [actionsToAdd, setActionsToAdd] = useState<{ [key: string]: Action[] }>({});
  const marketRef = useRef(market[1]?.marketAddress);

  useEffect(() => {
    if (market[1] !== undefined && marketRef.current !== market[1].marketAddress) {
      marketRef.current = market[1]?.marketAddress;
      clearActions();
      actionsToAdd[marketRef.current]?.forEach((action: Action) => {
        addOrUpdateAction(action);
      });
      setActionsToAdd({
        ...actionsToAdd,
        [marketRef.current]: [],
      });
    }
  }, [market[1]?.marketAddress, account, actionsToAdd, setActionsToAdd]);

  useEffect(() => {
    onActionsChanged(actions);
  }, [actions]);

  const addOrUpdateAction = (action: Action) => {
    updateActions([QueueActionType.AddOrUpdate, action]);
  };

  const clearActions = () => {
    updateActions([QueueActionType.Clear]);
  };

  const queueActions = (market: string, actions: Action[]) => {
    setActionsToAdd({
      ...actionsToAdd,
      [market]: actions,
    });
  };

  const removeAction = (action: Action) => {
    updateActions([QueueActionType.Remove, action]);
  };

  const getActions = (
    baseAsset: BaseAssetWithAccountState,
    collateralAssets: TokenWithAccountState[],
    rewardsState: RewardsState
  ): Action[] => {
    return filterMap<Action, Action>(actions, (action) => {
      switch (action[0]) {
        case ActionType.Borrow:
        case ActionType.Repay:
        case ActionType.Supply:
        case ActionType.Withdraw:
          return [action[0], baseAsset, action[2]];
        case ActionType.SupplyCollateral:
        case ActionType.WithdrawCollateral: {
          const asset =
            collateralAssets.find((collateralAsset) => isSameToken(collateralAsset, action[1])) || action[1];
          return [action[0], asset, action[2]];
        }
        case ActionType.ClaimRewards: {
          const rewards = getRewardsForMarket(rewardsState, action[3]);
          if (rewards === undefined) return undefined;
          return [action[0], rewards.rewardAsset, rewards.amountOwed, rewards];
        }
      }
    });
  };

  const getPendingAction = (
    baseAsset: BaseAssetWithAccountState,
    collateralAssets: TokenWithAccountState[]
  ): PendingAction | undefined => {
    if (pendingAction === undefined) return undefined;

    switch (pendingAction[0]) {
      case ActionType.Borrow:
      case ActionType.Repay:
      case ActionType.Supply:
      case ActionType.Withdraw:
        return [pendingAction[0], baseAsset, pendingAction[2]];
      case ActionType.SupplyCollateral: {
        const supplyAsset =
          collateralAssets.find((collateralAsset) => isSameToken(collateralAsset, pendingAction[1])) ||
          pendingAction[1];
        return [pendingAction[0], supplyAsset, pendingAction[2]];
      }
      case ActionType.WithdrawCollateral: {
        const asset =
          collateralAssets.find((collateralAsset) => isSameToken(collateralAsset, pendingAction[1])) ||
          pendingAction[1];
        return [pendingAction[0], asset, baseAsset, pendingAction[3]];
      }
    }
  };

  return {
    addOrUpdateAction,
    clearActions,
    queueActions,
    getActions,
    getPendingAction,
    removeAction,
    setPendingAction,
  };
}

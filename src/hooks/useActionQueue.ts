import { useEffect, useReducer } from 'react';

import { isSameAction, isSameToken } from '@helpers/actions';
import { filterMap } from '@helpers/functions';
import { getRewardsForMarket } from '@helpers/rewards';
import { assertDirectActions } from '@helpers/wrappedActions';
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

/** The wallet session a queue belongs to. */
export type QueueSession = {
  account: string | undefined;
  /** The wallet connection: the wagmi connector's `uid`, which is different for each connector. */
  connector: string | undefined;
};

const NO_SESSION: QueueSession = { account: undefined, connector: undefined };

/** The session and market a queue was built for, each as a key. */
type QueueIdentity = { session: string; market: string };

type QueueState = {
  identity: QueueIdentity;
  actions: Action[];
  pendingAction: PendingAction | undefined;
  /** Actions to queue when a market is next selected, by market key. They belong to `identity`. */
  deferred: Record<string, Action[]>;
};

enum QueueActionType {
  AddOrUpdate = 'add-or-update',
  Clear = 'clear',
  Remove = 'remove',
  SetPending = 'set-pending',
  Defer = 'defer',
  Reset = 'reset',
}

// Every change except a reset carries the identity key its caller rendered with. It applies only
// while that identity holds, so a callback kept from an earlier session or market changes nothing.
type AddOrUpdateAction = [QueueActionType.AddOrUpdate, string, Action];
type ClearAction = [QueueActionType.Clear, string];
type RemoveAction = [QueueActionType.Remove, string, Action];
type SetPendingAction = [QueueActionType.SetPending, string, PendingAction | undefined];
type DeferAction = [QueueActionType.Defer, string, string, Action[]];
type ResetAction = [QueueActionType.Reset, QueueIdentity];

type QueueAction = AddOrUpdateAction | ClearAction | RemoveAction | SetPendingAction | DeferAction | ResetAction;

function sessionKey({ account, connector }: QueueSession): string {
  return `${account?.toLowerCase() ?? ''}|${connector ?? ''}`;
}

/** A market is its chain and Comet address. One Comet address can be listed on two chains. */
function marketKey(chainId: number, marketAddress: string): string {
  return `${chainId}:${marketAddress.toLowerCase()}`;
}

function identityKey({ session, market }: QueueIdentity): string {
  return `${session}#${market}`;
}

function emptyQueue(identity: QueueIdentity): QueueState {
  return { identity, actions: [], pendingAction: undefined, deferred: {} };
}

function addOrUpdate(actions: Action[], action: Action): Action[] {
  const actionIndex = actions.findIndex((queued) => isSameAction(queued, action));
  if (actionIndex === -1) return [...actions, action];
  return actions.map((queued, index) => (index === actionIndex ? action : queued));
}

function queueReducer(state: QueueState, queueAction: QueueAction): QueueState {
  if (queueAction[0] === QueueActionType.Reset) {
    const identity = queueAction[1];
    if (identityKey(identity) === identityKey(state.identity)) return state;
    // Nothing queued, open or deferred carries over to a new session or market. When only the
    // market changed, the actions deferred for that market are queued.
    const replay = identity.session === state.identity.session ? state.deferred[identity.market] ?? [] : [];
    return { ...emptyQueue(identity), actions: replay.reduce(addOrUpdate, []) };
  }

  if (queueAction[1] !== identityKey(state.identity)) return state;
  switch (queueAction[0]) {
    case QueueActionType.AddOrUpdate:
      return { ...state, actions: addOrUpdate(state.actions, queueAction[2]) };
    case QueueActionType.Clear:
      return { ...state, actions: [] };
    case QueueActionType.Remove: {
      const removed = queueAction[2];
      return { ...state, actions: state.actions.filter((action) => !isSameAction(action, removed)) };
    }
    case QueueActionType.SetPending:
      return { ...state, pendingAction: queueAction[2] };
    case QueueActionType.Defer:
      return { ...state, deferred: { ...state.deferred, [queueAction[2]]: queueAction[3] } };
    default:
      throw new Error();
  }
}

/**
 * useActionQueue is a hook that keeps track of pending bulker actions.
 *
 * The queue, the open amount form and deferred actions belong to the session (account and
 * connector) and the market (chain and Comet) they were made for. A change of either clears them
 * all in the same render. A market change then queues the actions deferred for the new market.
 */
export function useActionQueue(
  market: MarketDataState,
  onActionsChanged: (actions: Action[]) => void,
  session: QueueSession = NO_SESSION
): ActionQueue {
  const selectedMarket = market[1];
  const identity: QueueIdentity = {
    session: sessionKey(session),
    market:
      selectedMarket === undefined
        ? ''
        : marketKey(selectedMarket.chainInformation.chainId, selectedMarket.marketAddress),
  };
  const key = identityKey(identity);
  const [state, updateQueue] = useReducer(queueReducer, identity, emptyQueue);

  // React discards this render and renders again with the reset applied, so no committed render
  // shows the previous session's or market's queue.
  if (identityKey(state.identity) !== key) {
    updateQueue([QueueActionType.Reset, identity]);
  }
  const isCurrent = identityKey(state.identity) === key;
  const actions = isCurrent ? state.actions : [];
  const pendingAction = isCurrent ? state.pendingAction : undefined;

  useEffect(() => {
    onActionsChanged(state.actions);
  }, [state.actions]);

  // A wrapper action has its own review and lifecycle. Refusing one here, with a typed error,
  // keeps the queue and the Bulker from ever holding one.
  const addOrUpdateAction = (action: Action) => {
    assertDirectActions([action]);
    updateQueue([QueueActionType.AddOrUpdate, key, action]);
  };

  const clearActions = () => {
    updateQueue([QueueActionType.Clear, key]);
  };

  const queueActions = (chainId: number, marketAddress: string, actionsToQueue: Action[]) => {
    assertDirectActions(actionsToQueue);
    updateQueue([QueueActionType.Defer, key, marketKey(chainId, marketAddress), actionsToQueue]);
  };

  const removeAction = (action: Action) => {
    updateQueue([QueueActionType.Remove, key, action]);
  };

  const setPendingAction = (pendingAction?: PendingAction) => {
    updateQueue([QueueActionType.SetPending, key, pendingAction]);
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

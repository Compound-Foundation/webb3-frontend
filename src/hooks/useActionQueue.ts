import { useEffect, useReducer, useRef } from 'react';

import type { WriteWeb3 } from '@contexts/Web3Context';
import { addsSecondAction, isSameAction, isSameToken } from '@helpers/actions';
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

/**
 * The wallet session a queue belongs to. The wallet's network is not part of it, so a queue made
 * while the wallet is on another network survives the switch to the market's network and can then
 * be submitted.
 */
export type QueueSession = {
  account: string | undefined;
  /** The wallet connection: the wagmi connector's `uid`, which is different for each connector. */
  connector: string | undefined;
  /** wagmi's connection status. A reconnect with the same account and connector changes it. */
  status: WriteWeb3['status'];
};

const NO_SESSION: QueueSession = { account: undefined, connector: undefined, status: 'disconnected' };

/** The session and market a queue was built for, each as a key. */
export type QueueIdentity = { session: string; market: string };

export type QueueState = {
  identity: QueueIdentity;
  /** Counts resets, so a return to an earlier session and market is a new visit. */
  visit: number;
  actions: Action[];
  pendingAction: PendingAction | undefined;
  /** Actions to queue when a market is next selected, by market key. They belong to `identity`. */
  deferred: Record<string, Action[]>;
};

export enum QueueActionType {
  AddOrUpdate = 'add-or-update',
  Clear = 'clear',
  Remove = 'remove',
  SetPending = 'set-pending',
  Defer = 'defer',
  Reset = 'reset',
}

// Every change except a reset carries the visit key its caller rendered with. It applies only
// during that visit, so a callback kept from an earlier session or market, or from an earlier visit
// to the same ones, changes nothing. An addition and a reset also carry whether the queue is limited
// to one action. The session and market decide the limit, so it holds for the whole visit.
type AddOrUpdateAction = [QueueActionType.AddOrUpdate, string, Action, boolean];
type ClearAction = [QueueActionType.Clear, string];
type RemoveAction = [QueueActionType.Remove, string, Action];
type SetPendingAction = [QueueActionType.SetPending, string, PendingAction | undefined];
type DeferAction = [QueueActionType.Defer, string, string, Action[]];
type ResetAction = [QueueActionType.Reset, QueueIdentity, boolean];

export type QueueAction = AddOrUpdateAction | ClearAction | RemoveAction | SetPendingAction | DeferAction | ResetAction;

function sessionKey({ account, connector, status }: QueueSession): string {
  return `${account?.toLowerCase() ?? ''}|${connector ?? ''}|${status}`;
}

/** A market is its chain and Comet address. One Comet address can be listed on two chains. */
function marketKey(chainId: number, marketAddress: string): string {
  return `${chainId}:${marketAddress.toLowerCase()}`;
}

function identityKey({ session, market }: QueueIdentity): string {
  return `${session}#${market}`;
}

export function emptyQueue(identity: QueueIdentity, visit = 0): QueueState {
  return { identity, visit, actions: [], pendingAction: undefined, deferred: {} };
}

export function visitKey(state: QueueState): string {
  return `${identityKey(state.identity)}@${state.visit}`;
}

function addOrUpdate(actions: Action[], action: Action): Action[] {
  const actionIndex = actions.findIndex((queued) => isSameAction(queued, action));
  if (actionIndex === -1) return [...actions, action];
  return actions.map((queued, index) => (index === actionIndex ? action : queued));
}

/** As `addOrUpdate`, except that a queue limited to one action keeps a second action out. */
function addOrUpdateWithinLimit(isSingleAction: boolean) {
  return (actions: Action[], action: Action): Action[] =>
    isSingleAction && addsSecondAction(actions, action) ? actions : addOrUpdate(actions, action);
}

/** Exported for tests, which check the limit here as well as in the hook's own check. */
export function queueReducer(state: QueueState, queueAction: QueueAction): QueueState {
  if (queueAction[0] === QueueActionType.Reset) {
    const [, identity, isSingleAction] = queueAction;
    if (identityKey(identity) === identityKey(state.identity)) return state;
    // Nothing queued, open or deferred carries over to a new session or market. When only the
    // market changed, the actions deferred for that market are queued, as far as its limit allows.
    const replay = identity.session === state.identity.session ? state.deferred[identity.market] ?? [] : [];
    return {
      ...emptyQueue(identity, state.visit + 1),
      actions: replay.reduce(addOrUpdateWithinLimit(isSingleAction), []),
    };
  }

  if (queueAction[1] !== visitKey(state)) return state;
  switch (queueAction[0]) {
    case QueueActionType.AddOrUpdate: {
      const [, , action, isSingleAction] = queueAction;
      const actions = addOrUpdateWithinLimit(isSingleAction)(state.actions, action);
      return actions === state.actions ? state : { ...state, actions };
    }
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
 * The queue, the open amount form and deferred actions belong to the session (account, connector
 * and connection status) and the market (chain and Comet) they were made for. A change of either
 * clears them all in the same render. A market change then queues the actions deferred for the new
 * market.
 *
 * With `isSingleAction`, the queue holds at most one action: a distinct second action is refused
 * until the queued one is submitted, removed or cleared. The queued action can still be updated.
 */
export function useActionQueue(
  market: MarketDataState,
  onActionsChanged: (actions: Action[]) => void,
  session: QueueSession = NO_SESSION,
  isSingleAction = false
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
    updateQueue([QueueActionType.Reset, identity, isSingleAction]);
  }
  const isCurrent = identityKey(state.identity) === key;
  const actions = isCurrent ? state.actions : [];
  const pendingAction = isCurrent ? state.pendingAction : undefined;
  // What the callbacks below carry: this visit to this session and market.
  const currentVisit = visitKey(state);
  // The queue as the latest changes of this visit leave it, before React renders them. Each addition
  // in one event is checked against the ones before it, as is an addition from a kept callback.
  const latestActions = useRef(actions);
  latestActions.current = actions;
  // The visit the latest render belongs to. A callback kept from an earlier visit changes neither
  // the queue nor `latestActions`.
  const liveVisit = useRef(currentVisit);
  liveVisit.current = currentVisit;
  const isLiveVisit = () => liveVisit.current === currentVisit;

  useEffect(() => {
    onActionsChanged(state.actions);
  }, [state.actions]);

  // On the wrapped route a base supply or withdrawal is queued as an ordinary action, and Home
  // carries it out through the wrapper at submission. A wrapper draft, or an action naming wrapper
  // shares, is never a queue entry. Refusing one here, with a typed error, keeps the queue and the
  // Bulker from ever holding one. The reducer applies the single-action limit as well.
  const addOrUpdateAction = (action: Action): boolean => {
    assertDirectActions([action]);
    if (!isLiveVisit()) return false;
    if (isSingleAction && addsSecondAction(latestActions.current, action)) return false;
    latestActions.current = addOrUpdate(latestActions.current, action);
    updateQueue([QueueActionType.AddOrUpdate, currentVisit, action, isSingleAction]);
    return true;
  };

  const clearActions = () => {
    if (isLiveVisit()) latestActions.current = [];
    updateQueue([QueueActionType.Clear, currentVisit]);
  };

  const queueActions = (chainId: number, marketAddress: string, actionsToQueue: Action[]) => {
    assertDirectActions(actionsToQueue);
    updateQueue([QueueActionType.Defer, currentVisit, marketKey(chainId, marketAddress), actionsToQueue]);
  };

  const removeAction = (action: Action) => {
    if (isLiveVisit()) {
      latestActions.current = latestActions.current.filter((queued) => !isSameAction(queued, action));
    }
    updateQueue([QueueActionType.Remove, currentVisit, action]);
  };

  const setPendingAction = (pendingAction?: PendingAction) => {
    updateQueue([QueueActionType.SetPending, currentVisit, pendingAction]);
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
        default:
          // Kept, not dropped, so that submission refuses the whole queue instead of sending the rest.
          return action;
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

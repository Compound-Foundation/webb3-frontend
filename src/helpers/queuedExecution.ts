import { sanitizedAmountForAction } from '@helpers/actions';
import { Eligibility, LendingRoute } from '@helpers/lendingRoute';
import { MAX_UINT256 } from '@helpers/numbers';
import { WrappedExecutionError } from '@helpers/wrappedActions';
import type { WithdrawalRequest } from '@helpers/wrappedWithdrawals';
import { Action, ActionType, BaseAssetWithAccountState, TokenWithAccountState } from '@types';

/** A queued action the selected market's wrapper carries out, and what is asked of the wrapper. */
export type QueuedWrapperAction =
  /** `supplyAndWrap(amount)`, after an exact approval when one is needed. `amount` is in base units. */
  | { type: 'supply'; action: Action; amount: bigint }
  /** `unwrapAndWithdraw(shares)`, for the shares that pay the requested cash, or all of them. */
  | { type: 'withdraw'; action: Action; request: WithdrawalRequest };

/**
 * How a queue is submitted: a wrapper action as its own wallet transactions, or the direct actions
 * to Comet or the Bulker. On the wrapped route the queue holds one action, so one part is empty.
 */
export type QueuedExecutionPlan = { wrapper: QueuedWrapperAction | undefined; direct: Action[] };

/**
 * Whether `action` goes through the selected market's wrapper: a base supply or a base withdrawal
 * on the wrapped route. On the wrapped route such an action never goes to Comet or the Bulker, even
 * while the route cannot carry it out.
 */
export function isWrapperRouted(route: LendingRoute, action: Action): boolean {
  return route.kind === 'wrapped' && (action[0] === ActionType.Supply || action[0] === ActionType.Withdraw);
}

/**
 * Whether the queue on `route` holds at most one action. On the wrapped route a base supply or
 * withdrawal goes to the wrapper, which the Bulker cannot call. Each action there is therefore
 * submitted on its own, whatever its kind.
 */
export function isSingleActionRoute(route: LendingRoute): boolean {
  return route.kind === 'wrapped';
}

/** The actions of the queue that go to Comet or the Bulker on `route`, in their queued order. */
export function directActionsForRoute(route: LendingRoute, actions: Action[]): Action[] {
  return actions.filter((action) => !isWrapperRouted(route, action));
}

/**
 * Splits a queue into the wrapper action and the direct actions, as `QueuedExecutionPlan`
 * describes. On the standard route every action is direct. A maximum supply supplies the wallet
 * balance, and a maximum withdrawal is a full exit. A `WrappedExecutionError` refuses the whole
 * queue when it holds more than one action on a route limited to one. It does the same for a base
 * action for another token than the wrapper's. No part of a refused queue is submitted.
 */
export function planQueuedExecution(
  route: LendingRoute,
  baseAsset: BaseAssetWithAccountState,
  collateralAssets: TokenWithAccountState[],
  actions: Action[]
): QueuedExecutionPlan {
  if (isSingleActionRoute(route) && actions.length > 1) {
    throw new WrappedExecutionError('several-actions', 'Submit one action at a time.');
  }
  const direct = directActionsForRoute(route, actions);
  // The wrapped route holds one action, so the queue is either that wrapper action or direct.
  const action = actions.find((queued) => isWrapperRouted(route, queued));
  if (action === undefined || route.kind !== 'wrapped') return { wrapper: undefined, direct };
  const [actionType, asset, amount] = action;
  const baseToken = route.market?.baseTokenAddress;
  if (baseToken !== undefined && asset.address.toLowerCase() !== baseToken.toLowerCase()) {
    throw new WrappedExecutionError('unknown-entry', "The queued action is not for this market's base token.");
  }

  if (actionType === ActionType.Supply) {
    const supplied = sanitizedAmountForAction(baseAsset, collateralAssets, [], action);
    return { wrapper: { type: 'supply', action, amount: supplied }, direct };
  }
  const request: WithdrawalRequest = amount === MAX_UINT256 ? { kind: 'full' } : { kind: 'partial', cash: amount };
  return { wrapper: { type: 'withdraw', action, request }, direct };
}

/**
 * Why the amount form refuses a base supply or withdrawal on `route`, as the form shows it, or
 * undefined when it can be queued. A closed release control is named first: the route reports a
 * wallet on another network before it, and that wallet would otherwise queue an action the control
 * refuses. Only a wallet on another network is let through: Submit asks the wallet to switch first,
 * as it does for direct actions.
 */
export function wrappedEntryBlockLabel(
  route: Extract<LendingRoute, { kind: 'wrapped' }>,
  type: 'supply' | 'withdraw'
): string | undefined {
  const isReleased = type === 'supply' ? route.market?.isDepositEnabled : route.market?.isExitEnabled;
  if (isReleased === false) return type === 'supply' ? 'Supply Not Open Yet' : 'Withdrawals Not Open Yet';
  const eligibility: Eligibility = type === 'supply' ? route.deposit : route.exit;
  if (eligibility.isEligible) return undefined;
  switch (eligibility.reason) {
    case 'wrong-chain':
      return undefined;
    case 'deposits-disabled':
      return 'Supply Not Open Yet';
    case 'exits-disabled':
      return 'Withdrawals Not Open Yet';
    case 'validation-pending':
    case 'reconnecting':
    case 'no-signer':
      return 'Checking Your Wallet And This Market';
    case 'screening':
    case 'connector-conflict':
    case 'not-canonical':
    case 'asset-mismatch':
    case 'metadata-mismatch':
    case 'validation-failed':
    case 'missing-mapping':
    case 'invalid-mapping':
      return 'Unavailable For This Market';
    case 'watch-only':
    case 'disconnected':
    case 'no-account':
      return 'Connect Your Wallet';
    default: {
      const unhandled: never = eligibility.reason;
      return type === 'supply' ? `Supply Unavailable (${unhandled})` : `Withdrawal Unavailable (${unhandled})`;
    }
  }
}

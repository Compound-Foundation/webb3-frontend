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
 * How a queue is submitted: the wrapper action first, as its own wallet transactions, then the
 * other actions to Comet or the Bulker, as before. Either part can be empty.
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

/** The actions of the queue that go to Comet or the Bulker on `route`, in their queued order. */
export function directActionsForRoute(route: LendingRoute, actions: Action[]): Action[] {
  return actions.filter((action) => !isWrapperRouted(route, action));
}

/**
 * Splits a queue into the wrapper action and the direct actions, as `QueuedExecutionPlan`
 * describes. On the standard route every action is direct. A maximum supply supplies the wallet
 * balance the earlier queued actions leave, and a maximum withdrawal is a full exit. A queue with
 * more than one wrapper action, or a base action for another token than the wrapper's, is refused
 * whole with a `WrappedExecutionError`, so no part of it is submitted.
 */
export function planQueuedExecution(
  route: LendingRoute,
  baseAsset: BaseAssetWithAccountState,
  collateralAssets: TokenWithAccountState[],
  actions: Action[]
): QueuedExecutionPlan {
  const direct = directActionsForRoute(route, actions);
  if (route.kind !== 'wrapped') return { wrapper: undefined, direct };

  const wrapperIndexes = actions.flatMap((action, index) => (isWrapperRouted(route, action) ? [index] : []));
  if (wrapperIndexes.length === 0) return { wrapper: undefined, direct };
  if (wrapperIndexes.length > 1) {
    throw new WrappedExecutionError('several-wrapped-actions', 'Submit one supply or withdrawal at a time.');
  }
  const index = wrapperIndexes[0];
  const action = actions[index];
  const [actionType, asset, amount] = action;
  const baseToken = route.market?.baseTokenAddress;
  if (baseToken !== undefined && asset.address.toLowerCase() !== baseToken.toLowerCase()) {
    throw new WrappedExecutionError('unknown-entry', "The queued action is not for this market's base token.");
  }

  if (actionType === ActionType.Supply) {
    const supplied = sanitizedAmountForAction(baseAsset, collateralAssets, actions.slice(0, index), action);
    return { wrapper: { type: 'supply', action, amount: supplied }, direct };
  }
  const request: WithdrawalRequest = amount === MAX_UINT256 ? { kind: 'full' } : { kind: 'partial', cash: amount };
  return { wrapper: { type: 'withdraw', action, request }, direct };
}

/**
 * The Comet base withdrawal that pays the part of a wrapped-route withdrawal the account supplied to
 * Comet directly, outside the wrapper. It is the call production sends: Comet's
 * `withdraw(baseToken, amount)`.
 */
export type DirectBaseWithdrawal = {
  /**
   * `withdraw`'s amount: `MAX_UINT256` for the whole direct supply, or a part strictly below the
   * supply, in base units.
   */
  amount: bigint;
};

/**
 * How a queued withdrawal on the wrapped route is carried out: `direct` first, as its own Comet
 * transaction, then `request` through the wrapper, which starts only once `direct` confirms. At least
 * one of the two is set. A partial `request` is what the wrapper pays if `direct` takes exactly the
 * direct supply it was planned from. After `direct` confirms, the rest is worked out again from what
 * it took.
 */
export type WithdrawalSplit = { direct: DirectBaseWithdrawal | undefined; request: WithdrawalRequest | undefined };

/**
 * Splits a withdrawal of `amount` on the wrapped route between the account's direct Comet supply,
 * `directBalance`, and its wrapper shares. The direct supply pays first:
 * - With no direct supply, everything goes to the wrapper, as `planQueuedExecution` plans it.
 * - An amount below the direct supply is one Comet withdrawal of that amount.
 * - An amount equal to the direct supply withdraws it with `MAX_UINT256`, with no wrapper step, so
 *   it never borrows if the supply falls before it executes.
 * - A larger amount withdraws the whole direct supply with `MAX_UINT256`, then the rest from the
 *   wrapper.
 * - A maximum withdraws the whole direct supply with `MAX_UINT256`, then makes a full exit when the
 *   account holds wrapper shares.
 *
 * With `MAX_UINT256`, Comet withdraws the supply it holds for the account and never borrows. A
 * maximum with a direct supply needs `wrappedShares`, and is refused with a `WrappedExecutionError`
 * while they are unknown. Home splits a withdrawal when Submit is pressed, and again just before the
 * wallet is asked, from a fresh read of `directBalance`.
 */
export function splitWrappedWithdrawal(
  amount: bigint,
  directBalance: bigint,
  wrappedShares: bigint | undefined
): WithdrawalSplit {
  const isMax = amount === MAX_UINT256;
  if (directBalance <= 0n) {
    return { direct: undefined, request: isMax ? { kind: 'full' } : { kind: 'partial', cash: amount } };
  }
  const wholeDirect: DirectBaseWithdrawal = { amount: MAX_UINT256 };
  if (isMax) {
    if (wrappedShares === undefined) {
      throw new WrappedExecutionError('position-unknown', 'Your wrapped balance is not loaded yet. Try again.');
    }
    return { direct: wholeDirect, request: wrappedShares > 0n ? { kind: 'full' } : undefined };
  }
  if (amount <= 0n) throw new WrappedExecutionError('unknown-entry', 'Enter an amount greater than 0.');
  if (amount < directBalance) return { direct: { amount }, request: undefined };
  if (amount === directBalance) return { direct: wholeDirect, request: undefined };
  return { direct: wholeDirect, request: { kind: 'partial', cash: amount - directBalance } };
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

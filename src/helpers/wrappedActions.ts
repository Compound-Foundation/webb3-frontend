import { Interface } from '@ethersproject/abi';
import { JsonRpcProvider } from '@ethersproject/providers';

import { HARDCODED_WRAPPED_LENDING_SOURCE } from '@constants/wrappedMarkets';
import CometAbi from '@helpers/abis/Comet';
import { LendingRoute, WriteBlockReason } from '@helpers/lendingRoute';
import { MAX_UINT256 } from '@helpers/numbers';
import type { WithdrawalQuote, WithdrawalReview } from '@helpers/wrappedWithdrawals';
import type { ScreeningStatus } from '@hooks/useAddressScreening';
import { Action, ActionType } from '@types';

/** Marks a wrapper action. Standard queue entries are tuples and never carry it. */
export const WRAPPED_ACTION = 'wrapped-action';

/** A wrapped supply (COM-287) or a wrapped withdrawal (COM-288). */
export type WrappedActionType = 'supply' | 'withdraw';

/**
 * The calls a wrapper action can make, each on one of its own contracts:
 * - `approve`: the base token's `approve(wrapper, amount)`, including a reset to zero.
 * - `supply-and-wrap`: the wrapper's `supplyAndWrap(amount)`.
 * - `unwrap-and-withdraw`: the wrapper's `unwrapAndWithdraw(shares)`.
 */
export type WrappedStepKind = 'approve' | 'supply-and-wrap' | 'unwrap-and-withdraw';

/**
 * A withdrawal as its check found it just before the signature. The step still burns the reviewed
 * shares, so only what they pay can differ from the review.
 */
export type RecheckedWithdrawal = {
  /** The reviewed shares, quoted again at `blockNumber`. */
  quote: WithdrawalQuote;
  /** The block the check read. */
  blockNumber: number;
  /**
   * The step's description with the cash of `quote`. The transaction list describes the wallet's
   * request by it.
   */
  description: string;
};

/**
 * The result of a step's own check. A withdrawal's check that passes gives `rechecked`. The dialog
 * then shows the cash the exit pays at the block the check read, not the reviewed cash.
 */
export type WrappedStepCheck = { ok: true; rechecked?: RecheckedWithdrawal } | { ok: false; message: string };

/** One transaction of a wrapper action. COM-287 and COM-288 build these. */
export type WrappedStep = {
  /** Unique within the draft. The transaction manager stores a submitted hash under it. */
  id: string;
  kind: WrappedStepKind;
  /** Shown in review and in the transaction list. */
  description: string;
  /** The encoded call, which `checkWrappedStep` holds to `kind`. It never carries value. */
  request: { to: string; data: string };
  /** A check of the step's own, such as a simulation from the sender, made just before signing. */
  check?: () => Promise<WrappedStepCheck>;
};

/**
 * What a wrapper draft was reviewed under. The draft applies only while all of it holds.
 * `routeKey` is the route's validation key, which covers the wrapper mapping, the connector's id
 * and uid, the account, the chain and the connection status.
 */
export type WrappedActionIdentity = {
  type: WrappedActionType;
  routeKey: string;
  /** In lower case. */
  account: string;
  chainId: number;
  cometAddress: string;
  wrapperAddress: string;
  baseTokenAddress: string;
  screeningStatus: ScreeningStatus;
  /** The release control for `type`: the mapping's `isDepositEnabled` or `isExitEnabled`. */
  isReleased: boolean;
  /** The wallet provider that signs, compared by identity. */
  provider: object;
};

/** A reviewed wrapper action: its identity, its amount and the transactions it takes. */
export type WrappedActionDraft = {
  kind: typeof WRAPPED_ACTION;
  id: string;
  identity: WrappedActionIdentity;
  /** In base-token units for a supply, in shares for a withdrawal. */
  amount: bigint;
  steps: readonly WrappedStep[];
  /** A withdrawal's quote, which its review shows. It must be for the draft's shares. */
  withdrawal?: WithdrawalReview;
};

/** The live session a wrapper action is checked against. */
export type WrappedSession = {
  route: LendingRoute;
  account: string | undefined;
  chainId: number | undefined;
  screeningStatus: ScreeningStatus;
  /** The wallet provider, `web3.write.provider`. */
  provider: object | undefined;
};

/**
 * The identity a wrapper action of `type` has in `session`, or undefined when the session has no
 * wrapped route with a valid mapping, or no account, chain or wallet provider.
 */
export function wrappedActionIdentity(
  type: WrappedActionType,
  session: WrappedSession
): WrappedActionIdentity | undefined {
  const { route, account, chainId, provider } = session;
  if (route.kind !== 'wrapped' || route.market === undefined || route.validationKey === undefined) return undefined;
  if (account === undefined || chainId === undefined || provider === undefined) return undefined;
  const { market } = route;
  return {
    type,
    routeKey: route.validationKey,
    account: account.toLowerCase(),
    chainId,
    cometAddress: market.cometAddress,
    wrapperAddress: market.wrapperAddress,
    baseTokenAddress: market.baseTokenAddress,
    screeningStatus: session.screeningStatus,
    isReleased: type === 'supply' ? market.isDepositEnabled : market.isExitEnabled,
    provider,
  };
}

/** The identity as a key, without the provider, which is compared by identity instead. */
export function wrappedActionKey(identity: WrappedActionIdentity): string {
  return [
    identity.type,
    identity.routeKey,
    identity.account,
    identity.chainId,
    identity.cometAddress.toLowerCase(),
    identity.wrapperAddress.toLowerCase(),
    identity.baseTokenAddress.toLowerCase(),
    identity.screeningStatus,
    identity.isReleased,
  ].join('|');
}

export function isSameWrappedIdentity(
  a: WrappedActionIdentity | undefined,
  b: WrappedActionIdentity | undefined
): boolean {
  return a !== undefined && b !== undefined && a.provider === b.provider && wrappedActionKey(a) === wrappedActionKey(b);
}

export type WrappedExecutionProblem =
  /** A wrapper action reached the standard queue or the Bulker. */
  | 'wrapped-action'
  /** One request held both direct actions and a wrapper action. */
  | 'mixed-execution'
  /** One request held more than one wrapper action. */
  | 'several-wrapped-actions'
  /** One request held something that is neither. */
  | 'unknown-entry';

/** Thrown at the standard queue's, the Bulker's and the submission paths' boundaries. */
export class WrappedExecutionError extends Error {
  readonly problem: WrappedExecutionProblem;

  constructor(problem: WrappedExecutionProblem, message: string) {
    super(message);
    this.name = 'WrappedExecutionError';
    this.problem = problem;
  }
}

const STANDARD_ACTION_TYPES = new Set<unknown>(Object.values(ActionType));

/**
 * Every wrapper the configuration names, valid or not. Wrapper shares are no market's asset, so an
 * action naming one is a wrapper action whatever its type. The registry is built from this source.
 */
const WRAPPER_ADDRESSES: ReadonlySet<string> = new Set(
  HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => String(market.wrapperAddress).toLowerCase())
);

/** Whether `address` is a wrapper the configuration names. */
export function isWrapperAddress(address: unknown): boolean {
  return typeof address === 'string' && WRAPPER_ADDRESSES.has(address.toLowerCase());
}

export function isWrappedActionDraft(entry: unknown): entry is WrappedActionDraft {
  return typeof entry === 'object' && entry !== null && (entry as { kind?: unknown }).kind === WRAPPED_ACTION;
}

/** Whether `entry` is a wrapper action in any form: a draft, or an action naming wrapper shares. */
export function isWrappedActionEntry(entry: unknown): boolean {
  if (isWrappedActionDraft(entry)) return true;
  if (!Array.isArray(entry)) return false;
  const asset: unknown = entry[1];
  return isWrapperAddress(
    typeof asset === 'object' && asset !== null ? (asset as { address?: unknown }).address : undefined
  );
}

function isDirectAction(entry: unknown): entry is Action {
  return (
    Array.isArray(entry) &&
    STANDARD_ACTION_TYPES.has(entry[0]) &&
    typeof entry[1] === 'object' &&
    entry[1] !== null &&
    !isWrappedActionEntry(entry)
  );
}

export type ExecutionPlan =
  | { kind: 'none' }
  | { kind: 'direct'; actions: Action[] }
  | { kind: 'wrapped'; draft: WrappedActionDraft };

/**
 * Decides the one path a request to submit `entries` takes: direct actions to Comet or the
 * Bulker, or a single wrapper draft to its wrapper. A request that mixes the two, holds more than
 * one draft, or holds an action naming wrapper shares is refused whole by throwing a
 * `WrappedExecutionError`, so no part of it is submitted without the rest.
 */
export function planExecution(entries: readonly unknown[]): ExecutionPlan {
  if (entries.some((entry) => !isWrappedActionDraft(entry) && isWrappedActionEntry(entry))) {
    throw new WrappedExecutionError('wrapped-action', 'Wrapper shares cannot be supplied, withdrawn or used directly.');
  }
  if (entries.some((entry) => !isWrappedActionDraft(entry) && !isDirectAction(entry))) {
    throw new WrappedExecutionError('unknown-entry', 'The request holds an entry that is not an action.');
  }
  const drafts = entries.filter(isWrappedActionDraft);
  if (drafts.length > 0 && drafts.length < entries.length) {
    throw new WrappedExecutionError(
      'mixed-execution',
      'Wrapped and direct actions are submitted separately. Nothing was submitted.'
    );
  }
  if (drafts.length > 1) {
    throw new WrappedExecutionError('several-wrapped-actions', 'Submit one wrapped action at a time.');
  }
  if (drafts.length === 1) return { kind: 'wrapped', draft: drafts[0] };
  return entries.length === 0 ? { kind: 'none' } : { kind: 'direct', actions: entries as Action[] };
}

/**
 * Submits `entries` through exactly one path. The whole request is planned before anything is
 * submitted, so a refused request submits neither its direct nor its wrapped part.
 */
export function submitExecution<T>(
  entries: readonly unknown[],
  submit: { direct: (actions: Action[]) => T; wrapped: (draft: WrappedActionDraft) => T }
): T | undefined {
  const plan = planExecution(entries);
  switch (plan.kind) {
    case 'direct':
      return submit.direct(plan.actions);
    case 'wrapped':
      return submit.wrapped(plan.draft);
    default:
      return undefined;
  }
}

/** Whether every entry goes down the direct path. Any wrapper action refuses the whole request. */
export function isDirectExecution(entries: readonly unknown[]): boolean {
  try {
    return planExecution(entries).kind === 'direct';
  } catch (error) {
    if (error instanceof WrappedExecutionError) return false;
    throw error;
  }
}

/** The standard queue's and the Bulker's boundary: every entry must be a direct action. */
export function assertDirectActions(entries: readonly unknown[]): asserts entries is Action[] {
  if (planExecution(entries).kind === 'wrapped') {
    throw new WrappedExecutionError(
      'wrapped-action',
      'A wrapped action is submitted on its own, never as a direct action.'
    );
  }
}

export type WrappedStepProblem =
  | 'step-not-allowed'
  | 'wrong-target'
  | 'wrong-method'
  | 'wrong-spender'
  | 'wrong-amount'
  | 'malformed-call'
  | 'bad-sequence'
  /** A withdrawal has no quote, or its quote is for other shares than its call burns. */
  | 'quote-mismatch';

const BASE_TOKEN_CALLS = new Interface(['function approve(address spender, uint256 amount)']);
const WRAPPER_CALLS = new Interface([
  'function supplyAndWrap(uint256 amount)',
  'function unwrapAndWithdraw(uint256 shares)',
]);
const STEP_METHODS: Record<WrappedStepKind, { calls: Interface; method: string }> = {
  approve: { calls: BASE_TOKEN_CALLS, method: 'approve' },
  'supply-and-wrap': { calls: WRAPPER_CALLS, method: 'supplyAndWrap' },
  'unwrap-and-withdraw': { calls: WRAPPER_CALLS, method: 'unwrapAndWithdraw' },
};
const ALLOWED_STEPS: Record<WrappedActionType, readonly WrappedStepKind[]> = {
  supply: ['approve', 'supply-and-wrap'],
  withdraw: ['unwrap-and-withdraw'],
};

/**
 * Checks that a step makes only the call its kind allows, on the draft's own contracts: the base
 * token's `approve` to the wrapper, or the wrapper's own supply or exit method, canonically
 * encoded. The contracts come from the draft's identity, which comes from the route, so a step can
 * never call Comet, the Bulker or any other contract directly. The amount is the draft's own: base units
 * for a supply and shares for a withdrawal. An approval is for exactly that amount, or zero to
 * reset an allowance first, and never more.
 */
export function checkWrappedStep(draft: WrappedActionDraft, step: WrappedStep): WrappedStepProblem | undefined {
  const { identity } = draft;
  if (!ALLOWED_STEPS[identity.type].includes(step.kind)) return 'step-not-allowed';
  const target = step.kind === 'approve' ? identity.baseTokenAddress : identity.wrapperAddress;
  if (typeof step.request.to !== 'string' || step.request.to.toLowerCase() !== target.toLowerCase()) {
    return 'wrong-target';
  }
  const { calls, method } = STEP_METHODS[step.kind];
  let call: ReturnType<Interface['parseTransaction']>;
  try {
    call = calls.parseTransaction({ data: step.request.data });
  } catch {
    return 'malformed-call';
  }
  if (call.name !== method) return 'wrong-method';
  if (calls.encodeFunctionData(call.functionFragment, call.args) !== step.request.data.toLowerCase()) {
    return 'malformed-call';
  }
  if (step.kind === 'approve') {
    if (String(call.args[0]).toLowerCase() !== identity.wrapperAddress.toLowerCase()) return 'wrong-spender';
    const approved = BigInt(call.args[1].toString());
    return approved === 0n || approved === draft.amount ? undefined : 'wrong-amount';
  }
  return BigInt(call.args[0].toString()) === draft.amount ? undefined : 'wrong-amount';
}

/** The amount a well-formed `approve` step approves. */
function approvedAmount(step: WrappedStep): bigint {
  return BigInt(BASE_TOKEN_CALLS.parseTransaction({ data: step.request.data }).args[1].toString());
}

/**
 * Checks a draft's steps as a whole. Its amount is positive and never the unlimited sentinel. A
 * supply is one `supplyAndWrap`, after either no approval, an approval of exactly its amount, or a
 * reset to zero and then that approval. A withdrawal is one `unwrapAndWithdraw`, and its quote is
 * for the shares that call burns, so the review shows the cash of the shares that are signed. Step
 * ids are unique, since hashes are stored under them.
 */
export function checkWrappedDraft(draft: WrappedActionDraft): WrappedStepProblem | undefined {
  if (draft.amount <= 0n || draft.amount >= MAX_UINT256) return 'wrong-amount';
  for (const step of draft.steps) {
    const problem = checkWrappedStep(draft, step);
    if (problem !== undefined) return problem;
  }
  const kinds = draft.steps.map((step) => step.kind);
  const finalKind = draft.identity.type === 'supply' ? 'supply-and-wrap' : 'unwrap-and-withdraw';
  const isOrdered =
    kinds.length > 0 && kinds[kinds.length - 1] === finalKind && kinds.slice(0, -1).every((kind) => kind === 'approve');
  const isUnique = new Set(draft.steps.map((step) => step.id)).size === draft.steps.length;
  if (!isOrdered || !isUnique) return 'bad-sequence';
  const approvals = draft.steps.filter((step) => step.kind === 'approve').map(approvedAmount);
  const isApprovalSequence =
    approvals.length === 0 ||
    (approvals.length === 1 && approvals[0] === draft.amount) ||
    (approvals.length === 2 && approvals[0] === 0n && approvals[1] === draft.amount);
  if (!isApprovalSequence) return 'bad-sequence';
  if (draft.identity.type === 'withdraw' && draft.withdrawal?.quote.shares !== draft.amount) return 'quote-mismatch';
  return undefined;
}

/**
 * Checks a withdrawal as its check found it against the draft. It must quote the draft's kind of
 * exit for the shares the draft's call burns. Otherwise the dialog and the transaction list
 * describe other shares than the wallet signs.
 */
export function checkRecheckedWithdrawal(
  draft: WrappedActionDraft,
  rechecked: RecheckedWithdrawal
): WrappedStepProblem | undefined {
  const reviewed = draft.withdrawal;
  const isSameExit =
    draft.identity.type === 'withdraw' &&
    reviewed !== undefined &&
    rechecked.quote.kind === reviewed.quote.kind &&
    rechecked.quote.shares === draft.amount;
  return isSameExit ? undefined : 'quote-mismatch';
}

export type MarketRestriction = 'supply-paused' | 'withdraw-paused' | 'restriction-unknown';

export type WrappedBlockReason =
  /** The session does not lend the selected market through a wrapper. */
  | 'not-wrapped'
  /** The account, connector, chain, market, wrapper, route, screening, release control or wallet provider changed. */
  | 'identity-changed'
  /** The wallet provider is broken or cannot read its chain. */
  | 'session-unusable'
  /**
   * An earlier wrapper transaction for this identity is still waiting for the wallet or a receipt.
   * Until the session's stored transactions are restored, such a transaction can exist unseen, so
   * this is also the reason then.
   */
  | 'transaction-pending'
  /** Another wrapper action is being read, reviewed or signed. */
  | 'action-in-progress'
  | WriteBlockReason
  | WrappedStepProblem
  | MarketRestriction
  /** The step's own check, such as a simulation, refused. */
  | 'step-check-failed'
  /** The request failed before the wallet was asked to sign, so nothing was sent. */
  | 'not-sent';

/**
 * The checks made against the live session immediately before every signature. The identity the
 * draft was reviewed under must still hold, so a change of account, connector, chain, market,
 * wrapper, route, screening, release control or wallet provider stops it. The route must still
 * allow the action, which covers the signer, the chain, screening, connector conflicts, wrapper
 * validation and the release control. The step must make only the call its kind allows.
 */
export function checkBeforeSignature(
  draft: WrappedActionDraft,
  step: WrappedStep,
  live: WrappedSession,
  isSessionUnusable: boolean
): WrappedBlockReason | undefined {
  if (isSessionUnusable) return 'session-unusable';
  if (!isSameWrappedIdentity(wrappedActionIdentity(draft.identity.type, live), draft.identity)) {
    return 'identity-changed';
  }
  const { route } = live;
  if (route.kind !== 'wrapped') return 'identity-changed';
  const eligibility = draft.identity.type === 'supply' ? route.deposit : route.exit;
  if (!eligibility.isEligible) return eligibility.reason;
  return checkWrappedStep(draft, step);
}

const cometInterface = new Interface(CometAbi);

/**
 * Reads the Comet pause that makes the wrapper call revert. `supplyAndWrap` supplies to Comet,
 * and `unwrapAndWithdraw` withdraws from it. A read that fails, or returns something other
 * than a boolean, is a restriction too.
 */
export async function readMarketRestriction(
  provider: Pick<JsonRpcProvider, 'call'>,
  identity: WrappedActionIdentity
): Promise<MarketRestriction | undefined> {
  const method = identity.type === 'supply' ? 'isSupplyPaused' : 'isWithdrawPaused';
  try {
    const result = await provider.call({ to: identity.cometAddress, data: cometInterface.encodeFunctionData(method) });
    const [isPaused] = cometInterface.decodeFunctionResult(method, result);
    if (isPaused === false) return undefined;
    if (isPaused === true) return identity.type === 'supply' ? 'supply-paused' : 'withdraw-paused';
    return 'restriction-unknown';
  } catch {
    return 'restriction-unknown';
  }
}

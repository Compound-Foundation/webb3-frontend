import { JsonRpcProvider, TransactionReceipt } from '@ethersproject/providers';
import { BigNumber } from 'ethers';
import { useEffect, useReducer, useRef, useState } from 'react';

import {
  describeWalletError,
  NotSentError,
  probeWalletSession,
  ProbedProvider,
  SendWithdrawnError,
  SessionProbeResult,
} from '@helpers/walletErrors';
import {
  checkBeforeSignature,
  checkWrappedDraft,
  isSameWrappedIdentity,
  MarketRestriction,
  readMarketRestriction,
  WRAPPED_ACTION,
  WrappedActionDraft,
  WrappedActionIdentity,
  WrappedActionType,
  WrappedBlockReason,
  WrappedSession,
  WrappedStep,
  wrappedActionIdentity,
} from '@helpers/wrappedActions';
import { SettledTransaction, Transaction, TransactionOutcome, TransactionState } from '@types';

import type { TransactionManager } from './useTransactionManager';

type UnusableReason = Extract<SessionProbeResult, { status: 'unusable' }>['reason'];

/**
 * Whether the wallet can be asked to sign. A wallet that acknowledged a network switch, or that
 * the page still shows as connected after its extension updated, is not proof of a usable
 * session. Only a read through it is, so the session is checked whenever its wallet provider,
 * account or chain changes, and again before every wrapper signature.
 */
export type WalletSessionHealth =
  | { status: 'not-applicable' }
  | { status: 'checking' }
  | { status: 'usable' }
  | { status: 'unusable'; reason: UnusableReason; instruction: string };

const UNUSABLE_INSTRUCTIONS: Record<UnusableReason, string> = {
  'provider-broken':
    'Your wallet extension stopped responding, which can happen after it updates. Reload the page and reconnect your wallet before you continue.',
  'reads-failing':
    'Your wallet cannot read this network, although it reported switching to it. Reload the page and reconnect your wallet, or switch it to a network it supports.',
  'chain-mismatch':
    'Your wallet reports a different network from this page. Reload the page and reconnect your wallet before you continue.',
};

/** Where one step of a draft stands. */
export type WrappedStepState =
  /** Waiting for the user to confirm it. */
  | { status: 'waiting' }
  /** Confirmed, and being checked against the live session before the wallet is asked. */
  | { status: 'checking' }
  /** The wallet has the request. Approval on a mobile device can take minutes. */
  | { status: 'awaiting-signature' }
  /** The wallet returned a hash, so the transaction was broadcast. */
  | { status: 'submitted'; hash: string }
  | { status: 'confirmed'; hash: string; receipt: TransactionReceipt }
  | { status: 'reverted'; hash: string; receipt: TransactionReceipt }
  | { status: 'replaced'; hash: string }
  /** Broadcast, but its result can no longer be followed in this session. */
  | { status: 'unresolved'; hash: string }
  /** Declined in the wallet: EIP-1193 code 4001 or its equivalents only. */
  | { status: 'rejected' }
  /** The wallet reported another error. Whether it reached the chain is unknown. */
  | { status: 'provider-failure'; message: string }
  /** A check refused it before the wallet was asked. Nothing was sent. */
  | { status: 'blocked'; reason: WrappedBlockReason; message?: string };

type DraftProgress = {
  draft: WrappedActionDraft;
  steps: readonly WrappedStepState[];
  /** The step the user confirms next, or the one in progress or that stopped the draft. */
  stepIndex: number;
};

/**
 * A wrapper action's lifecycle. A draft is read, then reviewed, then signed one step at a time,
 * each step after its own confirmation. A change of identity discards the draft in the same
 * render. Discarding a draft does not cancel a request open in the wallet or a broadcast
 * transaction: `submittedHashes` lists what was already sent.
 */
export type WrappedActionState =
  | { phase: 'idle' }
  | { phase: 'reading'; identity: WrappedActionIdentity }
  | { phase: 'read-failed'; identity: WrappedActionIdentity; message: string }
  | ({ phase: 'review' } & DraftProgress)
  | ({ phase: 'signing' } & DraftProgress)
  | ({ phase: 'complete' } & DraftProgress)
  | ({ phase: 'stopped' } & DraftProgress)
  | {
      phase: 'discarded';
      reason: 'identity-changed' | 'session-unusable' | 'cleared';
      /** The action the draft was for, and the chain its transactions were sent on. */
      type: WrappedActionType;
      chainId: number;
      submittedHashes: readonly string[];
      /** A wallet request was open. The user can still approve it there. */
      isWalletRequestOpen: boolean;
    };

/** Reads what a wrapper action needs and builds its steps, for the identity given. */
export type PrepareWrappedAction = (
  identity: WrappedActionIdentity
) => Promise<{ amount: bigint; steps: readonly WrappedStep[] }>;

export type WrappedActionController = {
  state: WrappedActionState;
  session: WalletSessionHealth;
  /** This account's wrapper transactions on this chain: still pending, and settled this session. */
  recovered: { pending: readonly Transaction[]; settled: readonly SettledTransaction[] };
  /** Whether an interrupted wallet request holds back a fresh review, with no draft in progress. */
  canDismissRecovered: boolean;
  /** Why `start(type)` refuses now, or undefined if it starts. */
  blockedReason: (type: WrappedActionType) => WrappedBlockReason | undefined;
  /** Starts a fresh review. Returns why it was refused, if it was. */
  start: (type: WrappedActionType, prepare: PrepareWrappedAction) => WrappedBlockReason | undefined;
  /**
   * Signs the step in review, after checking everything again. Each step needs its own call. A
   * `confirm` applies only to the draft and step that were in review in the render that returned it.
   */
  confirm: () => void;
  /** Clears the draft, or the notice left by one. Nothing already sent is cancelled. */
  discard: () => void;
  /**
   * Stops waiting for this account's interrupted wallet requests on this chain: requests open at a
   * reload, or answered with an ambiguous error, whose result nothing can follow. Only for the user
   * to call after checking their wallet, because a dismissed request can still go through. A
   * broadcast transaction is not dismissed: it holds back a fresh review until it settles.
   */
  dismissRecovered: () => void;
};

/** The controller outside the wrapped route. */
export const IDLE_WRAPPED_ACTION: WrappedActionController = Object.freeze<WrappedActionController>({
  state: { phase: 'idle' },
  session: { status: 'not-applicable' },
  recovered: { pending: [], settled: [] },
  canDismissRecovered: false,
  blockedReason: () => 'not-wrapped',
  start: () => 'not-wrapped',
  confirm: () => undefined,
  discard: () => undefined,
  dismissRecovered: () => undefined,
});

export type UseWrappedActionOptions = {
  session: WrappedSession;
  manager: Pick<
    TransactionManager,
    | 'transactions'
    | 'settledTransactions'
    | 'walletFailure'
    | 'restoredSession'
    | 'submitTransaction'
    | 'dismissTransaction'
  >;
  /** The configured chain's public provider, for the market restriction read. */
  readProvider: Pick<JsonRpcProvider, 'call'> | undefined;
  probe?: (provider: ProbedProvider, chainId: number) => Promise<SessionProbeResult>;
  checkRestriction?: (identity: WrappedActionIdentity) => Promise<MarketRestriction | undefined>;
};

type LifecycleEvent =
  | { type: 'reading'; identity: WrappedActionIdentity }
  | { type: 'read-failed'; message: string }
  | { type: 'drafted'; draft: WrappedActionDraft }
  | { type: 'step'; index: number; step: WrappedStepState }
  | { type: 'session-unusable' }
  | { type: 'discarded'; reason: 'identity-changed' | 'cleared' }
  | { type: 'reset' };

function hasProgress(state: WrappedActionState): state is Extract<WrappedActionState, DraftProgress> {
  return 'draft' in state;
}

function identityOf(state: WrappedActionState): WrappedActionIdentity | undefined {
  if (hasProgress(state)) return state.draft.identity;
  return state.phase === 'reading' || state.phase === 'read-failed' ? state.identity : undefined;
}

/** A wallet request whose result nothing can follow: it has no hash to look up. */
function isInterrupted(transaction: Transaction): boolean {
  return transaction.state === TransactionState.AwaitingConfirmation && transaction.isInterrupted === true;
}

function isInProgress(state: WrappedActionState): boolean {
  return state.phase === 'reading' || state.phase === 'review' || state.phase === 'signing';
}

const SETTLED_STEP_STATUSES = new Set<WrappedStepState['status']>(['confirmed', 'reverted', 'replaced']);

function discardedFrom(
  state: WrappedActionState,
  identity: WrappedActionIdentity,
  reason: Extract<WrappedActionState, { phase: 'discarded' }>['reason']
): WrappedActionState {
  const steps = hasProgress(state) ? state.steps : [];
  return {
    phase: 'discarded',
    reason,
    type: identity.type,
    chainId: identity.chainId,
    submittedHashes: steps.flatMap((step) => ('hash' in step ? [step.hash] : [])),
    isWalletRequestOpen: steps.some((step) => step.status === 'awaiting-signature'),
  };
}

function withStep(state: WrappedActionState, index: number, step: WrappedStepState): WrappedActionState {
  if (!hasProgress(state) || state.phase === 'complete' || state.phase === 'stopped') return state;
  // An outcome can arrive before the hash it belongs to is recorded. It is not overwritten.
  if (step.status === 'submitted' && SETTLED_STEP_STATUSES.has(state.steps[index].status)) return state;
  const steps = state.steps.map((current, stepIndex) => (stepIndex === index ? step : current));
  switch (step.status) {
    case 'checking':
    case 'awaiting-signature':
    case 'submitted':
      return { ...state, phase: 'signing', steps, stepIndex: index };
    case 'confirmed':
      // The next step waits for the user, so nothing is sent without a fresh confirmation.
      return index === state.draft.steps.length - 1
        ? { ...state, phase: 'complete', steps, stepIndex: index }
        : { ...state, phase: 'review', steps, stepIndex: index + 1 };
    default:
      return { ...state, phase: 'stopped', steps, stepIndex: index };
  }
}

/** A broken session stops a draft. What was sent stays sent and is shown as unresolved. */
function stoppedByUnusableSession(state: WrappedActionState): WrappedActionState {
  if (state.phase === 'reading') return discardedFrom(state, state.identity, 'session-unusable');
  if (!hasProgress(state) || state.phase === 'complete' || state.phase === 'stopped') return state;
  const step = state.steps[state.stepIndex];
  let stopped: WrappedStepState;
  if (step.status === 'submitted') {
    stopped = { status: 'unresolved', hash: step.hash };
  } else if (step.status === 'awaiting-signature') {
    stopped = {
      status: 'provider-failure',
      message:
        'The wallet stopped responding while it had the request. The request can still be approved in the wallet.',
    };
  } else {
    stopped = { status: 'blocked', reason: 'session-unusable' };
  }
  return withStep(state, state.stepIndex, stopped);
}

function lifecycleReducer(state: WrappedActionState, event: LifecycleEvent): WrappedActionState {
  switch (event.type) {
    case 'reading':
      return { phase: 'reading', identity: event.identity };
    case 'read-failed':
      return state.phase === 'reading'
        ? { phase: 'read-failed', identity: state.identity, message: event.message }
        : state;
    case 'drafted':
      return state.phase === 'reading'
        ? {
            phase: 'review',
            draft: event.draft,
            steps: event.draft.steps.map(() => ({ status: 'waiting' })),
            stepIndex: 0,
          }
        : state;
    case 'step':
      return withStep(state, event.index, event.step);
    case 'session-unusable':
      return stoppedByUnusableSession(state);
    case 'discarded': {
      // An idle or discarded state has no draft to discard.
      const identity = identityOf(state);
      return identity === undefined ? state : discardedFrom(state, identity, event.reason);
    }
    case 'reset':
      return { phase: 'idle' };
  }
}

function outcomeState(outcome: TransactionOutcome, hash: string): WrappedStepState {
  switch (outcome.status) {
    case 'confirmed':
      return { status: 'confirmed', hash: outcome.receipt.transactionHash ?? hash, receipt: outcome.receipt };
    case 'reverted':
      return { status: 'reverted', hash: outcome.receipt.transactionHash ?? hash, receipt: outcome.receipt };
    default:
      return { status: 'replaced', hash };
  }
}

/**
 * Asks the wallet to sign and broadcast a step, returning its hash as soon as the wallet has one.
 * Gas is estimated first, so that `beforeSending`, which throws to withdraw the request, runs
 * immediately before the wallet is asked. The chain id is sent too, so a wallet that checks it
 * refuses a request for another chain.
 */
async function sendStep(
  identity: WrappedActionIdentity,
  step: WrappedStep,
  beforeSending: () => void
): Promise<string> {
  const provider = identity.provider as Pick<JsonRpcProvider, 'getSigner' | 'estimateGas'>;
  const request = { to: step.request.to, data: step.request.data, chainId: identity.chainId };
  let estimatedGas: BigNumber;
  try {
    estimatedGas = await provider.estimateGas({ ...request, from: identity.account });
  } catch (error) {
    throw new NotSentError(error);
  }
  beforeSending();
  return provider
    .getSigner(identity.account)
    .sendUncheckedTransaction({ ...request, gasLimit: estimatedGas.mul(GAS_LIMIT_PERCENT).div(100) });
}

/** The gas limit sent, as a percentage of the estimate: the app's usual 20% margin. */
const GAS_LIMIT_PERCENT = 120;

/**
 * The draft's own copy of the calls `prepare` returned. It is frozen, so the call that was checked
 * is the call that is sent, whatever later happens to the objects `prepare` built.
 */
function frozenDraft(
  id: string,
  identity: WrappedActionIdentity,
  amount: bigint,
  steps: readonly WrappedStep[]
): WrappedActionDraft {
  return Object.freeze({
    kind: WRAPPED_ACTION,
    id,
    identity: Object.freeze({ ...identity }),
    amount,
    steps: Object.freeze(
      steps.map((step) =>
        Object.freeze({
          ...step,
          request: Object.freeze({ to: String(step.request.to), data: String(step.request.data) }),
        })
      )
    ),
  });
}

type ProbeTarget = { provider: object; key: string; chainId: number };
type HealthRecord = { provider: object; key: string; result: SessionProbeResult };

/** Whether `record` was read through the wallet session `target`: the same provider, account and chain. */
function isTarget<T extends { provider: object; key: string }>(
  record: T | undefined,
  target: ProbeTarget
): record is T {
  return record !== undefined && record.provider === target.provider && record.key === target.key;
}

/**
 * The draft, review and signing lifecycle of one wrapper action at a time, for COM-287's
 * wrapped supply and COM-288's wrapped withdrawal. It never touches the standard queue or the
 * Bulker, and its steps can only call the wrapper or approve the base token to it.
 *
 * Before every signature, the hook checks the live session again:
 * - the identity the draft was reviewed under: account, connector, chain, market, wrapper, route,
 *   screening, release control and wallet provider
 * - the route's eligibility: signer, chain, screening, connector conflicts, wrapper validation and
 *   release control
 * - the step's call, Comet's pause for the action, and the step's own check
 * - a read through the wallet
 * - no other wrapper transaction of this account on this chain is pending, and the transaction
 *   manager has restored this session's stored transactions
 *
 * It checks the identity, the eligibility and the other pending transactions again after those
 * reads. It checks the identity and the eligibility once more after the gas estimate, immediately
 * before the wallet is asked. A change of identity at any point discards the draft and drops every
 * late result, so a later step is never sent without a fresh review and confirmation.
 */
export function useWrappedAction({
  session,
  manager,
  readProvider,
  probe = probeWalletSession,
  checkRestriction,
}: UseWrappedActionOptions): WrappedActionController {
  const [lifecycle, dispatch] = useReducer(lifecycleReducer, { phase: 'idle' });
  const [healthRecord, setHealthRecord] = useState<HealthRecord | undefined>(undefined);
  // Bumped whenever a draft is started, confirmed, discarded or stopped. A continuation of an
  // earlier run changes nothing.
  const runId = useRef(0);
  const draftCount = useRef(0);

  const { route, account, chainId, provider } = session;
  const probeTarget: ProbeTarget | undefined =
    route.kind === 'wrapped' && account !== undefined && chainId !== undefined && provider !== undefined
      ? { provider, key: `${account.toLowerCase()}|${chainId}`, chainId }
      : undefined;

  let health: WalletSessionHealth;
  if (probeTarget === undefined) {
    health = { status: 'not-applicable' };
  } else if (manager.walletFailure?.provider === probeTarget.provider) {
    health = { status: 'unusable', reason: 'provider-broken', instruction: UNUSABLE_INSTRUCTIONS['provider-broken'] };
  } else if (isTarget(healthRecord, probeTarget)) {
    const { result } = healthRecord;
    health =
      result.status === 'usable'
        ? { status: 'usable' }
        : { status: 'unusable', reason: result.reason, instruction: UNUSABLE_INSTRUCTIONS[result.reason] };
  } else {
    health = { status: 'checking' };
  }

  // A draft whose identity no longer holds is discarded in this render, before the effect below
  // records it, so no render shows it for review.
  const activeIdentity = identityOf(lifecycle);
  const isStale =
    activeIdentity !== undefined &&
    !isSameWrappedIdentity(activeIdentity, wrappedActionIdentity(activeIdentity.type, session));
  const state =
    isStale && activeIdentity !== undefined ? discardedFrom(lifecycle, activeIdentity, 'identity-changed') : lifecycle;

  const wrapperAddress = route.kind === 'wrapped' ? route.market?.wrapperAddress.toLowerCase() : undefined;
  const isOwnWrapperTransaction = (transaction: Transaction | SettledTransaction) =>
    wrapperAddress !== undefined &&
    transaction.key.toLowerCase() === wrapperAddress &&
    transaction.account === account?.toLowerCase() &&
    transaction.networkId === chainId;
  const recovered = {
    pending: manager.transactions.filter(isOwnWrapperTransaction),
    settled: manager.settledTransactions.filter(isOwnWrapperTransaction),
  };
  // Until the manager has restored this session's stored transactions, `recovered.pending` can lack
  // a wrapper transaction sent before a reload, so new wrapper actions wait for the restore too.
  // Otherwise a second supply can start while the first one is still pending.
  const { restoredSession } = manager;
  const isRestored =
    restoredSession !== undefined &&
    restoredSession.provider === provider &&
    restoredSession.account === account?.toLowerCase() &&
    restoredSession.chainId === chainId;

  // Callbacks run after later renders, so they read everything through this ref.
  const rendered = {
    session,
    probeTarget,
    health,
    state,
    recovered,
    isRestored,
    manager,
    readProvider,
    probe,
    checkRestriction,
  };
  const live = useRef(rendered);
  live.current = rendered;

  /**
   * Whether an earlier wrapper transaction of this account on this chain holds back a new one. Until
   * the restore has run, one can, so this is true.
   */
  const isEarlierTransactionPending = () => !live.current.isRestored || live.current.recovered.pending.length > 0;

  useEffect(() => {
    if (!isStale) return;
    runId.current++;
    dispatch({ type: 'discarded', reason: 'identity-changed' });
  }, [isStale]);

  const isUnusable = health.status === 'unusable';
  useEffect(() => {
    if (!isUnusable || !isInProgress(lifecycle)) return;
    runId.current++;
    dispatch({ type: 'session-unusable' });
  }, [isUnusable, lifecycle.phase]);

  const recordProbe = (target: ProbeTarget, result: SessionProbeResult) => {
    // A result describes the session it was read through. A result that arrives after the live
    // session changed is dropped. Otherwise it replaces the live session's record, and the live
    // session shows as being checked again with no check running.
    if (!isTarget(live.current.probeTarget, target)) return;
    // An unusable session stays unusable until its provider, account or chain changes.
    setHealthRecord((current) =>
      isTarget(current, target) && current.result.status === 'unusable'
        ? current
        : { provider: target.provider, key: target.key, result }
    );
  };

  useEffect(() => {
    if (probeTarget === undefined) return;
    let isCurrent = true;
    probe(probeTarget.provider as ProbedProvider, probeTarget.chainId).then(
      (result) => {
        if (isCurrent) recordProbe(probeTarget, result);
      },
      () => {
        if (isCurrent) recordProbe(probeTarget, { status: 'unusable', reason: 'reads-failing' });
      }
    );
    return () => {
      isCurrent = false;
    };
  }, [probeTarget?.provider, probeTarget?.key]);

  const restrictionOf = (identity: WrappedActionIdentity): Promise<MarketRestriction | undefined> => {
    const { checkRestriction: check, readProvider: reader } = live.current;
    if (check !== undefined) return check(identity).catch(() => 'restriction-unknown' as const);
    return reader === undefined ? Promise.resolve('restriction-unknown') : readMarketRestriction(reader, identity);
  };

  const blockedReason = (type: WrappedActionType): WrappedBlockReason | undefined => {
    const current = live.current;
    if (current.session.route.kind !== 'wrapped') return 'not-wrapped';
    if (current.health.status === 'unusable') return 'session-unusable';
    if (isInProgress(current.state)) return 'action-in-progress';
    const eligibility = type === 'supply' ? current.session.route.deposit : current.session.route.exit;
    if (!eligibility.isEligible) return eligibility.reason;
    if (wrappedActionIdentity(type, current.session) === undefined) return 'no-signer';
    // A fresh review waits until an earlier wrapper transaction has settled, so it reads the
    // balances and allowance that transaction leaves.
    if (isEarlierTransactionPending()) return 'transaction-pending';
    return undefined;
  };

  const start = (type: WrappedActionType, prepare: PrepareWrappedAction): WrappedBlockReason | undefined => {
    const reason = blockedReason(type);
    const identity = wrappedActionIdentity(type, live.current.session);
    if (reason !== undefined || identity === undefined) return reason ?? 'no-signer';
    const run = ++runId.current;
    dispatch({ type: 'reading', identity });
    let reading: ReturnType<PrepareWrappedAction>;
    try {
      reading = prepare(identity);
    } catch (error) {
      reading = Promise.reject(error);
    }
    reading.then(
      ({ amount, steps }) => {
        if (runId.current !== run) return;
        const draft = frozenDraft(`wrapped-action-${++draftCount.current}`, identity, amount, steps);
        const problem = checkWrappedDraft(draft);
        if (problem === undefined) dispatch({ type: 'drafted', draft });
        else dispatch({ type: 'read-failed', message: `The prepared transactions are not allowed (${problem}).` });
      },
      (error) => {
        if (runId.current === run) dispatch({ type: 'read-failed', message: describeWalletError(error) });
      }
    );
    return undefined;
  };

  const sign = async (run: number, draft: WrappedActionDraft, index: number) => {
    const step = draft.steps[index];
    const isCurrentRun = () => runId.current === run;
    const block = (reason: WrappedBlockReason, message?: string) => {
      if (isCurrentRun()) dispatch({ type: 'step', index, step: { status: 'blocked', reason, message } });
    };
    const recheck = () =>
      checkBeforeSignature(draft, step, live.current.session, live.current.health.status === 'unusable');
    // Another wrapper transaction of this account on this chain, restored or sent since the review,
    // also holds the signature back. The manager tracks this step's own request before it calls
    // `send`, so this check runs only before the request reaches the manager.
    const recheckBeforeSubmitting = () =>
      recheck() ?? (isEarlierTransactionPending() ? ('transaction-pending' as const) : undefined);
    const target: ProbeTarget = {
      provider: draft.identity.provider,
      key: `${draft.identity.account}|${draft.identity.chainId}`,
      chainId: draft.identity.chainId,
    };

    const firstProblem = recheckBeforeSubmitting();
    if (firstProblem !== undefined) return block(firstProblem);

    const restriction = await restrictionOf(draft.identity);
    if (!isCurrentRun()) return;
    if (restriction !== undefined) return block(restriction);

    if (step.check !== undefined) {
      const stepCheck = await step
        .check()
        .catch((error): { ok: false; message: string } => ({ ok: false, message: describeWalletError(error) }));
      if (!isCurrentRun()) return;
      if (!stepCheck.ok) return block('step-check-failed', stepCheck.message);
    }

    const probed = await live.current
      .probe(draft.identity.provider as ProbedProvider, draft.identity.chainId)
      .catch((): SessionProbeResult => ({ status: 'unusable', reason: 'reads-failing' }));
    if (probed.status === 'unusable') recordProbe(target, probed);
    if (!isCurrentRun()) return;
    if (probed.status === 'unusable') return block('session-unusable');

    // The session can change while the reads above run, so everything is checked once more.
    const lastProblem = recheckBeforeSubmitting();
    if (lastProblem !== undefined) return block(lastProblem);

    dispatch({ type: 'step', index, step: { status: 'awaiting-signature' } });
    let hash = '';
    let withdrawnBecause: WrappedBlockReason | undefined;
    const result = await live.current.manager.submitTransaction({
      key: draft.identity.wrapperAddress,
      description: step.description,
      step: step.id,
      account: draft.identity.account,
      chainId: draft.identity.chainId,
      send: async () => {
        // The manager reads the network and nonce through the wallet before it calls this, and gas
        // is estimated before the wallet is asked, so the session is checked again after each.
        const withdrawIfChanged = () => {
          withdrawnBecause = isCurrentRun() ? recheck() : 'identity-changed';
          if (withdrawnBecause !== undefined) throw new SendWithdrawnError();
        };
        withdrawIfChanged();
        hash = await sendStep(draft.identity, step, withdrawIfChanged);
        return hash;
      },
      onSettled: (outcome) => {
        if (isCurrentRun()) dispatch({ type: 'step', index, step: outcomeState(outcome, hash) });
      },
    });
    if (result.status === 'session-broken') recordProbe(target, { status: 'unusable', reason: 'provider-broken' });
    if (!isCurrentRun()) return;
    switch (result.status) {
      case 'submitted':
        dispatch({ type: 'step', index, step: { status: 'submitted', hash: result.hash } });
        break;
      case 'rejected':
        dispatch({ type: 'step', index, step: { status: 'rejected' } });
        break;
      case 'provider-failure':
      case 'session-broken':
        dispatch({ type: 'step', index, step: { status: 'provider-failure', message: result.message } });
        break;
      case 'session-changed':
        block(withdrawnBecause ?? 'identity-changed');
        break;
      case 'not-sent':
        block('not-sent', result.message);
        break;
      default: {
        const unhandled: never = result;
        throw new Error(`Unhandled send result ${JSON.stringify(unhandled)}`);
      }
    }
  };

  // A confirmation belongs to the draft and step in review when it was rendered. A handler kept
  // from an earlier render does nothing once another draft or step is in review. Otherwise a
  // delayed click on one review signs a step the user did not confirm.
  const reviewed = state.phase === 'review' ? { draft: state.draft, stepIndex: state.stepIndex } : undefined;
  const confirm = () => {
    const current = live.current.state;
    if (reviewed === undefined || current.phase !== 'review') return;
    if (current.draft !== reviewed.draft || current.stepIndex !== reviewed.stepIndex) return;
    const run = ++runId.current;
    dispatch({ type: 'step', index: current.stepIndex, step: { status: 'checking' } });
    void sign(run, current.draft, current.stepIndex);
  };

  const discard = () => {
    const current = live.current.state;
    runId.current++;
    if (isInProgress(current)) dispatch({ type: 'discarded', reason: 'cleared' });
    else dispatch({ type: 'reset' });
  };

  const dismissRecovered = () => {
    const current = live.current;
    if (isInProgress(current.state)) return;
    current.recovered.pending.filter(isInterrupted).forEach((transaction) => {
      current.manager.dismissTransaction(transaction.id);
    });
  };

  return {
    state,
    session: health,
    recovered,
    canDismissRecovered: recovered.pending.some(isInterrupted) && !isInProgress(state),
    blockedReason,
    start,
    confirm,
    discard,
    dismissRecovered,
  };
}

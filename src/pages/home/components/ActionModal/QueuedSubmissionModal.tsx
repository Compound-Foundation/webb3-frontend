import type { ReactNode } from 'react';

import { CircleClose } from '@components/Icons';
import type { QueuedWrapperAction } from '@helpers/queuedExecution';
import { getBlockExplorerUrl } from '@helpers/urls';
import { WrappedBlockReason, WrappedStep } from '@helpers/wrappedActions';
import type { WithdrawalReview } from '@helpers/wrappedWithdrawals';
import useDisableScroll from '@hooks/useDisableScroll';
import { WrappedActionState, WrappedStepState } from '@hooks/useWrappedAction';
import { formatExactUnits, WRAPPED_SUPPLY_STEP_IDS } from '@hooks/useWriteWrappedState';

/** A queue being submitted on the wrapped route: the wrapper action first, then the direct actions. */
export type QueuedSubmission = {
  wrapper: QueuedWrapperAction;
  /** How many queued actions go to Comet or the Bulker after the wrapper action, in one transaction. */
  directCount: number;
  /** Why the wrapper action did not start, if it did not. Nothing was sent. */
  refusal?: WrappedBlockReason;
  /** Whether the wrapper action confirmed and left the queue. */
  isWrapperDone: boolean;
};

/** What the page knows about this account's earlier wrapper requests, and the wallet session. */
export type SubmissionRecovery = {
  canDismissRecovered: boolean;
  isRecoveredRequestPendingInWallet: boolean;
  hasUnansweredWalletRequest: boolean;
  walletRefusalMessage: string | undefined;
  /** What to do about a wallet session found unusable, or undefined while it is usable. */
  sessionInstruction: string | undefined;
};

export type QueuedSubmissionModalProps = {
  submission: QueuedSubmission;
  /** The wrapper action lifecycle's state for this submission, or idle before its review starts. */
  state: WrappedActionState;
  symbol: string;
  /** The base token's decimals, or undefined when the market is not known. */
  decimals: number | undefined;
  recovery: SubmissionRecovery;
  /** Confirms the step in review. Each step is confirmed on its own. */
  onConfirm: () => void;
  /** Closes the dialog. While a step is being signed, it only hides the dialog. */
  onClose: () => void;
  /** Submits the remaining direct actions, once the wrapper action has left the queue. */
  onContinue: () => void;
  onDismissRecovered: () => void;
};

/** The decimals of wrapper shares. */
const SHARE_DECIMALS = 18;

const SUPPLY_CHECKING_TEXT = 'Checking your balance, allowance and wallet before asking it to sign.';
const WITHDRAW_CHECKING_TEXT =
  'Reading your shares and the market again, and simulating the withdrawal from your account, before asking your wallet to sign.';
const STAYS_QUEUED = 'Nothing more is sent. Your actions stay in the queue, so you can submit them again.';

/** A link to a transaction on the block explorer of its chain. */
function ExplorerLink({ chainId, hash }: { chainId: number; hash: string }) {
  return (
    <a
      className="button button--small"
      href={`${getBlockExplorerUrl(chainId)}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
    >
      View on Explorer
    </a>
  );
}

/** Why a step, or the start of the wrapper action, stopped before the wallet was asked, as the end of a sentence. */
export function blockedReasonText(reason: WrappedBlockReason, message: string | undefined): string {
  switch (reason) {
    case 'identity-changed':
      return 'your wallet, network or market changed';
    case 'session-unusable':
      return 'your wallet stopped responding';
    case 'transaction-pending':
      return 'another wrapped transaction from this account is still pending';
    case 'action-in-progress':
      return 'another supply or withdrawal is already in progress';
    case 'supply-paused':
      return 'supplying to this market is paused';
    case 'withdraw-paused':
      return 'withdrawals from this market are paused';
    case 'restriction-unknown':
      return "the market's pause state could not be read";
    case 'deposits-disabled':
      return 'supplying to this market is not open yet';
    case 'exits-disabled':
      return 'withdrawing from this market is not open yet';
    case 'screening':
      return 'your address has not passed screening';
    case 'wrong-chain':
      return 'your wallet is on another network';
    case 'disconnected':
    case 'reconnecting':
    case 'no-signer':
    case 'no-account':
    case 'validation-pending':
      return 'your wallet and this market are still being checked';
    case 'step-check-failed':
      return message ?? 'a check before signing refused it';
    case 'not-sent':
      return message === undefined
        ? 'the request failed before your wallet was asked'
        : `the request failed before your wallet was asked (${message})`;
    default:
      return `the request did not pass this page's checks (${reason})`;
  }
}

/**
 * What a step means when the wallet answered that it still holds the request. The Anchorage
 * extension answers so after a request waits for approval on a phone for about 4 minutes 47
 * seconds. If the user approves the request later, the wallet sends it, and this page never
 * receives its hash. `message` is the wallet's own answer, which ends with its code.
 */
function pendingInWalletText(message: string): string {
  return (
    'Your wallet still has this request open. Approve or reject it in the Anchorage app on your phone. ' +
    'Approving it still sends the transaction, but this page cannot follow that transaction. ' +
    'The request may still go through, so check your wallet before you try again. ' +
    'Once your wallet shows the request done, reload this page to see the result. ' +
    'After you press Stop waiting on your next submission, it starts from the new balances. ' +
    `(Your wallet reported: ${message})`
  );
}

/** What a step's state means for the user. Each state reads differently from every other. */
export function stepStatusText(
  step: WrappedStepState,
  isNext: boolean,
  isStopped: boolean,
  checkingText: string
): string {
  switch (step.status) {
    case 'waiting':
      if (isStopped) return 'Not sent.';
      return isNext ? 'Ready for you to confirm.' : 'Waits for the step before it.';
    case 'checking':
      return checkingText;
    case 'awaiting-signature':
      return 'Confirm the request in your wallet. Approval on a mobile device can take a few minutes.';
    case 'submitted':
      return 'Broadcast. Waiting for the network to confirm it.';
    case 'confirmed':
      return 'Confirmed.';
    case 'reverted':
      return 'This transaction failed on chain.';
    case 'replaced':
      return 'This transaction was replaced or dropped: the network used its nonce for another transaction.';
    case 'unresolved':
      return 'This transaction was sent, but this page can no longer follow it. Check it on the explorer.';
    case 'rejected':
      return 'You rejected the request in your wallet. Nothing was sent.';
    case 'refused':
      return `Your wallet refused this request before handling it (${step.message}), so nothing was sent. Disconnect and reconnect your wallet on this page, then submit again.`;
    case 'provider-failure':
      if (step.isPendingInWallet === true) return pendingInWalletText(step.message);
      return `Your wallet reported an error (${step.message}). The request may still go through, so check your wallet before you try again.`;
    case 'blocked':
      return `Stopped before your wallet was asked, so nothing was sent: ${blockedReasonText(
        step.reason,
        step.message
      )}.`;
  }
}

/** The disabled button's label while a step is being signed. */
function signingLabel(step: WrappedStepState): string {
  switch (step.status) {
    case 'awaiting-signature':
      return 'Waiting for Your Wallet';
    case 'submitted':
      return 'Waiting for the Network';
    default:
      return 'Checking';
  }
}

/** The confirm button's label for a supply's step. */
function supplyConfirmLabel(step: WrappedStep, amount: string): string {
  switch (step.id) {
    case WRAPPED_SUPPLY_STEP_IDS.reset:
      return 'Reset Allowance';
    case WRAPPED_SUPPLY_STEP_IDS.approve:
      return `Approve ${amount}`;
    case WRAPPED_SUPPLY_STEP_IDS.supply:
      return `Supply ${amount}`;
    default:
      return step.description;
  }
}

/**
 * The account's earlier wrapper requests that hold back a new one, and a wallet that refused the
 * last request. Each notice says what the user can do.
 */
function RecoveryNotices({
  recovery,
  onDismissRecovered,
}: {
  recovery: SubmissionRecovery;
  onDismissRecovered: () => void;
}) {
  return (
    <>
      {recovery.sessionInstruction !== undefined && (
        <div className="submission-steps__warning" role="alert">
          <p className="body">{recovery.sessionInstruction}</p>
          <button className="button button--small" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      {recovery.hasUnansweredWalletRequest && (
        <p className="L4 meta text-color--2">
          Your wallet has not answered a request for an earlier wrapped transaction from this account. New supplies and
          withdrawals wait for that answer. Look for the request in your wallet app. If it is not there, reload the page
          and reconnect your wallet. You can then stop waiting for it.
        </p>
      )}
      {recovery.canDismissRecovered && (
        <div className="submission-steps__warning">
          <p className="body">
            {recovery.isRecoveredRequestPendingInWallet
              ? 'Your wallet reported that it still has a request open for an earlier wrapped transaction from this account. Approve or reject it in the Anchorage app on your phone. Approving it still sends the transaction, but this page cannot follow that transaction. Once your wallet shows the request done, reload this page to see the result. Stop waiting only after checking your wallet: the request can still go through.'
              : 'A wallet request for an earlier wrapped transaction from this account was left open, and this page cannot follow it. Stop waiting only after checking your wallet: the request can still go through.'}
          </p>
          <button className="button button--small" onClick={onDismissRecovered}>
            Stop waiting
          </button>
        </div>
      )}
      {recovery.walletRefusalMessage !== undefined && (
        <p className="L4 meta text-color--2">
          Your wallet refused the last wrapped request from this account before handling it (
          {recovery.walletRefusalMessage}). Nothing was sent. Disconnect and reconnect your wallet on this page, then
          submit again.
        </p>
      )}
    </>
  );
}

/**
 * Tells the user that the full exit's cash changed since the page showed it, and by how much. The
 * user confirms the new figure, or closes the dialog.
 */
function EstimateChange({
  review,
  formatAmount,
}: {
  review: WithdrawalReview;
  formatAmount: (value: bigint) => string;
}) {
  const { shownCash, quote } = review;
  if (shownCash === undefined || shownCash === quote.cash) return null;
  const difference = quote.cash > shownCash ? quote.cash - shownCash : shownCash - quote.cash;
  return (
    <div className="submission-steps__warning" role="alert">
      <p className="body">
        The estimate is now {formatAmount(quote.cash)}, {formatAmount(difference)}{' '}
        {quote.cash > shownCash ? 'more' : 'less'} than the {formatAmount(shownCash)} shown before this review read your
        position again. Check it before you confirm.
      </p>
    </div>
  );
}

/**
 * Tells the user that the check before the signature found a different estimate from the one they
 * reviewed, and by how much. While the wallet has the request, the user can reject it there. The
 * estimate can still change after the check, because the exit has no minimum or maximum amount.
 */
function RecheckedChange({
  reviewedCash,
  recheckedCash,
  canReject,
  formatAmount,
}: {
  reviewedCash: bigint;
  recheckedCash: bigint;
  /** Whether the wallet has the request, so the user can still reject it. */
  canReject: boolean;
  formatAmount: (value: bigint) => string;
}) {
  const difference = recheckedCash > reviewedCash ? recheckedCash - reviewedCash : reviewedCash - recheckedCash;
  return (
    <div className="submission-steps__warning" role="alert">
      <p className="body">
        This page read the market again before it asked your wallet. The estimate is now {formatAmount(recheckedCash)},{' '}
        {formatAmount(difference)} {recheckedCash > reviewedCash ? 'more' : 'less'} than the{' '}
        {formatAmount(reviewedCash)} you reviewed.
        {canReject && ' If you do not want to withdraw about this amount, reject the request in your wallet.'} The
        amount can still change before the transaction is mined.
      </p>
    </div>
  );
}

/** The quoted figures: the cash, the shares' value, the buffer the wrapper holds back, and the shares burned. */
function QuoteFigures({ review, formatAmount }: { review: WithdrawalReview; formatAmount: (value: bigint) => string }) {
  const { quote } = review;
  return (
    <div className="submission-steps__figures">
      <div className="submission-steps__figure">
        <label className="L3 label text-color--2">You receive (estimated)</label>
        <p className="body body--emphasized" data-testid="wrapped-withdraw-cash">
          {formatAmount(quote.cash)}
        </p>
      </div>
      <div className="submission-steps__figure">
        <label className="L3 label text-color--2">Your shares are worth</label>
        <p className="body" data-testid="wrapped-withdraw-gross">
          {formatAmount(quote.grossAssets)}
        </p>
      </div>
      <div className="submission-steps__figure">
        <label className="L3 label text-color--2">Held back by the wrapper for rounding</label>
        <p className="body" data-testid="wrapped-withdraw-buffer">
          {formatAmount(quote.redeemBuffer)}
        </p>
      </div>
      <div className="submission-steps__figure">
        <label className="L3 label text-color--2">Shares burned</label>
        <p className="body" data-testid="wrapped-withdraw-shares">
          {formatExactUnits(quote.shares, SHARE_DECIMALS)}
        </p>
      </div>
    </div>
  );
}

type DraftState = Extract<WrappedActionState, { draft: unknown }>;

/** What a withdrawal's review shows above its step: the quote, and how it changed. */
function WithdrawalDetails({
  state,
  symbol,
  formatAmount,
}: {
  state: DraftState;
  symbol: string;
  formatAmount: (value: bigint) => string;
}) {
  const { draft, steps, stepIndex, phase, rechecked } = state;
  const reviewed = draft.withdrawal;
  // The lifecycle refuses a withdrawal without its quote, so none reaches review.
  if (reviewed === undefined) return null;
  const review =
    rechecked === undefined ? reviewed : { ...reviewed, quote: rechecked.quote, blockNumber: rechecked.blockNumber };
  const isRecheckedCashChanged = rechecked !== undefined && rechecked.quote.cash !== reviewed.quote.cash;
  const { quote, request } = review;
  const cash = formatAmount(quote.cash);
  const isBeforeSignature = phase === 'review' || phase === 'signing';
  let lead: string;
  if (phase === 'complete') {
    lead = `Withdrew about ${cash} to your wallet. The transaction shows the exact amount.`;
  } else if (quote.kind === 'full') {
    lead = `Withdraw all your supplied ${symbol}, about ${cash}, to your wallet.`;
  } else {
    lead = `Withdraw about ${cash} to your wallet.`;
  }
  return (
    <>
      <p className="body">{lead}</p>
      <QuoteFigures review={review} formatAmount={formatAmount} />
      <p className="L4 meta text-color--2">
        Your wallet may show the shares in their base units: {quote.shares.toString()}.
      </p>
      {isBeforeSignature &&
        (isRecheckedCashChanged ? (
          <RecheckedChange
            reviewedCash={reviewed.quote.cash}
            recheckedCash={quote.cash}
            canReject={steps[stepIndex].status === 'awaiting-signature'}
            formatAmount={formatAmount}
          />
        ) : (
          <EstimateChange review={review} formatAmount={formatAmount} />
        ))}
      {/* This notice gives whole shares as the reason, which explains only the reviewed cash. */}
      {isBeforeSignature && !isRecheckedCashChanged && request.kind === 'partial' && quote.cash > request.cash && (
        <p className="L4 meta text-color--2">
          This is {formatAmount(quote.cash - request.cash)} more than the {formatAmount(request.cash)} you entered,
          because shares are burned in whole units.
        </p>
      )}
      {isBeforeSignature && quote.leavesDust && (
        <p className="L4 meta text-color--2">
          The {symbol} left after this is worth no more than the wrapper&apos;s rounding buffer, so it cannot be
          withdrawn on its own. To withdraw it too, close this and queue the maximum withdrawal instead.
        </p>
      )}
      {isBeforeSignature && (
        <p className="L4 meta text-color--2">
          The wrapper works out the amount when the transaction runs. This page simulates the withdrawal from your
          account just before your wallet signs it, but the transaction has no minimum amount and no deadline. If the
          market changes before it is mined, it can pay a different amount, or fail. It burns your wrapper shares and
          pays from the wrapper&apos;s own balance in the market, so it cannot open a borrow.
        </p>
      )}
    </>
  );
}

/**
 * The shared submission dialog for a queue on the wrapped route. It lists every wallet transaction
 * in the order they are sent: the wrapper action's steps (an exact approval, after a reset to zero
 * for USDT, then `supplyAndWrap`; or `unwrapAndWithdraw`), then the queue's direct actions as one
 * transaction to Comet or the Bulker. Each step is confirmed on its own. The direct actions are
 * submitted only after the wrapper action confirms. A step that stops leaves every action that did
 * not complete in the queue.
 */
const QueuedSubmissionModal = ({
  submission,
  state,
  symbol,
  decimals,
  recovery,
  onConfirm,
  onClose,
  onContinue,
  onDismissRecovered,
}: QueuedSubmissionModalProps) => {
  useDisableScroll(true);
  const { wrapper, directCount, refusal, isWrapperDone } = submission;
  const formatAmount = (value: bigint) =>
    decimals === undefined
      ? `${value.toString()} base units of ${symbol}`
      : `${formatExactUnits(value, decimals)} ${symbol}`;
  const directLabel = `${directCount} other action${directCount === 1 ? '' : 's'}`;
  const remainingLabel = `Submit ${directCount} Remaining Action${directCount === 1 ? '' : 's'}`;
  const noun = wrapper.type === 'supply' ? 'supply' : 'withdrawal';

  let title: string;
  let content: ReactNode;
  let actions: ReactNode;
  const closeButton = (label: string) => (
    <button className="button button--x-large" onClick={onClose}>
      {label}
    </button>
  );
  const directItem = (status: string) =>
    directCount > 0 && (
      <li className="submission-steps__step">
        <p className="body body--emphasized">{`Then ${directLabel}, sent together as one transaction`}</p>
        <p className="L4 meta text-color--2">{status}</p>
      </li>
    );

  if (refusal !== undefined) {
    title = 'Submission Not Started';
    content = (
      <>
        <p className="body">{`Nothing was sent: ${blockedReasonText(refusal, undefined)}.`}</p>
        <RecoveryNotices recovery={recovery} onDismissRecovered={onDismissRecovered} />
        <p className="L4 meta text-color--2">Your actions stay in the queue, so you can submit them again.</p>
      </>
    );
    actions = closeButton('Close');
  } else {
    switch (state.phase) {
      case 'idle':
      case 'reading':
        title = 'Preparing Your Transactions';
        content = (
          <p className="body">
            {wrapper.type === 'supply'
              ? "Reading your wallet balance and the wrapper's allowance."
              : 'Reading your supplied position and the market at the newest block.'}
          </p>
        );
        actions = closeButton('Cancel');
        break;
      case 'read-failed':
        title = 'Submission Not Ready';
        content = (
          <>
            <p className="body">{state.message}</p>
            <p className="L4 meta text-color--2">{STAYS_QUEUED}</p>
          </>
        );
        actions = closeButton('Close');
        break;
      case 'discarded': {
        const why =
          state.reason === 'identity-changed'
            ? `Your wallet, network or market changed, so this ${noun} was closed.`
            : state.reason === 'session-unusable'
            ? `Your wallet stopped responding, so this ${noun} was closed.`
            : `You closed this ${noun}.`;
        title = 'Submission Closed';
        content = (
          <>
            <p className="body">{why}</p>
            {state.submittedHashes.length > 0 && (
              <>
                <p className="body">Already sent, and not cancelled:</p>
                <ul className="submission-steps__steps">
                  {state.submittedHashes.map((hash) => (
                    <li key={hash} className="submission-steps__step">
                      <ExplorerLink chainId={state.chainId} hash={hash} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            {state.isWalletRequestOpen ? (
              <>
                <p className="body">A request is still open in your wallet. Approving it there still sends it.</p>
                <p className="L4 meta text-color--2">
                  Nothing more is sent from this submission. New supplies and withdrawals from this account wait until
                  your wallet answers the request. Look for the request in your wallet app. If it is not there, reload
                  the page and reconnect your wallet. You can then stop waiting for it.
                </p>
              </>
            ) : (
              <p className="L4 meta text-color--2">{STAYS_QUEUED}</p>
            )}
          </>
        );
        actions = closeButton('Close');
        break;
      }
      default: {
        const { draft, steps, stepIndex, phase, rechecked } = state;
        const isStopped = phase === 'stopped';
        const isComplete = phase === 'complete';
        const checkingText = wrapper.type === 'supply' ? SUPPLY_CHECKING_TEXT : WITHDRAW_CHECKING_TEXT;
        const amount = formatAmount(draft.amount);
        if (isComplete) title = directCount > 0 ? 'Continue Your Submission' : 'Transactions Confirmed';
        else if (isStopped) title = 'Submission Stopped';
        else title = 'Submit Your Actions';

        let directStatus = 'Sent after the steps above, as a separate transaction.';
        if (isStopped) directStatus = 'Not sent. It stays in your queue.';
        else if (isComplete) directStatus = isWrapperDone ? 'Ready to submit.' : 'Waits for the queue to update.';

        content = (
          <>
            <p className="L4 meta text-color--2">
              Your queue is sent in the order below. Each wallet transaction waits for your confirmation here.
            </p>
            {wrapper.type === 'supply' ? (
              <>
                <p className="body">
                  {isComplete
                    ? `Supplied ${amount} to the market through its wrapper.`
                    : `Supply ${amount} from your wallet to the market through its wrapper.`}
                </p>
                <p className="L4 meta text-color--2">
                  Your wallet may show this amount in the token&apos;s base units: {draft.amount.toString()}. An
                  approval is for exactly this amount.
                </p>
              </>
            ) : (
              <WithdrawalDetails state={state} symbol={symbol} formatAmount={formatAmount} />
            )}
            <ol className="submission-steps__steps">
              {draft.steps.map((step, index) => {
                const stepState = steps[index];
                const description =
                  index === stepIndex && rechecked !== undefined ? rechecked.description : step.description;
                return (
                  <li key={step.id} className="submission-steps__step">
                    <p className="body body--emphasized">{description}</p>
                    <p className="L4 meta text-color--2">
                      {stepStatusText(stepState, index === stepIndex && phase === 'review', isStopped, checkingText)}
                    </p>
                    {'hash' in stepState && <ExplorerLink chainId={draft.identity.chainId} hash={stepState.hash} />}
                  </li>
                );
              })}
              {directItem(directStatus)}
            </ol>
            {isStopped && <p className="L4 meta text-color--2">{STAYS_QUEUED}</p>}
            {isStopped && <RecoveryNotices recovery={recovery} onDismissRecovered={onDismissRecovered} />}
            {phase === 'signing' && (
              <p className="L4 meta text-color--2">
                If you close this dialog, nothing more is sent without your confirmation. A request already in your
                wallet, or a transaction already on the network, is not cancelled.
              </p>
            )}
          </>
        );

        if (phase === 'review') {
          const step = draft.steps[stepIndex];
          const confirmLabel =
            wrapper.type === 'supply'
              ? supplyConfirmLabel(step, amount)
              : draft.withdrawal?.quote.kind === 'full'
              ? 'Withdraw Everything'
              : `Withdraw About ${formatAmount((rechecked ?? draft.withdrawal)?.quote.cash ?? 0n)}`;
          actions = (
            <>
              {closeButton('Cancel')}
              <button className="button button--x-large button--supply" onClick={onConfirm}>
                {confirmLabel}
              </button>
            </>
          );
        } else if (phase === 'signing') {
          actions = (
            <>
              {closeButton('Close')}
              <button className="button button--x-large button--supply" disabled>
                {signingLabel(steps[stepIndex])}
              </button>
            </>
          );
        } else if (isComplete && directCount > 0) {
          actions = (
            <>
              {closeButton('Close')}
              <button className="button button--x-large button--supply" disabled={!isWrapperDone} onClick={onContinue}>
                {remainingLabel}
              </button>
            </>
          );
        } else {
          actions = closeButton(isComplete ? 'Done' : 'Close');
        }
      }
    }
  }

  const isSigning = refusal === undefined && state.phase === 'signing';
  return (
    <div className="modal modal--active">
      <div className="modal__backdrop" onClick={isSigning ? undefined : onClose}></div>
      <div className="modal__content L4 submission-steps" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__content__header">
          <div className="modal__content__header__left"></div>
          <h4 className="heading heading--emphasized heading">{title}</h4>
          <div className="modal__content__header__right">
            <button className="submission-steps__close" aria-label="Close dialog" onClick={onClose}>
              <CircleClose />
            </button>
          </div>
        </div>
        <div className="modal__content__paragraph modal__content__paragraph--left-align">{content}</div>
        <div className="modal__content__action-row submission-steps__actions">{actions}</div>
      </div>
    </div>
  );
};

export default QueuedSubmissionModal;

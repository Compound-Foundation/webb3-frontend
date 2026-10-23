import type { ReactNode } from 'react';

import { WithdrawalReview } from '@helpers/wrappedWithdrawals';
import useDisableScroll from '@hooks/useDisableScroll';
import { WrappedActionState } from '@hooks/useWrappedAction';
import { formatExactUnits } from '@hooks/useWriteWrappedState';

import {
  DiscardedContent,
  ExplorerLink,
  signingLabel,
  stepStatusText,
  WrappedActionDialog,
} from './WrappedActionDialog';

export type WrappedWithdrawModalProps = {
  /** The wrapper action lifecycle's state. The dialog shows a wrapped withdrawal's. */
  state: WrappedActionState;
  symbol: string;
  /** The base token's decimals, or undefined when the market is not known. */
  decimals: number | undefined;
  /** Confirms the exit in review. */
  onConfirm: () => void;
  /** Closes the review. Nothing already sent is cancelled. */
  onClose: () => void;
};

/** The decimals of wrapper shares. */
const SHARE_DECIMALS = 18;

/** What an exit checks after the user confirms it, before the wallet is asked. */
const WITHDRAW_CHECKING_TEXT =
  'Reading your shares and the market again, and simulating the withdrawal from your account, before asking your wallet to sign.';

/** Whether the dialog has something to show for `state`. */
export function isWrappedWithdrawModalState(state: WrappedActionState): boolean {
  switch (state.phase) {
    case 'idle':
      return false;
    case 'reading':
    case 'read-failed':
      return state.identity.type === 'withdraw';
    case 'discarded':
      // A review the user closed before anything reached the wallet needs no notice.
      return (
        state.type === 'withdraw' &&
        (state.reason !== 'cleared' || state.submittedHashes.length > 0 || state.isWalletRequestOpen)
      );
    default:
      return state.draft.identity.type === 'withdraw';
  }
}

/**
 * Tells the user that the full exit's cash changed since the page showed it, and by how much. The
 * user confirms the new figure, or closes the review.
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
    <div className="wrapped-action-modal__warning" role="alert">
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
    <div className="wrapped-action-modal__warning" role="alert">
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
    <div className="wrapped-action-modal__figures">
      <div className="wrapped-action-modal__figure">
        <label className="L3 label text-color--2">You receive (estimated)</label>
        <p className="body body--emphasized" data-testid="wrapped-withdraw-cash">
          {formatAmount(quote.cash)}
        </p>
      </div>
      <div className="wrapped-action-modal__figure">
        <label className="L3 label text-color--2">Your shares are worth</label>
        <p className="body" data-testid="wrapped-withdraw-gross">
          {formatAmount(quote.grossAssets)}
        </p>
      </div>
      <div className="wrapped-action-modal__figure">
        <label className="L3 label text-color--2">Held back by the wrapper for rounding</label>
        <p className="body" data-testid="wrapped-withdraw-buffer">
          {formatAmount(quote.redeemBuffer)}
        </p>
      </div>
      <div className="wrapped-action-modal__figure">
        <label className="L3 label text-color--2">Shares burned</label>
        <p className="body" data-testid="wrapped-withdraw-shares">
          {formatExactUnits(quote.shares, SHARE_DECIMALS)}
        </p>
      </div>
    </div>
  );
}

/**
 * The review and status of a wrapped withdrawal. It shows:
 * - the estimated cash, next to the shares' value and the buffer the wrapper holds back
 * - the shares burned
 * - what became of the exit, and a link to its transaction
 *
 * The review says that the exit has no minimum amount or deadline, and that the simulation before
 * the signature enforces neither. It says when a full exit's estimate changed since the page
 * showed it. It also says when a partial exit leaves shares that cannot be withdrawn on their own.
 *
 * Once the check before the signature passes, the dialog shows the exit as that check found it,
 * and says when its estimate changed since the review. The wallet's request then pays what the
 * dialog shows at the block the check read.
 */
const WrappedWithdrawModal = ({ state, symbol, decimals, onConfirm, onClose }: WrappedWithdrawModalProps) => {
  const isOpen = isWrappedWithdrawModalState(state);
  useDisableScroll(isOpen);
  if (!isOpen) return null;

  const formatAmount = (value: bigint) =>
    decimals === undefined
      ? `${value.toString()} base units of ${symbol}`
      : `${formatExactUnits(value, decimals)} ${symbol}`;
  let title: string;
  let content: ReactNode;
  let actions: ReactNode;
  const closeButton = (label: string) => (
    <button className="button button--x-large" onClick={onClose}>
      {label}
    </button>
  );

  switch (state.phase) {
    case 'idle':
      return null;
    case 'reading':
      title = 'Checking Your Position';
      content = <p className="body">Reading your wrapped position and the market at the newest block.</p>;
      actions = closeButton('Cancel');
      break;
    case 'read-failed':
      title = 'Withdrawal Not Ready';
      content = <p className="body">{state.message}</p>;
      actions = closeButton('Close');
      break;
    case 'discarded':
      title = 'Withdrawal Closed';
      content = (
        <DiscardedContent
          reason={state.reason}
          chainId={state.chainId}
          submittedHashes={state.submittedHashes}
          isWalletRequestOpen={state.isWalletRequestOpen}
          noun="withdrawal"
        />
      );
      actions = closeButton('Close');
      break;
    default: {
      const { draft, steps, stepIndex, phase, rechecked } = state;
      const reviewed = draft.withdrawal;
      // The submission guard refuses a withdrawal without its quote, so none reaches review.
      if (reviewed === undefined) return null;
      const review =
        rechecked === undefined
          ? reviewed
          : { ...reviewed, quote: rechecked.quote, blockNumber: rechecked.blockNumber };
      const isRecheckedCashChanged = rechecked !== undefined && rechecked.quote.cash !== reviewed.quote.cash;
      const { quote, request } = review;
      const cash = formatAmount(quote.cash);
      const isStopped = phase === 'stopped';
      title =
        phase === 'complete'
          ? 'Withdrawal Confirmed'
          : isStopped
          ? 'Withdrawal Stopped'
          : `Withdraw ${symbol} From the Wrapper`;
      let lead: string;
      if (phase === 'complete') {
        lead = `Withdrew about ${cash} from the wrapper to your wallet. The transaction shows the exact amount. Your wrapped position is updating.`;
      } else if (quote.kind === 'full') {
        lead = `Withdraw all your wrapped ${symbol}, about ${cash}, from the wrapper to your wallet.`;
      } else {
        lead = `Withdraw about ${cash} from the wrapper to your wallet.`;
      }
      const isBeforeSignature = phase === 'review' || phase === 'signing';
      const step = draft.steps[stepIndex];
      const stepState = steps[stepIndex];

      content = (
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
                canReject={stepState.status === 'awaiting-signature'}
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
              The wrapped {symbol} left after this is worth no more than the wrapper&apos;s rounding buffer, so it
              cannot be withdrawn on its own. To withdraw it too, close this and choose Everything.
            </p>
          )}
          {isBeforeSignature && (
            <>
              <p className="L4 meta text-color--2">
                The wrapper works out the amount when the transaction runs. This page simulates the withdrawal from your
                account just before your wallet signs it, but the transaction has no minimum amount and no deadline. If
                the market changes before it is mined, it can pay a different amount, or fail.
              </p>
              <p className="L4 meta text-color--2">
                It burns your wrapper shares and pays from the wrapper&apos;s own balance in the market. Your direct
                position in the market does not change, so this cannot open a borrow.
              </p>
            </>
          )}
          <ol className="wrapped-action-modal__steps">
            <li key={step.id} className="wrapped-action-modal__step">
              <p className="body body--emphasized">{rechecked?.description ?? step.description}</p>
              <p className="L4 meta text-color--2">
                {stepStatusText(stepState, phase === 'review', isStopped, WITHDRAW_CHECKING_TEXT)}
              </p>
              {'hash' in stepState && <ExplorerLink chainId={draft.identity.chainId} hash={stepState.hash} />}
            </li>
          </ol>
          {isStopped && (
            <p className="L4 meta text-color--2">
              This withdrawal stopped, and nothing more is sent from it. Start a new review to try again.
            </p>
          )}
          {phase === 'signing' && (
            <p className="L4 meta text-color--2">
              If you close this dialog, a request already in your wallet, or a transaction already on the network, is
              not cancelled.
            </p>
          )}
        </>
      );

      if (phase === 'review') {
        actions = (
          <>
            <button className="button button--x-large" onClick={onClose}>
              Cancel
            </button>
            <button className="button button--x-large button--supply" onClick={onConfirm}>
              {quote.kind === 'full' ? 'Withdraw Everything' : `Withdraw About ${cash}`}
            </button>
          </>
        );
      } else if (phase === 'signing') {
        actions = (
          <>
            {closeButton('Close')}
            <button className="button button--x-large button--supply" disabled>
              {signingLabel(stepState)}
            </button>
          </>
        );
      } else {
        actions = closeButton(phase === 'complete' ? 'Done' : 'Close');
      }
    }
  }

  return <WrappedActionDialog title={title} content={content} actions={actions} onClose={onClose} />;
};

export default WrappedWithdrawModal;

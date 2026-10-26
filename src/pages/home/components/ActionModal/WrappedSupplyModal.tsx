import type { ReactNode } from 'react';

import { CircleClose } from '@components/Icons';
import { getBlockExplorerUrl } from '@helpers/urls';
import { WrappedBlockReason, WrappedStep } from '@helpers/wrappedActions';
import useDisableScroll from '@hooks/useDisableScroll';
import { WrappedActionState, WrappedStepState } from '@hooks/useWrappedAction';
import { formatExactUnits, WRAPPED_SUPPLY_STEP_IDS } from '@hooks/useWriteWrappedState';

export type WrappedSupplyModalProps = {
  /** The wrapper action lifecycle's state. The dialog shows a wrapped supply's. */
  state: WrappedActionState;
  symbol: string;
  /** The base token's decimals, or undefined when the market is not known. */
  decimals: number | undefined;
  /** The account's direct Comet borrow on this market, in base units, or undefined while unknown. */
  directBorrowBalance: bigint | undefined;
  /** Confirms the step in review. Each step is confirmed on its own. */
  onConfirm: () => void;
  /** Closes the review. Nothing already sent is cancelled. */
  onClose: () => void;
};

/** Whether the dialog has something to show for `state`. */
export function isWrappedSupplyModalState(state: WrappedActionState): boolean {
  switch (state.phase) {
    case 'idle':
      return false;
    case 'reading':
    case 'read-failed':
      return state.identity.type === 'supply';
    case 'discarded':
      // A review the user closed before anything reached the wallet needs no notice.
      return (
        state.type === 'supply' &&
        (state.reason !== 'cleared' || state.submittedHashes.length > 0 || state.isWalletRequestOpen)
      );
    default:
      return state.draft.identity.type === 'supply';
  }
}

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

function blockedReasonText(reason: WrappedBlockReason, message: string | undefined): string {
  switch (reason) {
    case 'identity-changed':
      return 'your wallet, network or market changed';
    case 'session-unusable':
      return 'your wallet stopped responding';
    case 'transaction-pending':
      return 'another wrapped transaction from this account is still pending';
    case 'supply-paused':
      return 'supplying to this market is paused';
    case 'restriction-unknown':
      return "the market's pause state could not be read";
    case 'deposits-disabled':
      return 'wrapped deposits are closed';
    case 'screening':
      return 'your address has not passed screening';
    case 'wrong-chain':
      return 'your wallet is on another network';
    case 'disconnected':
    case 'reconnecting':
    case 'no-signer':
    case 'no-account':
      return 'your wallet is not connected and ready';
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
    'Once your wallet shows the request done, reload this page. The panel then shows the result. ' +
    'After you press Stop waiting there, a new review starts from the new balances. ' +
    `(Your wallet reported: ${message})`
  );
}

/** What a step's state means for the user. Each state reads differently from every other. */
function stepStatusText(step: WrappedStepState, isNext: boolean, isStopped: boolean): string {
  switch (step.status) {
    case 'waiting':
      if (isStopped) return 'Not sent.';
      return isNext ? 'Ready for you to confirm.' : 'Waits for the step before it.';
    case 'checking':
      return 'Checking your balance, allowance and wallet before asking it to sign.';
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
      return `Your wallet refused this request before handling it (${step.message}), so nothing was sent. Disconnect and reconnect your wallet on this page, then start a new review.`;
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

/** The confirm button's label for a step. */
function confirmLabel(step: WrappedStep, amount: string): string {
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

/**
 * Before the wallet signs, tells an account that also borrows directly from the market that this
 * supply lends through the wrapper and does not repay that borrow. Repay stays a separate, direct
 * action. While the direct position is not known, the warning is shown without its amount. With no
 * borrow known, the dialog still says so plainly, since a borrow made elsewhere can be newer than
 * the position this page read.
 */
function DirectDebtWarning({
  directBorrowBalance,
  symbol,
  decimals,
}: {
  directBorrowBalance: bigint | undefined;
  symbol: string;
  decimals: number | undefined;
}) {
  if (directBorrowBalance !== undefined && directBorrowBalance <= 0n) {
    return (
      <p className="L4 meta text-color--2">
        This supply lends to the market through the wrapper. It does not repay a direct borrow: only Repay does.
      </p>
    );
  }
  const debt =
    directBorrowBalance === undefined || decimals === undefined
      ? undefined
      : `${formatExactUnits(directBorrowBalance, decimals)} ${symbol}`;
  return (
    <div className="wrapped-supply-modal__warning" role="alert">
      <p className="body">
        {debt === undefined
          ? 'This supply lends to the market through the wrapper. It does not repay a direct borrow you may have on this market.'
          : `You have a direct borrow of ${debt} on this market. This supply lends to the market through the wrapper. It does not repay your borrow.`}{' '}
        To repay it, close this and use Repay.
      </p>
    </div>
  );
}

/**
 * The review and status of a wrapped supply: the exact amount, each step with what became of it
 * and a link to its transaction, and a warning when the account also borrows directly. Each step
 * is confirmed on its own. The supply stops when the dialog is closed: a later step is never sent,
 * and nothing already sent is cancelled.
 */
const WrappedSupplyModal = ({
  state,
  symbol,
  decimals,
  directBorrowBalance,
  onConfirm,
  onClose,
}: WrappedSupplyModalProps) => {
  const isOpen = isWrappedSupplyModalState(state);
  useDisableScroll(isOpen);
  if (!isOpen) return null;

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
      title = 'Checking Your Balance';
      content = <p className="body">Reading your wallet balance and the wrapper&apos;s allowance.</p>;
      actions = closeButton('Cancel');
      break;
    case 'read-failed':
      title = 'Supply Not Ready';
      content = <p className="body">{state.message}</p>;
      actions = closeButton('Close');
      break;
    case 'discarded': {
      title = 'Supply Closed';
      const reason =
        state.reason === 'identity-changed'
          ? 'Your wallet, network or market changed, so this supply was closed.'
          : state.reason === 'session-unusable'
          ? 'Your wallet stopped responding, so this supply was closed.'
          : 'You closed this supply.';
      content = (
        <>
          <p className="body">{reason}</p>
          {state.submittedHashes.length > 0 && (
            <>
              <p className="body">Already sent, and not cancelled:</p>
              <ul className="wrapped-supply-modal__steps">
                {state.submittedHashes.map((hash) => (
                  <li key={hash} className="wrapped-supply-modal__step">
                    <ExplorerLink chainId={state.chainId} hash={hash} />
                  </li>
                ))}
              </ul>
            </>
          )}
          {state.isWalletRequestOpen && (
            <p className="body">A request is still open in your wallet. Approving it there still sends it.</p>
          )}
          {state.isWalletRequestOpen ? (
            <p className="L4 meta text-color--2">
              Nothing more is sent from this review. New supplies from this account wait until your wallet answers the
              request. Look for the request in your wallet app. If it is not there, reload the page and reconnect your
              wallet. You can then stop waiting for it.
            </p>
          ) : (
            <p className="L4 meta text-color--2">
              Nothing more is sent from this review. Start a new review to continue.
            </p>
          )}
        </>
      );
      actions = closeButton('Close');
      break;
    }
    default: {
      const { draft, steps, stepIndex, phase } = state;
      const amount =
        decimals === undefined
          ? `${draft.amount.toString()} base units of ${symbol}`
          : `${formatExactUnits(draft.amount, decimals)} ${symbol}`;
      const isStopped = phase === 'stopped';
      title =
        phase === 'complete'
          ? 'Supply Confirmed'
          : isStopped
          ? 'Supply Stopped'
          : `Supply ${symbol} Through the Wrapper`;

      content = (
        <>
          <p className="body">
            {phase === 'complete'
              ? `Supplied ${amount} to the market through the wrapper. Your wrapped position is updating.`
              : `Supply ${amount} from your wallet to the market through the wrapper.`}
          </p>
          <p className="L4 meta text-color--2">
            Your wallet may show this amount in the token&apos;s base units: {draft.amount.toString()}.
          </p>
          {(phase === 'review' || phase === 'signing') && (
            <DirectDebtWarning directBorrowBalance={directBorrowBalance} symbol={symbol} decimals={decimals} />
          )}
          <ol className="wrapped-supply-modal__steps">
            {draft.steps.map((step, index) => {
              const stepState = steps[index];
              return (
                <li key={step.id} className="wrapped-supply-modal__step">
                  <p className="body body--emphasized">{step.description}</p>
                  <p className="L4 meta text-color--2">
                    {stepStatusText(stepState, index === stepIndex && phase === 'review', isStopped)}
                  </p>
                  {'hash' in stepState && <ExplorerLink chainId={draft.identity.chainId} hash={stepState.hash} />}
                </li>
              );
            })}
          </ol>
          {isStopped && (
            <p className="L4 meta text-color--2">
              This supply stopped, and nothing more is sent from it. Start a new review to try again.
            </p>
          )}
          {phase === 'signing' && (
            <p className="L4 meta text-color--2">
              If you close this dialog, the supply stops after the current step. A request already in your wallet, or a
              transaction already on the network, is not cancelled.
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
              {confirmLabel(draft.steps[stepIndex], amount)}
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
      } else {
        actions = closeButton(phase === 'complete' ? 'Done' : 'Close');
      }
    }
  }

  return (
    <div className="modal modal--active">
      <div className="modal__backdrop" onClick={onClose}></div>
      <div className="modal__content L4 wrapped-supply-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__content__header">
          <div className="modal__content__header__left"></div>
          <h4 className="heading heading--emphasized heading">{title}</h4>
          <div className="modal__content__header__right">
            <button className="wrapped-supply-modal__close" aria-label="Close dialog" onClick={onClose}>
              <CircleClose />
            </button>
          </div>
        </div>
        <div className="modal__content__paragraph modal__content__paragraph--left-align">{content}</div>
        <div className="modal__content__action-row wrapped-supply-modal__actions">{actions}</div>
      </div>
    </div>
  );
};

export default WrappedSupplyModal;

import type { ReactNode } from 'react';

import { WrappedStep } from '@helpers/wrappedActions';
import useDisableScroll from '@hooks/useDisableScroll';
import { WrappedActionState } from '@hooks/useWrappedAction';
import { formatExactUnits, WRAPPED_SUPPLY_STEP_IDS } from '@hooks/useWriteWrappedState';

import {
  DiscardedContent,
  ExplorerLink,
  signingLabel,
  stepStatusText,
  WrappedActionDialog,
} from './WrappedActionDialog';

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

/** What a supply checks after the user confirms a step, before the wallet is asked. */
const SUPPLY_CHECKING_TEXT = 'Checking your balance, allowance and wallet before asking it to sign.';

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
    <div className="wrapped-action-modal__warning" role="alert">
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
    case 'discarded':
      title = 'Supply Closed';
      content = (
        <DiscardedContent
          reason={state.reason}
          chainId={state.chainId}
          submittedHashes={state.submittedHashes}
          isWalletRequestOpen={state.isWalletRequestOpen}
          noun="supply"
        />
      );
      actions = closeButton('Close');
      break;
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
          <ol className="wrapped-action-modal__steps">
            {draft.steps.map((step, index) => {
              const stepState = steps[index];
              return (
                <li key={step.id} className="wrapped-action-modal__step">
                  <p className="body body--emphasized">{step.description}</p>
                  <p className="L4 meta text-color--2">
                    {stepStatusText(
                      stepState,
                      index === stepIndex && phase === 'review',
                      isStopped,
                      SUPPLY_CHECKING_TEXT
                    )}
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

  return <WrappedActionDialog title={title} content={content} actions={actions} onClose={onClose} />;
};

export default WrappedSupplyModal;

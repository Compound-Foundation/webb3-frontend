import type { ReactNode } from 'react';

import { CircleClose } from '@components/Icons';
import { getBlockExplorerUrl } from '@helpers/urls';
import { WrappedBlockReason } from '@helpers/wrappedActions';
import { WrappedStepState } from '@hooks/useWrappedAction';

// The parts the wrapped supply and withdrawal dialogs share: their frame, step text and links.

/** A link to a transaction on the block explorer of its chain. */
export function ExplorerLink({ chainId, hash }: { chainId: number; hash: string }) {
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

/** Why a step stopped before the wallet was asked, as the end of a sentence. */
export function blockedReasonText(reason: WrappedBlockReason, message: string | undefined): string {
  switch (reason) {
    case 'identity-changed':
      return 'your wallet, network or market changed';
    case 'session-unusable':
      return 'your wallet stopped responding';
    case 'transaction-pending':
      return 'another wrapped transaction from this account is still pending';
    case 'supply-paused':
      return 'supplying to this market is paused';
    case 'withdraw-paused':
      return 'withdrawals from this market are paused';
    case 'restriction-unknown':
      return "the market's pause state could not be read";
    case 'deposits-disabled':
      return 'wrapped deposits are closed';
    case 'exits-disabled':
      return 'wrapped withdrawals are closed';
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
 * What a step's state means for the user. Each state reads differently from every other.
 * `checkingText` says what the action checks before the wallet is asked.
 */
export function stepStatusText(step: WrappedStepState, isNext: boolean, isStopped: boolean, checkingText: string) {
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
    case 'provider-failure':
      return `Your wallet reported an error (${step.message}). The request may still go through, so check your wallet before you try again.`;
    case 'blocked':
      return `Stopped before your wallet was asked, so nothing was sent: ${blockedReasonText(
        step.reason,
        step.message
      )}.`;
  }
}

/** The disabled button's label while a step is being signed. */
export function signingLabel(step: WrappedStepState): string {
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
 * What a closed review leaves behind: why it closed, the transactions it already sent, which are
 * not cancelled, and a wallet request still open. `noun` names the action: "supply" or "withdrawal".
 */
export function DiscardedContent({
  reason,
  chainId,
  submittedHashes,
  isWalletRequestOpen,
  noun,
}: {
  reason: 'identity-changed' | 'session-unusable' | 'cleared';
  chainId: number;
  submittedHashes: readonly string[];
  isWalletRequestOpen: boolean;
  noun: string;
}) {
  const why =
    reason === 'identity-changed'
      ? `Your wallet, network or market changed, so this ${noun} was closed.`
      : reason === 'session-unusable'
      ? `Your wallet stopped responding, so this ${noun} was closed.`
      : `You closed this ${noun}.`;
  return (
    <>
      <p className="body">{why}</p>
      {submittedHashes.length > 0 && (
        <>
          <p className="body">Already sent, and not cancelled:</p>
          <ul className="wrapped-action-modal__steps">
            {submittedHashes.map((hash) => (
              <li key={hash} className="wrapped-action-modal__step">
                <ExplorerLink chainId={chainId} hash={hash} />
              </li>
            ))}
          </ul>
        </>
      )}
      {isWalletRequestOpen && (
        <p className="body">A request is still open in your wallet. Approving it there still sends it.</p>
      )}
      <p className="L4 meta text-color--2">Nothing more is sent from this review. Start a new review to continue.</p>
    </>
  );
}

/** The frame of a wrapped action's dialog. The backdrop and the close control both call `onClose`. */
export function WrappedActionDialog({
  title,
  content,
  actions,
  onClose,
}: {
  title: string;
  content: ReactNode;
  actions: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal modal--active">
      <div className="modal__backdrop" onClick={onClose}></div>
      <div className="modal__content L4 wrapped-action-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__content__header">
          <div className="modal__content__header__left"></div>
          <h4 className="heading heading--emphasized heading">{title}</h4>
          <div className="modal__content__header__right">
            <button className="wrapped-action-modal__close" aria-label="Close dialog" onClick={onClose}>
              <CircleClose />
            </button>
          </div>
        </div>
        <div className="modal__content__paragraph modal__content__paragraph--left-align">{content}</div>
        <div className="modal__content__action-row wrapped-action-modal__actions">{actions}</div>
      </div>
    </div>
  );
}

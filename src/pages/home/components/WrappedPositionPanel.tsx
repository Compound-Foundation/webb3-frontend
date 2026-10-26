import { ReactNode, useEffect, useState } from 'react';

import { assetIconForAssetSymbol } from '@helpers/assets';
import { LendingRoute, WriteBlockReason } from '@helpers/lendingRoute';
import { formatRateFactor, formatValue, formatValueInDollars } from '@helpers/numbers';
import { WrappedBlockReason } from '@helpers/wrappedActions';
import { getWithdrawableCash, getWrappedPositionValueInDollars, WithdrawableCash } from '@helpers/wrappedPositions';
import {
  getWithdrawalLimits,
  planWrappedWithdrawal,
  WithdrawalPlan,
  WithdrawalRequest,
  WithdrawalSnapshot,
} from '@helpers/wrappedWithdrawals';
import { WalletSessionHealth } from '@hooks/useWrappedAction';
import { WrappedPositionState } from '@hooks/useWrappedPosition';
import { formatExactUnits, parseExactUnits } from '@hooks/useWriteWrappedState';

import { stringFromBigInt } from './ActionInputView';

export type WrappedRoute = Extract<LendingRoute, { kind: 'wrapped' }>;

type WrappedPositionPanelProps = {
  route: WrappedRoute;
  position: WrappedPositionState;
  /** The market's base asset, from the Comet state of the same market. */
  baseAsset: { symbol: string; baseAssetPriceInDollars: bigint; balanceOfComet: bigint };
  /** The market's base supply rate. No reward rate is verified for wrapped positions, so none is passed. */
  earnAPR: bigint;
  /** The wallet session's check. An unusable session stops every write until reload or reconnect. */
  session?: WalletSessionHealth;
  /** The wallet said it still holds an interrupted request, so the notice says how to answer it there. */
  isRecoveredRequestPendingInWallet?: boolean;
  /** An interrupted wallet request holds back new wrapped actions, and the user can stop waiting. */
  canDismissRecovered?: boolean;
  onDismissRecovered?: () => void;
  /**
   * A wallet request that has had no answer holds back new wrapped actions. The user can stop
   * waiting for the request only after a reload.
   */
  hasUnansweredWalletRequest?: boolean;
  /**
   * The wallet's answer when it refused this session's last wrapped request before it handled it.
   * Nothing was sent, so the notice tells the user to reconnect the wallet before a new review.
   */
  walletRefusalMessage?: string;
  /** The wrapped supply entry. Without it, the deposit control stays disabled. */
  supply?: {
    /** Why a wrapped supply cannot start now, as the wrapper action lifecycle reports it. */
    blockedReason: WrappedBlockReason | undefined;
    /** Starts a review of `amount` raw base-token units. Returns why it was refused, if it was. */
    onReview: (amount: bigint) => WrappedBlockReason | undefined;
  };
  /** The wrapped withdrawal entry. Without it, the withdraw control stays disabled. */
  withdraw?: {
    /** Why a wrapped withdrawal cannot start now, as the wrapper action lifecycle reports it. */
    blockedReason: WrappedBlockReason | undefined;
    /**
     * Starts a review of `request`. `shownCash` is the full exit's cash the form showed. Returns why
     * the review was refused, if it was.
     */
    onReview: (request: WithdrawalRequest, shownCash?: bigint) => WrappedBlockReason | undefined;
  };
  onRetry: () => void;
};

/** An allowance this large is an unlimited approval, not an amount worth printing. */
const UNLIMITED_ALLOWANCE = 2n ** 128n;

function unavailableMessage(reason: WriteBlockReason): { message: string; canReload: boolean } {
  switch (reason) {
    case 'validation-failed':
      return {
        message: 'The wrapper for this market could not be checked. Reload the page to try again.',
        canReload: true,
      };
    case 'not-canonical':
    case 'asset-mismatch':
    case 'metadata-mismatch':
      return {
        message: 'The wrapper for this market did not pass its on-chain check, so wrapped lending is turned off.',
        canReload: false,
      };
    case 'missing-mapping':
    case 'invalid-mapping':
      return {
        message: 'Wrapped lending is not set up correctly for this market, so it is turned off.',
        canReload: false,
      };
    default:
      return { message: 'Your wrapped position is not available right now.', canReload: false };
  }
}

function writeBlockMessage(reason: WrappedBlockReason, action: 'deposits' | 'withdrawals'): string {
  switch (reason) {
    case 'deposits-disabled':
    case 'exits-disabled':
      return `Wrapped ${action} are not open yet.`;
    case 'wrong-chain':
      return `Switch your wallet to this market's network to use wrapped ${action}.`;
    case 'reconnecting':
    case 'no-signer':
    case 'validation-pending':
      return 'Waiting for your wallet and the wrapper check.';
    case 'transaction-pending':
      return "Waiting for this account's earlier wrapped transactions to be checked and to settle.";
    case 'action-in-progress':
      return 'A wrapped transaction is already in review.';
    case 'session-unusable':
      return 'Reload the page and reconnect your wallet first.';
    default:
      return `Wrapped ${action} are unavailable for this session.`;
  }
}

/**
 * The amount form of a wrapped supply, modelled on the standard supply's. It keeps what the user
 * types: an amount it cannot read exactly, such as one with a comma or a seventh decimal, is
 * refused with a message rather than changed.
 */
const WrappedSupplyForm = ({
  symbol,
  decimals,
  walletBalance,
  onCancel,
  onReview,
}: {
  symbol: string;
  decimals: number;
  walletBalance: bigint;
  onCancel: () => void;
  onReview: (amount: bigint) => WrappedBlockReason | undefined;
}) => {
  const [input, setInput] = useState('');
  const [refusal, setRefusal] = useState<WrappedBlockReason | undefined>(undefined);
  const typed = input.trim();
  const amount = typed === '' ? undefined : parseExactUnits(typed, decimals);
  const isMalformed = typed !== '' && amount === undefined;
  const isAboveBalance = amount !== undefined && amount > walletBalance;
  const reviewedAmount = amount !== undefined && amount > 0n && !isAboveBalance ? amount : undefined;
  const inputError = isMalformed
    ? `Use digits and one point, with up to ${decimals} decimals`
    : amount === 0n
    ? 'Enter an amount greater than 0'
    : isAboveBalance
    ? 'Exceeds your wallet balance'
    : undefined;

  const change = (value: string) => {
    setInput(value);
    setRefusal(undefined);
  };

  return (
    <div
      className={`action-input-view action-input-view--${
        inputError === undefined ? 'supply' : 'error'
      } L2 wrapped-position-panel__form`}
    >
      <div className="action-input-view__title">
        <label className="label">Supply {symbol}</label>
        {inputError !== undefined && <label className="label text-color--2">{inputError}</label>}
      </div>
      <div className="action-input-view__input-row">
        <input
          className="action-input-view__input"
          placeholder="0"
          aria-label={`Amount of ${symbol} to supply`}
          aria-invalid={inputError !== undefined}
          value={input}
          onChange={(event) => change(event.target.value)}
          autoComplete="off"
        />
        <button className="button button--small" onClick={() => change(stringFromBigInt(walletBalance, decimals))}>
          Max
        </button>
      </div>
      <div className="action-input-view__detail-row">
        <div className={`asset asset--${assetIconForAssetSymbol(symbol)}`}></div>
        <p className="L4 meta">{formatValue(decimals, walletBalance)} Available</p>
      </div>
      <div className="action-input-view__hint-row">
        <p className="L4 meta text-color--2">
          {refusal === undefined
            ? 'You review each transaction before your wallet signs it. An approval, if one is needed, is for exactly this amount.'
            : writeBlockMessage(refusal, 'deposits')}
        </p>
      </div>
      <div className="action-input-view__buttons">
        <button className="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="button"
          disabled={reviewedAmount === undefined}
          onClick={() => {
            if (reviewedAmount !== undefined) setRefusal(onReview(reviewedAmount));
          }}
        >
          Review
        </button>
      </div>
    </div>
  );
};

/**
 * What the withdrawal form says about an amount of zero, or about a choice the position or the
 * market cannot pay now. It gives the most they can pay, and the full exit when that can pay.
 */
function revisionText(
  plan: Extract<WithdrawalPlan, { status: 'needs-revision' }>,
  request: WithdrawalRequest,
  snapshot: WithdrawalSnapshot,
  formatAmount: (value: bigint) => string
): string {
  const { limits } = plan;
  switch (plan.reason) {
    case 'no-amount':
      return 'Enter an amount greater than 0';
    case 'no-shares':
      return 'You hold no wrapped shares to withdraw.';
    case 'paused':
      return 'Withdrawals from this market are paused.';
    case 'dust':
      return "Your position is worth no more than the wrapper's rounding buffer, so it cannot be withdrawn.";
    case 'exceeds-position':
      return `More than you can withdraw now. Enter at most ${formatAmount(limits.maxPartialCash)}${
        limits.canExitFully ? ', or choose Everything' : ''
      }.`;
    case 'exceeds-liquidity':
      return request.kind === 'full'
        ? `The market holds only ${formatAmount(
            snapshot.cometCash
          )} now, less than a full exit pays. Withdraw an amount of at most ${formatAmount(
            limits.maxPartialCash
          )} instead.`
        : `The market holds only ${formatAmount(snapshot.cometCash)} now. Enter at most ${formatAmount(
            limits.maxPartialCash
          )}.`;
  }
}

/** The plan for `request`, or undefined when the quote fails its own check, which nothing reviews. */
function planOrUndefined(request: WithdrawalRequest, snapshot: WithdrawalSnapshot): WithdrawalPlan | undefined {
  try {
    return planWrappedWithdrawal(request, snapshot);
  } catch {
    return undefined;
  }
}

/**
 * The form of a wrapped withdrawal. The user chooses an amount of cash, or Everything for the full
 * exit, which is never chosen for them. The form quotes the choice from the panel's figures. It
 * refuses an amount the position or the market cannot pay now, with the most they can pay, and
 * keeps what the user typed. The review reads everything again before anything is signed.
 */
const WrappedWithdrawForm = ({
  symbol,
  snapshot,
  onCancel,
  onReview,
}: {
  symbol: string;
  snapshot: WithdrawalSnapshot;
  onCancel: () => void;
  onReview: (request: WithdrawalRequest, shownCash?: bigint) => WrappedBlockReason | undefined;
}) => {
  const [kind, setKind] = useState<WithdrawalRequest['kind']>('partial');
  const [input, setInput] = useState('');
  const [refusal, setRefusal] = useState<WrappedBlockReason | undefined>(undefined);
  const { baseDecimals } = snapshot;
  const formatAmount = (value: bigint) => `${formatExactUnits(value, baseDecimals)} ${symbol}`;
  const limits = getWithdrawalLimits(snapshot);

  const typed = input.trim();
  const amount = typed === '' ? undefined : parseExactUnits(typed, baseDecimals);
  const isMalformed = kind === 'partial' && typed !== '' && amount === undefined;
  let request: WithdrawalRequest | undefined;
  if (kind === 'full') request = { kind: 'full' };
  else if (amount !== undefined) request = { kind: 'partial', cash: amount };
  const plan = request === undefined ? undefined : planOrUndefined(request, snapshot);

  let problem: string | undefined;
  if (isMalformed) {
    problem = `Use digits and one point, with up to ${baseDecimals} decimals`;
  } else if (request !== undefined && plan === undefined) {
    problem = 'This amount could not be quoted exactly. Enter another amount.';
  } else if (request !== undefined && plan?.status === 'needs-revision') {
    problem = revisionText(plan, request, snapshot, formatAmount);
  }

  let hint: string;
  if (problem !== undefined) {
    hint = problem;
  } else if (refusal !== undefined) {
    hint = writeBlockMessage(refusal, 'withdrawals');
  } else if (plan?.status === 'ready' && plan.quote.leavesDust) {
    hint = `This leaves wrapped ${symbol} worth no more than the wrapper's rounding buffer, which cannot be withdrawn on its own. To withdraw it all, choose Everything.`;
  } else {
    hint =
      "You review the cash before your wallet signs. The wrapper holds back a few base units for rounding, and pays from the market's cash.";
  }

  const choose = (chosen: WithdrawalRequest['kind']) => {
    setKind(chosen);
    setRefusal(undefined);
  };
  const change = (value: string) => {
    setInput(value);
    setRefusal(undefined);
  };

  return (
    <div
      className={`action-input-view action-input-view--${
        problem === undefined ? 'supply' : 'error'
      } L2 wrapped-position-panel__form`}
    >
      <div className="action-input-view__title">
        <label className="label">Withdraw {symbol}</label>
      </div>
      <fieldset className="wrapped-position-panel__choice">
        <legend className="L4 meta text-color--2">How much to withdraw</legend>
        <label className="L3">
          <input
            type="radio"
            name="wrapped-withdraw-kind"
            checked={kind === 'partial'}
            onChange={() => choose('partial')}
          />{' '}
          An amount
        </label>
        <label className="L3">
          <input type="radio" name="wrapped-withdraw-kind" checked={kind === 'full'} onChange={() => choose('full')} />{' '}
          Everything (full exit)
        </label>
      </fieldset>
      {kind === 'partial' && (
        <div className="action-input-view__input-row">
          <input
            className="action-input-view__input"
            placeholder="0"
            aria-label={`Amount of ${symbol} to withdraw`}
            aria-invalid={problem !== undefined}
            value={input}
            onChange={(event) => change(event.target.value)}
            autoComplete="off"
          />
        </div>
      )}
      <div className="action-input-view__detail-row">
        <div className={`asset asset--${assetIconForAssetSymbol(symbol)}`}></div>
        <p className="L4 meta" data-testid="wrapped-withdraw-limit">
          {kind === 'partial'
            ? `Up to ${formatAmount(limits.maxPartialCash)} now`
            : `About ${formatAmount(limits.fullExitCash)} for all your shares`}
        </p>
      </div>
      <div className="action-input-view__hint-row">
        <p className="L4 meta text-color--2" data-testid="wrapped-withdraw-hint">
          {hint}
        </p>
      </div>
      <div className="action-input-view__buttons">
        <button className="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="button"
          disabled={request === undefined || plan?.status !== 'ready'}
          onClick={() => {
            if (request === undefined || plan?.status !== 'ready') return;
            setRefusal(onReview(request, request.kind === 'full' ? plan.quote.cash : undefined));
          }}
        >
          Review
        </button>
      </div>
    </div>
  );
};

function withdrawableNote({ limit }: WithdrawableCash): string {
  switch (limit) {
    case 'paused':
      return 'Withdrawals from this market are paused.';
    case 'liquidity':
      return 'Limited by the cash the market holds. The rest of the position stays in the wrapper.';
    default:
      return "The value less the wrapper's rounding buffer, if the market's cash and state are unchanged.";
  }
}

/**
 * The connected account's position in the selected market's wrapper. It is kept apart from
 * the direct Comet position: wrapper shares are not collateral and add no borrowing capacity.
 */
const WrappedPositionPanel = ({
  route,
  position,
  baseAsset,
  earnAPR,
  session = { status: 'not-applicable' },
  isRecoveredRequestPendingInWallet = false,
  canDismissRecovered = false,
  onDismissRecovered = () => undefined,
  hasUnansweredWalletRequest = false,
  walletRefusalMessage,
  supply,
  withdraw,
  onRetry,
}: WrappedPositionPanelProps) => {
  const { symbol } = baseAsset;
  // The open form belongs to the route key it was opened for. A change of session or market closes
  // it, and it stays closed if the key returns. One form is open at a time.
  const [openForm, setOpenForm] = useState<{ kind: 'supply' | 'withdraw'; routeKey: string } | undefined>(undefined);
  useEffect(() => {
    setOpenForm((current) => (current?.routeKey === route.validationKey ? current : undefined));
  }, [route.validationKey]);
  const isFormOpen = (kind: 'supply' | 'withdraw') =>
    openForm !== undefined && openForm.kind === kind && openForm.routeKey === route.validationKey;
  const toggleForm = (kind: 'supply' | 'withdraw') =>
    setOpenForm(
      isFormOpen(kind) || route.validationKey === undefined ? undefined : { kind, routeKey: route.validationKey }
    );
  let content: ReactNode;

  switch (position.status) {
    case 'not-applicable':
      return null;
    case 'loading':
      content = <p className="L3 meta text-color--2">Loading your wrapped position…</p>;
      break;
    case 'error':
      content = (
        <div className="wrapped-position-panel__notice">
          <p className="L3 meta text-color--2">{position.message}</p>
          <button className="button button--small" onClick={onRetry}>
            Retry
          </button>
        </div>
      );
      break;
    case 'unavailable': {
      const { message, canReload } = unavailableMessage(position.reason);
      content = (
        <div className="wrapped-position-panel__notice">
          <p className="L3 meta text-color--2">{message}</p>
          {canReload && (
            <button className="button button--small" onClick={() => window.location.reload()}>
              Reload
            </button>
          )}
        </div>
      );
      break;
    }
    case 'loaded': {
      const { shares, grossAssets, baseDecimals, baseWalletBalance, wrapperAllowance, fullExitCash, isWithdrawPaused } =
        position.position;
      const valueInDollars = getWrappedPositionValueInDollars(grossAssets, baseAsset.baseAssetPriceInDollars, symbol);
      const withdrawable = getWithdrawableCash(fullExitCash, isWithdrawPaused, baseAsset.balanceOfComet);
      const isDust = shares > 0n && fullExitCash === 0n && !isWithdrawPaused;
      const payout = isDust ? 'Too small to withdraw' : `${formatValue(baseDecimals, withdrawable.amount)} ${symbol}`;
      const allowance =
        wrapperAllowance >= UNLIMITED_ALLOWANCE
          ? 'Unlimited'
          : `${formatValue(baseDecimals, wrapperAllowance)} ${symbol}`;

      content = (
        <div className="wrapped-position-panel__figures">
          <div className="wrapped-position-panel__figure">
            <label className="L3 label text-color--2">Position value</label>
            <p className="body body--emphasized" data-testid="wrapped-position-value">
              {formatValue(baseDecimals, grossAssets)} {symbol}
            </p>
            <p className="L4 meta text-color--2" data-testid="wrapped-position-value-usd">
              {formatValueInDollars(baseDecimals, valueInDollars)}
            </p>
          </div>
          <div className="wrapped-position-panel__figure">
            <label className="L3 label text-color--2">Withdrawable now (estimated)</label>
            <p className="body body--emphasized" data-testid="wrapped-full-exit-payout">
              {payout}
            </p>
            <p className="L4 meta text-color--2">{withdrawableNote(withdrawable)}</p>
          </div>
          <div className="wrapped-position-panel__figure">
            <label className="L3 label text-color--2">Supply APR</label>
            <p className="body body--emphasized" data-testid="wrapped-supply-apr">
              {formatRateFactor(earnAPR)}
            </p>
            <p className="L4 meta text-color--2">The market&apos;s lending rate. Reward rates do not apply.</p>
          </div>
          <div className="wrapped-position-panel__figure">
            <label className="L3 label text-color--2">Wallet balance</label>
            <p className="body" data-testid="wrapped-wallet-balance">
              {formatValue(baseDecimals, baseWalletBalance)} {symbol}
            </p>
            <label className="L3 label text-color--2">Approved for the wrapper</label>
            <p className="body" data-testid="wrapped-allowance">
              {allowance}
            </p>
          </div>
        </div>
      );
      break;
    }
  }

  // A wrapped supply can start when the route allows deposits, the lifecycle allows a new review,
  // and the position, with the wallet balance it reads, is loaded.
  const supplyBlock = !route.deposit.isEligible ? route.deposit.reason : supply?.blockedReason;
  let supplyForm:
    | { decimals: number; walletBalance: bigint; onReview: (amount: bigint) => WrappedBlockReason | undefined }
    | undefined;
  let supplyMessage: string;
  if (supplyBlock !== undefined) {
    supplyMessage = writeBlockMessage(supplyBlock, 'deposits');
  } else if (supply === undefined) {
    supplyMessage = 'Wrapped deposits are not available in this version of the app.';
  } else if (session.status === 'unusable') {
    supplyMessage = writeBlockMessage('session-unusable', 'deposits');
  } else if (position.status !== 'loaded') {
    supplyMessage = 'Waiting for your wrapped position to load.';
  } else {
    supplyMessage = `Lends ${symbol} from your wallet to the market through the wrapper.`;
    supplyForm = {
      decimals: position.position.baseDecimals,
      walletBalance: position.position.baseWalletBalance,
      onReview: supply.onReview,
    };
  }

  // A wrapped withdrawal can start when the route allows exits and the lifecycle allows a new
  // review. The position must also be loaded, since the form quotes from it, and have something to pay.
  const withdrawBlock = !route.exit.isEligible ? route.exit.reason : withdraw?.blockedReason;
  let withdrawForm:
    | {
        snapshot: WithdrawalSnapshot;
        onReview: (request: WithdrawalRequest, shownCash?: bigint) => WrappedBlockReason | undefined;
      }
    | undefined;
  let withdrawMessage: string;
  if (withdrawBlock !== undefined) {
    withdrawMessage = writeBlockMessage(withdrawBlock, 'withdrawals');
  } else if (withdraw === undefined) {
    withdrawMessage = 'Wrapped withdrawals are not available in this version of the app.';
  } else if (session.status === 'unusable') {
    withdrawMessage = writeBlockMessage('session-unusable', 'withdrawals');
  } else if (position.status !== 'loaded') {
    withdrawMessage = 'Waiting for your wrapped position to load.';
  } else if (position.position.shares <= 0n) {
    withdrawMessage = `You hold no wrapped ${symbol} to withdraw.`;
  } else if (position.position.isWithdrawPaused) {
    withdrawMessage = 'Withdrawals from this market are paused.';
  } else if (position.position.fullExitCash === 0n) {
    withdrawMessage =
      "Your wrapped position is too small to withdraw: it is worth no more than the wrapper's rounding buffer.";
  } else {
    withdrawMessage = `Pays ${symbol} from the wrapper to your wallet. Your direct Comet position does not change.`;
    const { shares, snapshot, baseDecimals, isWithdrawPaused } = position.position;
    withdrawForm = {
      snapshot: { ...snapshot, shares, baseDecimals, isWithdrawPaused, cometCash: baseAsset.balanceOfComet },
      onReview: withdraw.onReview,
    };
  }

  return (
    <div className="panel wrapped-position-panel L2">
      <div className="panel__header-row">
        <label className="L2 label text-color--2">Wrapped {symbol}</label>
      </div>
      <div className="panel__description">
        <p className="L4 meta text-color--2">
          With this wallet, {symbol} you supply goes through the market&apos;s wrapper. Wrapped {symbol} is not
          collateral and does not add to your borrowing capacity.
        </p>
      </div>
      {session.status === 'unusable' && (
        <div className="wrapped-position-panel__notice" role="alert">
          <p className="L3 meta text-color--2">{session.instruction}</p>
          <button className="button button--small" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      {hasUnansweredWalletRequest && (
        <div className="wrapped-position-panel__notice">
          <p className="L3 meta text-color--2">
            Your wallet has not answered a request for an earlier wrapped transaction from this account. New wrapped
            deposits and withdrawals wait for that answer. Look for the request in your wallet app. If it is not there,
            reload the page and reconnect your wallet. You can then stop waiting for it.
          </p>
        </div>
      )}
      {canDismissRecovered && (
        <div className="wrapped-position-panel__notice">
          {isRecoveredRequestPendingInWallet ? (
            <p className="L3 meta text-color--2">
              Your wallet reported that it still has a request open for an earlier wrapped transaction from this
              account. Approve or reject it in the Anchorage app on your phone. Approving it still sends the
              transaction, but this page cannot follow that transaction. New wrapped deposits and withdrawals wait for
              it. Once your wallet shows the request done, reload this page to see the result here. Stop waiting only
              after checking your wallet: the request can still go through. A new review then starts from the new
              balances.
            </p>
          ) : (
            <p className="L3 meta text-color--2">
              A wallet request for an earlier wrapped transaction from this account was left open, and this page cannot
              follow it. New wrapped deposits and withdrawals wait for it. Stop waiting only after checking your wallet:
              the request can still go through.
            </p>
          )}
          <button className="button button--small" onClick={onDismissRecovered}>
            Stop waiting
          </button>
        </div>
      )}
      {walletRefusalMessage !== undefined && (
        <div className="wrapped-position-panel__notice">
          <p className="L3 meta text-color--2">
            Your wallet refused the last wrapped request from this account before handling it ({walletRefusalMessage}).
            Nothing was sent. Disconnect and reconnect your wallet on this page, then start a new review.
          </p>
        </div>
      )}
      {content}
      <div className="wrapped-position-panel__actions">
        <div className="wrapped-position-panel__action">
          <button
            className="button button--supply"
            disabled={supplyForm === undefined}
            onClick={() => toggleForm('supply')}
          >
            Supply {symbol} through the wrapper
          </button>
          <p className="L4 meta text-color--2">{supplyMessage}</p>
        </div>
        <div className="wrapped-position-panel__action">
          <button
            className="button button--supply"
            disabled={withdrawForm === undefined}
            onClick={() => toggleForm('withdraw')}
          >
            Withdraw {symbol} from the wrapper
          </button>
          <p className="L4 meta text-color--2" data-testid="wrapped-withdraw-message">
            {withdrawMessage}
          </p>
        </div>
      </div>
      {isFormOpen('supply') && supplyForm !== undefined && (
        <WrappedSupplyForm
          symbol={symbol}
          decimals={supplyForm.decimals}
          walletBalance={supplyForm.walletBalance}
          onCancel={() => setOpenForm(undefined)}
          onReview={(amount) => {
            const refusal = supplyForm.onReview(amount);
            // Once the review starts, its dialog takes over.
            if (refusal === undefined) setOpenForm(undefined);
            return refusal;
          }}
        />
      )}
      {isFormOpen('withdraw') && withdrawForm !== undefined && (
        <WrappedWithdrawForm
          symbol={symbol}
          snapshot={withdrawForm.snapshot}
          onCancel={() => setOpenForm(undefined)}
          onReview={(request, shownCash) => {
            const refusal = withdrawForm.onReview(request, shownCash);
            // Once the review starts, its dialog takes over.
            if (refusal === undefined) setOpenForm(undefined);
            return refusal;
          }}
        />
      )}
    </div>
  );
};

export default WrappedPositionPanel;

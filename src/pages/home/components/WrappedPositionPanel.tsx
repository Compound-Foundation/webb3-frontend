import { ReactNode } from 'react';

import { Eligibility, LendingRoute, WriteBlockReason } from '@helpers/lendingRoute';
import { formatRateFactor, formatValue, formatValueInDollars } from '@helpers/numbers';
import { getWithdrawableCash, getWrappedPositionValueInDollars, WithdrawableCash } from '@helpers/wrappedPositions';
import { WrappedPositionState } from '@hooks/useWrappedPosition';

export type WrappedRoute = Extract<LendingRoute, { kind: 'wrapped' }>;

type WrappedPositionPanelProps = {
  route: WrappedRoute;
  position: WrappedPositionState;
  /** The market's base asset, from the Comet state of the same market. */
  baseAsset: { symbol: string; baseAssetPriceInDollars: bigint; balanceOfComet: bigint };
  /** The market's base supply rate. No reward rate is verified for wrapped positions, so none is passed. */
  earnAPR: bigint;
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

function writeBlockMessage(eligibility: Eligibility, action: 'deposits' | 'withdrawals'): string {
  if (eligibility.isEligible) return `Wrapped ${action} are not available in this version of the app.`;
  switch (eligibility.reason) {
    case 'deposits-disabled':
    case 'exits-disabled':
      return `Wrapped ${action} are not open yet.`;
    case 'wrong-chain':
      return `Switch your wallet to this market's network to use wrapped ${action}.`;
    case 'reconnecting':
    case 'no-signer':
    case 'validation-pending':
      return 'Waiting for your wallet and the wrapper check.';
    default:
      return `Wrapped ${action} are unavailable for this session.`;
  }
}

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
const WrappedPositionPanel = ({ route, position, baseAsset, earnAPR, onRetry }: WrappedPositionPanelProps) => {
  const { symbol } = baseAsset;
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
      {content}
      <div className="wrapped-position-panel__actions">
        <div className="wrapped-position-panel__action">
          <button className="button button--supply" disabled>
            Supply {symbol} through the wrapper
          </button>
          <p className="L4 meta text-color--2">{writeBlockMessage(route.deposit, 'deposits')}</p>
        </div>
        <div className="wrapped-position-panel__action">
          <button className="button button--supply" disabled>
            Withdraw {symbol} from the wrapper
          </button>
          <p className="L4 meta text-color--2">{writeBlockMessage(route.exit, 'withdrawals')}</p>
        </div>
      </div>
    </div>
  );
};

export default WrappedPositionPanel;

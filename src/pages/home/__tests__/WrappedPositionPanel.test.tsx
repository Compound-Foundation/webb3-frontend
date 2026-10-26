import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { WRAPPED_MARKET_REGISTRY } from '@constants/wrappedMarkets';
import { Eligibility, LendingRoute } from '@helpers/lendingRoute';
import { WrappedPosition } from '@helpers/wrappedPositions';
import { WrappedPositionState } from '@hooks/useWrappedPosition';

import WrappedPositionPanel, { WrappedRoute } from '../components/WrappedPositionPanel';

const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const BASE_ASSET = { symbol: 'USDC', baseAssetPriceInDollars: 100_000_000n, balanceOfComet: 10n ** 12n };

function wrappedRoute(overrides: Partial<Extract<LendingRoute, { kind: 'wrapped' }>> = {}): WrappedRoute {
  const lookup = WRAPPED_MARKET_REGISTRY.lookup(1, USDC_COMET);
  if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
  const eligible: Eligibility = { isEligible: true };
  return {
    kind: 'wrapped',
    chainId: 1,
    cometAddress: USDC_COMET,
    lookup,
    market: lookup.market,
    validationKey: 'key',
    reads: eligible,
    deposit: { isEligible: false, reason: 'deposits-disabled' },
    exit: { isEligible: false, reason: 'exits-disabled' },
    ...overrides,
  };
}

const POSITION: WrappedPosition = {
  shares: 250n * 10n ** 18n,
  shareDecimals: 18,
  grossAssets: 250_125_000n,
  baseDecimals: 6,
  baseWalletBalance: 42_500_000n,
  wrapperAllowance: 5_000_000n,
  redeemBuffer: 3n,
  fullExitCash: 250_124_997n,
  isWithdrawPaused: false,
  snapshot: { totalSupply: 0n, totalAssets: 0n, baseSupplyIndex: 0n },
};

function renderPanel(
  position: WrappedPositionState,
  route = wrappedRoute(),
  onRetry = jest.fn(),
  baseAsset = BASE_ASSET
) {
  render(
    <WrappedPositionPanel
      route={route}
      position={position}
      baseAsset={baseAsset}
      earnAPR={45_000_000_000_000_000n}
      onRetry={onRetry}
    />
  );
  return onRetry;
}

describe('WrappedPositionPanel', () => {
  it('shows the position value and the cash withdrawable now as separate figures', () => {
    renderPanel({ status: 'loaded', position: POSITION });

    expect(screen.getByTestId('wrapped-position-value')).toHaveTextContent('250.1250 USDC');
    expect(screen.getByTestId('wrapped-position-value-usd')).toHaveTextContent('$250.13');
    expect(screen.getByText('Withdrawable now (estimated)')).toBeInTheDocument();
    expect(screen.getByTestId('wrapped-full-exit-payout')).toHaveTextContent('250.1250 USDC');
  });

  it('caps the withdrawable cash at what the market holds', () => {
    renderPanel({ status: 'loaded', position: POSITION }, wrappedRoute(), jest.fn(), {
      ...BASE_ASSET,
      balanceOfComet: 50_000_000n,
    });

    expect(screen.getByTestId('wrapped-full-exit-payout')).toHaveTextContent('50.0000 USDC');
    expect(screen.getByText(/limited by the cash the market holds/i)).toBeInTheDocument();
  });

  it('shows nothing withdrawable while Comet withdrawals are paused', () => {
    renderPanel({ status: 'loaded', position: { ...POSITION, isWithdrawPaused: true } });

    expect(screen.getByTestId('wrapped-full-exit-payout')).toHaveTextContent('0.0000 USDC');
    expect(screen.getByText(/withdrawals from this market are paused/i)).toBeInTheDocument();
  });

  it('says a position worth no more than the buffer cannot be withdrawn', () => {
    renderPanel({
      status: 'loaded',
      position: { ...POSITION, shares: 10n ** 12n, grossAssets: 3n, fullExitCash: 0n },
    });

    expect(screen.getByTestId('wrapped-full-exit-payout')).toHaveTextContent(/too small to withdraw/i);
  });

  it('shows the wallet balance and the allowance given to the wrapper', () => {
    renderPanel({ status: 'loaded', position: POSITION });

    expect(screen.getByTestId('wrapped-wallet-balance')).toHaveTextContent('42.5000 USDC');
    expect(screen.getByTestId('wrapped-allowance')).toHaveTextContent('5.0000 USDC');
  });

  it('shows the base lending APR only, with no reward rate or claim control', () => {
    renderPanel({ status: 'loaded', position: POSITION });

    expect(screen.getByTestId('wrapped-supply-apr')).toHaveTextContent('4.50%');
    expect(screen.queryByText(/boost/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/COMP/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /claim/i })).not.toBeInTheDocument();
  });

  it('keeps the deposit and withdraw controls disabled and says why', () => {
    renderPanel({ status: 'loaded', position: POSITION });

    expect(screen.getByRole('button', { name: 'Supply USDC through the wrapper' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Withdraw USDC from the wrapper' })).toBeDisabled();
    expect(screen.getByText('Wrapped deposits are not open yet.')).toBeInTheDocument();
    expect(screen.getByText('Wrapped withdrawals are not open yet.')).toBeInTheDocument();
  });

  it('keeps the controls disabled even when the route allows them', () => {
    renderPanel(
      { status: 'loaded', position: POSITION },
      wrappedRoute({ deposit: { isEligible: true }, exit: { isEligible: true } })
    );

    expect(screen.getByRole('button', { name: 'Supply USDC through the wrapper' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Withdraw USDC from the wrapper' })).toBeDisabled();
  });

  it('shows a failed read with a retry', () => {
    const onRetry = renderPanel({ status: 'error', message: 'It could not be loaded.' });

    expect(screen.getByText('It could not be loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('wrapped-position-value')).not.toBeInTheDocument();
  });

  it('asks for a reload when the wrapper check could not run', () => {
    renderPanel({ status: 'unavailable', reason: 'validation-failed' });

    expect(screen.getByText(/could not be checked/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('explains that wrapped lending is off when the wrapper fails its check', () => {
    renderPanel({ status: 'unavailable', reason: 'asset-mismatch' });

    expect(screen.getByText(/did not pass its on-chain check/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
  });

  it('shows no figures while loading', () => {
    renderPanel({ status: 'loading' });

    expect(screen.getByText(/loading your wrapped position/i)).toBeInTheDocument();
    expect(screen.queryByTestId('wrapped-position-value')).not.toBeInTheDocument();
  });

  it('tells the user to reload and reconnect when the wallet session is unusable', () => {
    const instruction = 'Your wallet extension stopped responding. Reload the page and reconnect your wallet.';
    render(
      <WrappedPositionPanel
        route={wrappedRoute({ deposit: { isEligible: true }, exit: { isEligible: true } })}
        position={{ status: 'loaded', position: POSITION }}
        baseAsset={BASE_ASSET}
        earnAPR={0n}
        session={{ status: 'unusable', reason: 'provider-broken', instruction }}
        onRetry={jest.fn()}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(instruction);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /supply usdc through the wrapper/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /withdraw usdc from the wrapper/i })).toBeDisabled();
  });

  it('shows no session notice while the wallet session is usable', () => {
    renderPanel({ status: 'loaded', position: POSITION });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).not.toBeInTheDocument();
    expect(screen.queryByText(/refused/)).not.toBeInTheDocument();
  });

  it('tells the user to reconnect the wallet after it refused a request before handling it', () => {
    render(
      <WrappedPositionPanel
        route={wrappedRoute()}
        position={{ status: 'loaded', position: POSITION }}
        baseAsset={BASE_ASSET}
        earnAPR={0n}
        walletRefusalMessage="Unauthorized (4100)"
        onRetry={jest.fn()}
      />
    );

    expect(
      screen.getByText(
        'Your wallet refused the last wrapped request from this account before handling it (Unauthorized (4100)). ' +
          'Nothing was sent. Disconnect and reconnect your wallet on this page, then start a new review.'
      )
    ).toBeInTheDocument();
    // Nothing waits for the refused request, so there is nothing to stop waiting for.
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).not.toBeInTheDocument();
    expect(screen.queryByText(/was left open/)).not.toBeInTheDocument();
  });

  it('lets the user stop waiting for an earlier wrapped transaction', () => {
    const onDismissRecovered = jest.fn();
    render(
      <WrappedPositionPanel
        route={wrappedRoute()}
        position={{ status: 'loaded', position: POSITION }}
        baseAsset={BASE_ASSET}
        earnAPR={0n}
        canDismissRecovered
        onDismissRecovered={onDismissRecovered}
        onRetry={jest.fn()}
      />
    );

    expect(screen.getByText(/was left open, and this page cannot follow it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(onDismissRecovered).toHaveBeenCalledTimes(1);
  });

  it('tells the user to answer on the phone a request the wallet still holds, and lets them stop waiting', () => {
    const onDismissRecovered = jest.fn();
    render(
      <WrappedPositionPanel
        route={wrappedRoute()}
        position={{ status: 'loaded', position: POSITION }}
        baseAsset={BASE_ASSET}
        earnAPR={0n}
        canDismissRecovered
        isRecoveredRequestPendingInWallet
        onDismissRecovered={onDismissRecovered}
        onRetry={jest.fn()}
      />
    );

    expect(
      screen.getByText(
        'Your wallet reported that it still has a request open for an earlier wrapped transaction from this account. ' +
          'Approve or reject it in the Anchorage app on your phone. ' +
          'Approving it still sends the transaction, but this page cannot follow that transaction. ' +
          'New wrapped deposits and withdrawals wait for it. ' +
          'Once your wallet shows the request done, reload this page to see the result here. ' +
          'Stop waiting only after checking your wallet: the request can still go through. ' +
          'A new review then starts from the new balances.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/was left open/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }));
    expect(onDismissRecovered).toHaveBeenCalledTimes(1);
  });

  it('shows no notice for a request the wallet still holds while nothing can be dismissed', () => {
    render(
      <WrappedPositionPanel
        route={wrappedRoute()}
        position={{ status: 'loaded', position: POSITION }}
        baseAsset={BASE_ASSET}
        earnAPR={0n}
        isRecoveredRequestPendingInWallet
        onRetry={jest.fn()}
      />
    );

    expect(screen.queryByText(/Anchorage app on your phone/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop waiting' })).not.toBeInTheDocument();
  });
});

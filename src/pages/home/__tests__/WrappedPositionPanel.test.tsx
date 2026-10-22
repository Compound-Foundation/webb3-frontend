import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { WRAPPED_MARKET_REGISTRY } from '@constants/wrappedMarkets';
import { Eligibility, LendingRoute } from '@helpers/lendingRoute';
import { WrappedPosition } from '@helpers/wrappedPositions';
import { WrappedPositionState } from '@hooks/useWrappedPosition';

import WrappedPositionPanel, { WrappedRoute } from '../components/WrappedPositionPanel';

const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const BASE_ASSET = { symbol: 'USDC', baseAssetPriceInDollars: 100_000_000n };

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
  snapshot: { totalSupply: 0n, totalAssets: 0n, baseSupplyIndex: 0n },
};

function renderPanel(position: WrappedPositionState, route = wrappedRoute(), onRetry = jest.fn()) {
  render(
    <WrappedPositionPanel
      route={route}
      position={position}
      baseAsset={BASE_ASSET}
      earnAPR={45_000_000_000_000_000n}
      onRetry={onRetry}
    />
  );
  return onRetry;
}

describe('WrappedPositionPanel', () => {
  it('shows the position value and the full-exit payout as separate figures', () => {
    renderPanel({ status: 'loaded', position: POSITION });

    expect(screen.getByTestId('wrapped-position-value')).toHaveTextContent('250.1250 USDC');
    expect(screen.getByTestId('wrapped-position-value-usd')).toHaveTextContent('$250.13');
    expect(screen.getByTestId('wrapped-full-exit-payout')).toHaveTextContent('250.1250 USDC');
    expect(screen.getByText(/depends on market liquidity/i)).toBeInTheDocument();
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
});

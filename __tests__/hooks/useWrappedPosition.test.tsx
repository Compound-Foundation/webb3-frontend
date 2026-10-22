import { JsonRpcProvider } from '@ethersproject/providers';
import { act, renderHook, waitFor } from '@testing-library/react';

import { WRAPPED_MARKET_REGISTRY, WrappedMarket } from '@constants/wrappedMarkets';
import { Eligibility, LendingRoute } from '@helpers/lendingRoute';
import { REFRESH_INTERVAL } from '@helpers/numbers';
import { WrappedPosition } from '@helpers/wrappedPositions';
import { useWrappedPosition, WrappedPositionReader } from '@hooks/useWrappedPosition';

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000bb2';
const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';
const PROVIDER = {} as JsonRpcProvider;
const ELIGIBLE: Eligibility = { isEligible: true };

function marketFor(cometAddress: string): WrappedMarket {
  const lookup = WRAPPED_MARKET_REGISTRY.lookup(1, cometAddress);
  if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
  return lookup.market;
}

function wrappedRoute(key: string, cometAddress = USDC_COMET, reads: Eligibility = ELIGIBLE): LendingRoute {
  const market = marketFor(cometAddress);
  return {
    kind: 'wrapped',
    chainId: 1,
    cometAddress,
    lookup: { status: 'valid', market },
    market,
    validationKey: key,
    reads,
    deposit: { isEligible: false, reason: 'deposits-disabled' },
    exit: { isEligible: false, reason: 'exits-disabled' },
  };
}

const STANDARD_ROUTE: LendingRoute = { kind: 'standard', writes: ELIGIBLE };

function position(shares: bigint): WrappedPosition {
  return {
    shares,
    shareDecimals: 18,
    grossAssets: shares / 10n ** 12n,
    baseDecimals: 6,
    baseWalletBalance: 0n,
    wrapperAllowance: 0n,
    redeemBuffer: 3n,
    fullExitCash: shares / 10n ** 12n - 3n,
    isWithdrawPaused: false,
    snapshot: { totalSupply: 0n, totalAssets: 0n, baseSupplyIndex: 0n },
  };
}

/** A reader whose reads resolve or reject only when the test says so. */
function deferredReader() {
  const pending: { account: string; resolve: (value: WrappedPosition) => void; reject: (error: Error) => void }[] = [];
  const read: WrappedPositionReader = jest.fn(
    (_provider, _market, account) =>
      new Promise<WrappedPosition>((resolve, reject) => pending.push({ account, resolve, reject }))
  );
  return { read, pending };
}

type Props = { route: LendingRoute; account: string | undefined; refreshToken?: unknown };

function renderPosition(read: WrappedPositionReader, initialProps: Props) {
  return renderHook(
    ({ route, account, refreshToken }: Props) =>
      useWrappedPosition({ route, account, provider: PROVIDER, refreshToken, read }),
    { initialProps }
  );
}

describe('useWrappedPosition', () => {
  it('does not read on the standard route', () => {
    const { read } = deferredReader();
    const { result } = renderPosition(read, { route: STANDARD_ROUTE, account: ACCOUNT });

    expect(result.current.state).toEqual({ status: 'not-applicable' });
    expect(read).not.toHaveBeenCalled();
  });

  it('waits, without reading, while the wrapper is being validated', () => {
    const { read } = deferredReader();
    const route = wrappedRoute('key-a', USDC_COMET, { isEligible: false, reason: 'validation-pending' });
    const { result } = renderPosition(read, { route, account: ACCOUNT });

    expect(result.current.state).toEqual({ status: 'loading' });
    expect(read).not.toHaveBeenCalled();
  });

  it('reports why reads are unavailable when the wrapper failed validation', () => {
    const { read } = deferredReader();
    const route = wrappedRoute('key-a', USDC_COMET, { isEligible: false, reason: 'asset-mismatch' });
    const { result } = renderPosition(read, { route, account: ACCOUNT });

    expect(result.current.state).toEqual({ status: 'unavailable', reason: 'asset-mismatch' });
    expect(read).not.toHaveBeenCalled();
  });

  it('loads the position for the route and account', async () => {
    const { read, pending } = deferredReader();
    const { result } = renderPosition(read, { route: wrappedRoute('key-a'), account: ACCOUNT });

    expect(result.current.state).toEqual({ status: 'loading' });
    expect(read).toHaveBeenCalledWith(PROVIDER, marketFor(USDC_COMET), ACCOUNT);
    await act(async () => pending[0].resolve(position(10n ** 18n)));

    expect(result.current.state).toEqual({ status: 'loaded', position: position(10n ** 18n) });
  });

  it.each([
    ['account', { route: wrappedRoute('key-b'), account: OTHER_ACCOUNT }],
    ['market', { route: wrappedRoute('key-b', USDT_COMET), account: ACCOUNT }],
    ['chain, connector or connection status', { route: wrappedRoute('key-b'), account: ACCOUNT }],
  ])('discards a read that finishes after the %s changed', async (_change, nextProps) => {
    const { read, pending } = deferredReader();
    const { result, rerender } = renderPosition(read, { route: wrappedRoute('key-a'), account: ACCOUNT });

    rerender(nextProps);
    expect(result.current.state).toEqual({ status: 'loading' });
    await act(async () => pending[0].resolve(position(5n * 10n ** 18n)));
    expect(result.current.state).toEqual({ status: 'loading' });

    await act(async () => pending[1].resolve(position(7n * 10n ** 18n)));
    expect(result.current.state).toEqual({ status: 'loaded', position: position(7n * 10n ** 18n) });
  });

  it('stops showing a loaded position as soon as the route changes', async () => {
    const { read, pending } = deferredReader();
    const { result, rerender } = renderPosition(read, { route: wrappedRoute('key-a'), account: ACCOUNT });
    await act(async () => pending[0].resolve(position(10n ** 18n)));
    expect(result.current.state.status).toBe('loaded');

    rerender({ route: wrappedRoute('key-b'), account: OTHER_ACCOUNT });
    expect(result.current.state).toEqual({ status: 'loading' });

    rerender({ route: STANDARD_ROUTE, account: OTHER_ACCOUNT });
    expect(result.current.state).toEqual({ status: 'not-applicable' });
  });

  it('reports a failed read with a retry that reads again', async () => {
    const { read, pending } = deferredReader();
    const { result } = renderPosition(read, { route: wrappedRoute('key-a'), account: ACCOUNT });
    await act(async () => pending[0].reject(new Error('rpc down')));

    expect(result.current.state).toEqual({
      status: 'error',
      message: 'Your wrapped position could not be loaded. Check your connection and try again.',
    });

    act(() => result.current.retry());
    expect(result.current.state).toEqual({ status: 'loading' });
    await act(async () => pending[1].resolve(position(10n ** 18n)));
    expect(result.current.state).toEqual({ status: 'loaded', position: position(10n ** 18n) });
  });

  it('waits, without an error, while the account is not yet available', () => {
    // Web3Context withholds the account until address screening allows it.
    const { read } = deferredReader();
    const { result } = renderPosition(read, { route: wrappedRoute('key-a'), account: undefined });

    expect(result.current.state).toEqual({ status: 'loading' });
    expect(read).not.toHaveBeenCalled();
  });

  describe('after a wrapper transaction settles', () => {
    /** A provider at `block`, which the test moves on. */
    function providerAt(block: { number: number }) {
      return { getBlockNumber: jest.fn(async () => block.number) } as unknown as JsonRpcProvider;
    }

    it('waits for the provider to reach the transaction block before it reads', async () => {
      const block = { number: 100 };
      const provider = providerAt(block);
      const read = jest.fn(async () => position(5n));
      renderHook(() =>
        useWrappedPosition({
          route: wrappedRoute('key-1'),
          account: ACCOUNT,
          provider,
          minBlock: 101,
          blockWait: { attempts: 200, intervalMs: 5 },
          read,
        })
      );

      await waitFor(() => expect((provider.getBlockNumber as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3));
      expect(read).not.toHaveBeenCalled();
      block.number = 101;
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    });

    it('reads anyway once the wait is over, since the timed refresh catches up later', async () => {
      const provider = providerAt({ number: 100 });
      const read = jest.fn(async () => position(5n));
      const { result } = renderHook(() =>
        useWrappedPosition({
          route: wrappedRoute('key-1'),
          account: ACCOUNT,
          provider,
          minBlock: 101,
          blockWait: { attempts: 2, intervalMs: 1 },
          read,
        })
      );

      await waitFor(() => expect(result.current.state).toEqual({ status: 'loaded', position: position(5n) }));
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(3);
    });
  });

  it('reads again when the refresh token changes and keeps the last position meanwhile', async () => {
    const { read, pending } = deferredReader();
    const route = wrappedRoute('key-a');
    const { result, rerender } = renderPosition(read, { route, account: ACCOUNT, refreshToken: 0 });
    await act(async () => pending[0].resolve(position(10n ** 18n)));

    rerender({ route, account: ACCOUNT, refreshToken: 1 });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(result.current.state).toEqual({ status: 'loaded', position: position(10n ** 18n) });

    await act(async () => pending[1].resolve(position(2n * 10n ** 18n)));
    expect(result.current.state).toEqual({ status: 'loaded', position: position(2n * 10n ** 18n) });
  });

  describe('with a read slower than the refresh interval', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('applies the slow read instead of starting over on every interval', async () => {
      const { read, pending } = deferredReader();
      const { result } = renderPosition(read, { route: wrappedRoute('key-a'), account: ACCOUNT });

      await act(async () => {
        jest.advanceTimersByTime(REFRESH_INTERVAL * 2);
      });
      expect(read).toHaveBeenCalledTimes(1);

      await act(async () => pending[0].resolve(position(10n ** 18n)));
      expect(result.current.state).toEqual({ status: 'loaded', position: position(10n ** 18n) });
    });

    it('shows a slow failure instead of loading forever', async () => {
      const { read, pending } = deferredReader();
      const { result } = renderPosition(read, { route: wrappedRoute('key-a'), account: ACCOUNT });

      await act(async () => {
        jest.advanceTimersByTime(REFRESH_INTERVAL + 5_000);
      });
      await act(async () => pending[0].reject(new Error('timeout')));

      expect(result.current.state.status).toBe('error');
    });

    it('reads again once an in-flight read finishes when a refresh was asked for meanwhile', async () => {
      const { read, pending } = deferredReader();
      const route = wrappedRoute('key-a');
      const { result, rerender } = renderPosition(read, { route, account: ACCOUNT, refreshToken: 0 });

      rerender({ route, account: ACCOUNT, refreshToken: 1 });
      expect(read).toHaveBeenCalledTimes(1);

      await act(async () => pending[0].resolve(position(10n ** 18n)));
      expect(result.current.state).toEqual({ status: 'loaded', position: position(10n ** 18n) });
      expect(read).toHaveBeenCalledTimes(2);

      await act(async () => pending[1].resolve(position(3n * 10n ** 18n)));
      expect(result.current.state).toEqual({ status: 'loaded', position: position(3n * 10n ** 18n) });
    });
  });
});

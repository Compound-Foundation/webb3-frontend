import { JsonRpcProvider } from '@ethersproject/providers';
import { Provider } from 'ethers-multicall';
import { useCallback, useEffect, useRef, useState } from 'react';

import { WrappedMarket } from '@constants/wrappedMarkets';
import { LendingRoute, WriteBlockReason } from '@helpers/lendingRoute';
import { REFRESH_INTERVAL } from '@helpers/numbers';
import { readWrappedPosition, WrappedPosition } from '@helpers/wrappedPositions';

export type WrappedPositionReader = (
  provider: JsonRpcProvider,
  market: WrappedMarket,
  account: string
) => Promise<WrappedPosition>;

export type WrappedPositionState =
  | { status: 'not-applicable' }
  | { status: 'unavailable'; reason: WriteBlockReason }
  | { status: 'loading' }
  | { status: 'loaded'; position: WrappedPosition }
  | { status: 'error'; message: string };

export const WRAPPED_POSITION_READ_FAILED =
  'Your wrapped position could not be loaded. Check your connection and try again.';

const readWithMulticall: WrappedPositionReader = (provider, market, account) =>
  readWrappedPosition(new Provider(provider, market.chainId), market, account);

type StoredState = { key: string; state: WrappedPositionState };

/**
 * Reads the connected account's position in the selected market's wrapper, on the wrapped
 * route only. Each read belongs to the route key it started under. The key covers the market,
 * the wrapper, the connector, the account, the chain and the connection status. A result that
 * arrives after the key changed is dropped. A new key shows as loading until its own read
 * finishes, so one wallet's position never appears under another. A return to an earlier key
 * counts as a new key, so the key's earlier position does not reappear.
 */
export function useWrappedPosition({
  route,
  account,
  provider,
  refreshToken,
  read = readWithMulticall,
}: {
  route: LendingRoute;
  account: string | undefined;
  provider: JsonRpcProvider | undefined;
  /** Any value that changes whenever the position needs reading again, such as after a transaction. */
  refreshToken?: unknown;
  read?: WrappedPositionReader;
}): { state: WrappedPositionState; retry: () => void } {
  const [stored, setStored] = useState<StoredState | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);
  // Whether a read for the current key is running, and whether another was asked for meanwhile.
  const isReading = useRef(false);
  const isRefreshQueued = useRef(false);

  const market = route.kind === 'wrapped' ? route.market : undefined;
  const readKey =
    route.kind === 'wrapped' &&
    route.reads.isEligible &&
    route.validationKey !== undefined &&
    market !== undefined &&
    account !== undefined &&
    provider !== undefined
      ? route.validationKey
      : undefined;

  // Starts a read with the latest render's inputs. The key covers the market and the account,
  // so they cannot differ from the ones the key was made from.
  const startRead = useRef<() => void>(() => undefined);
  startRead.current = () => {
    if (readKey === undefined || market === undefined || account === undefined || provider === undefined) return;
    const id = ++requestId.current;
    const key = readKey;
    isReading.current = true;
    isRefreshQueued.current = false;

    const finish = (state: WrappedPositionState) => {
      if (id !== requestId.current) return;
      isReading.current = false;
      setStored({ key, state });
      if (isRefreshQueued.current) startRead.current();
    };
    read(provider, market, account).then(
      (position) => finish({ status: 'loaded', position }),
      (error) => {
        if (id === requestId.current) console.error('Wrapped position read failed:', error);
        finish({ status: 'error', message: WRAPPED_POSITION_READ_FAILED });
      }
    );
  };

  // A new key, provider or retry makes any read in flight obsolete, so it starts over. The effect
  // also clears the stored position. Otherwise a return to an earlier key shows that key's old
  // position until the new read finishes.
  useEffect(() => {
    isReading.current = false;
    setStored(undefined);
    startRead.current();
    return () => {
      requestId.current++;
      isReading.current = false;
    };
  }, [readKey, provider, attempt]);

  // A refresh never cancels a read in flight, so a read slower than the refresh interval still
  // finishes. A refresh asked for by a transaction runs once the current read finishes. A timed
  // refresh is skipped while a read is running.
  const refresh = useRef((queueIfReading: boolean) => {
    if (!isReading.current) startRead.current();
    else if (queueIfReading) isRefreshQueued.current = true;
  });

  const lastRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (Object.is(lastRefreshToken.current, refreshToken)) return;
    lastRefreshToken.current = refreshToken;
    refresh.current(true);
  }, [refreshToken]);

  useEffect(() => {
    if (readKey === undefined) return;
    const intervalId = setInterval(() => refresh.current(false), REFRESH_INTERVAL);
    return () => clearInterval(intervalId);
  }, [readKey]);

  const retry = useCallback(() => {
    if (readKey !== undefined) setStored({ key: readKey, state: { status: 'loading' } });
    setAttempt((value) => value + 1);
  }, [readKey]);

  let state: WrappedPositionState;
  if (route.kind !== 'wrapped') {
    state = { status: 'not-applicable' };
  } else if (!route.reads.isEligible) {
    state =
      route.reads.reason === 'validation-pending'
        ? { status: 'loading' }
        : { status: 'unavailable', reason: route.reads.reason };
  } else if (account === undefined || provider === undefined) {
    // Web3Context withholds the account until address screening allows it, and the provider
    // comes from the app's chain configuration. Neither is a read failure.
    state = { status: 'loading' };
  } else if (stored !== undefined && stored.key === readKey) {
    state = stored.state;
  } else {
    state = { status: 'loading' };
  }

  return { state, retry };
}

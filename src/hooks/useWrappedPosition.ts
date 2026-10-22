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
const NO_ACCOUNT = 'No account is connected, so there is no wrapped position to load.';
const NO_PROVIDER = 'There is no connection to the network this market is on, so your wrapped position cannot load.';

const readWithMulticall: WrappedPositionReader = (provider, market, account) =>
  readWrappedPosition(new Provider(provider, market.chainId), market, account);

type StoredState = { key: string; state: WrappedPositionState };

/**
 * Reads the connected account's position in the selected market's wrapper, on the wrapped
 * route only. A read belongs to the route key it started under, which covers the market, the
 * wrapper, the connector, the account, the chain and the connection status. A result that
 * arrives after the key changed is dropped, and a new key shows as loading until its own read
 * finishes, so one wallet's position never appears under another.
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
  /** Any value that changes when the position should be read again, such as after a transaction. */
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

  // A new key, provider or retry makes any read in flight obsolete, so it starts over.
  useEffect(() => {
    isReading.current = false;
    startRead.current();
    return () => {
      requestId.current++;
      isReading.current = false;
    };
  }, [readKey, provider, attempt]);

  // A refresh never cancels a read in flight; a slow read would otherwise never finish. A
  // refresh asked for by a transaction runs once the current read finishes; a timed one is
  // skipped while a read is running.
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
  } else if (account === undefined) {
    state = { status: 'error', message: NO_ACCOUNT };
  } else if (provider === undefined) {
    state = { status: 'error', message: NO_PROVIDER };
  } else if (stored !== undefined && stored.key === readKey) {
    state = stored.state;
  } else {
    state = { status: 'loading' };
  }

  return { state, retry };
}

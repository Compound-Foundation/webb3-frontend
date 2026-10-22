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
  const [tick, setTick] = useState(0);
  const requestId = useRef(0);

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

  // The effect reads the inputs of the render that produced `readKey`. The key covers the
  // market and the account, so they cannot differ from the ones it was made from.
  const inputs = useRef({ market, account, provider, read });
  inputs.current = { market, account, provider, read };

  useEffect(() => {
    if (readKey === undefined) return;
    const id = ++requestId.current;
    const { market, account, provider, read } = inputs.current;
    if (market === undefined || account === undefined || provider === undefined) return;

    read(provider, market, account).then(
      (position) => {
        if (id === requestId.current) setStored({ key: readKey, state: { status: 'loaded', position } });
      },
      (error) => {
        if (id !== requestId.current) return;
        console.error('Wrapped position read failed:', error);
        setStored({ key: readKey, state: { status: 'error', message: WRAPPED_POSITION_READ_FAILED } });
      }
    );
    return () => {
      requestId.current++;
    };
  }, [readKey, provider, refreshToken, attempt, tick]);

  useEffect(() => {
    if (readKey === undefined) return;
    const intervalId = setInterval(() => setTick((value) => value + 1), REFRESH_INTERVAL);
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

import type { CometStateWithMarket, MarketIdentity } from '@helpers/wrappedPositions';
import { CometState } from '@types';

// Each Comet state object is made by one read, so the record lives as long as its state.
const sources = new WeakMap<CometState, CometStateWithMarket>();

/** Records the market and account a read made `state` for. `useCometState` records every state it reads. */
export function recordCometStateSource(state: CometState, market: MarketIdentity, account: string | undefined) {
  sources.set(state, { market, account, state });
}

/**
 * `state` with the market and account it was read for. A state with no record, such as a loading
 * state, names neither, so nothing takes it for the connected account's.
 */
export function withCometStateSource(state: CometState): CometStateWithMarket {
  return sources.get(state) ?? { market: undefined, account: undefined, state };
}

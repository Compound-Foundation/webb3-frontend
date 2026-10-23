import { useState } from 'react';

import { initialEstimatedGasMap } from '@helpers/gasEstimator';
import { MarketData } from '@types';

import type { QueueSession } from './useActionQueue';

/** What a gas estimate belongs to. */
export type GasEstimateScope = {
  /** The wallet session, as the action queue keeps it. */
  session: QueueSession;
  /** The wallet's network, which can differ from the market's. */
  walletChainId: number | undefined;
  market: Pick<MarketData, 'chainInformation' | 'marketAddress'> | undefined;
};

export type GasEstimates = {
  /** Gas estimates by action key: the market chain's defaults, and the estimates made this visit. */
  estimatedGasMap: Map<string, number>;
  /** Records `estimate` under `actionsKey` once it resolves, unless the visit has ended by then. */
  addEstimate: (actionsKey: string, estimate: Promise<number>) => void;
};

type Estimates = { key: string; visit: number; gasByActions: Map<string, number> };

function scopeKey({ session, walletChainId, market }: GasEstimateScope): string {
  return [
    session.account?.toLowerCase() ?? '',
    session.connector ?? '',
    session.status,
    walletChainId ?? '',
    market === undefined ? '' : `${market.chainInformation.chainId}:${market.marketAddress.toLowerCase()}`,
  ].join('|');
}

/**
 * Gas estimates for queued actions, kept for one visit to a scope: the wallet session, the wallet's
 * network and the market. A change of any of them starts a new visit in the same render, from the
 * defaults for the market's chain. An estimate that resolves after its visit ended is dropped.
 * Otherwise an estimate made for one account or network sets the gas limit of another's transaction.
 */
export function useGasEstimates(scope: GasEstimateScope): GasEstimates {
  const key = scopeKey(scope);
  const chainInformation = scope.market?.chainInformation;
  const [estimates, setEstimates] = useState<Estimates>(() => ({
    key,
    visit: 0,
    gasByActions: initialEstimatedGasMap(chainInformation),
  }));
  // React discards this render and renders again with the new visit, so no committed render shows
  // the previous scope's estimates.
  if (estimates.key !== key) {
    setEstimates({ key, visit: estimates.visit + 1, gasByActions: initialEstimatedGasMap(chainInformation) });
  }

  const { visit } = estimates;
  const addEstimate = (actionsKey: string, estimate: Promise<number>) => {
    estimate.then((gas) => {
      setEstimates((current) =>
        current.visit === visit
          ? { ...current, gasByActions: new Map(current.gasByActions).set(actionsKey, gas) }
          : current
      );
    });
  };

  return { estimatedGasMap: estimates.gasByActions, addEstimate };
}

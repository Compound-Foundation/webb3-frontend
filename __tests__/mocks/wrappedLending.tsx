import { ReactNode } from 'react';

import type { Web3 } from '@contexts/Web3Context';
import { queueScope, submissionScope, WrappedLending, WrappedLendingContext } from '@contexts/WrappedLendingContext';
import { useSubmissionStore } from '@hooks/useSubmissionStore';
import { Action, MarketData, SettledTransaction, Transaction } from '@types';

const NO_TRANSACTIONS: Transaction[] = [];
const NO_SETTLED_TRANSACTIONS: SettledTransaction[] = [];
const ignoreRemoval: (action: Action) => void = () => undefined;
/** The wallet provider of a session whose web3 has none, so the store can treat it as restored. */
const STAND_IN_PROVIDER = {};

/**
 * Provides `value` with a working submission store, as App does: the store keeps its records across
 * rerenders with new values, for the session and market given, while the rest of the value comes
 * from the test. The store follows a started wrapper action through `transactions` and
 * `settledTransactions`, and takes it out of the queue through `removeAction`. The manager is taken
 * to have restored the session's stored transactions, which are `transactions`.
 */
export function TestLendingProvider({
  value,
  web3,
  market,
  transactions = NO_TRANSACTIONS,
  settledTransactions = NO_SETTLED_TRANSACTIONS,
  removeAction = ignoreRemoval,
  children,
}: {
  value: WrappedLending;
  web3: Web3;
  market: MarketData;
  transactions?: Transaction[];
  settledTransactions?: SettledTransaction[];
  removeAction?: (action: Action) => void;
  children: ReactNode;
}) {
  const marketIdentity = { chainId: market.chainInformation.chainId, cometAddress: market.marketAddress };
  const provider = web3.write.provider ?? STAND_IN_PROVIDER;
  const { account, chainId } = web3.write;
  const submission = useSubmissionStore({
    scope: submissionScope(web3.write, marketIdentity),
    queueScope: queueScope(web3.write, marketIdentity),
    transactions,
    settledTransactions,
    removeAction,
    wallet: { provider, account, chainId },
    market: marketIdentity,
    restoredSession:
      account === undefined || chainId === undefined
        ? undefined
        : { provider, account: account.toLowerCase(), chainId },
  });
  return <WrappedLendingContext.Provider value={{ ...value, submission }}>{children}</WrappedLendingContext.Provider>;
}

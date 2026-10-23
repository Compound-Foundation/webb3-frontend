import { JsonRpcProvider, TransactionReceipt } from '@ethersproject/providers';
import { act, renderHook, waitFor } from '@testing-library/react';

import { ANCHORAGE_CONNECTOR_ID, WrappedMarket, WrappedMarketRegistry } from '@constants/wrappedMarkets';
import type { Web3 } from '@contexts/Web3Context';
import { LendingSession, resolveLendingRoute, ValidationStatus, wrappedRouteKey } from '@helpers/lendingRoute';
import { WrappedActionType, WrappedBlockReason, WrappedSession } from '@helpers/wrappedActions';
import { BlockWait } from '@helpers/wrappedPositions';
import { WithdrawalRequest } from '@helpers/wrappedWithdrawals';
import type { ScreeningStatus } from '@hooks/useAddressScreening';
import { validateWrappedMarket } from '@hooks/useLendingRoute';
import { TransactionManager, useTransactionManager } from '@hooks/useTransactionManager';
import { useWrappedAction, WrappedActionState, WrappedStepState } from '@hooks/useWrappedAction';
import { positionRefreshToken, useWrappedPosition } from '@hooks/useWrappedPosition';
import { newestReceiptBlock, useWriteWrappedState } from '@hooks/useWriteWrappedState';

import { FORK_REGISTRY } from './fixtures';
import { forkProvider } from './fork';

/** Reads that wait for a block try again quickly: the fork answers at once. */
const FORK_BLOCK_WAIT: BlockWait = { attempts: 200, intervalMs: 25 };
/** How long a step may take on the fork, from confirmation to its receipt. */
const STEP_TIMEOUT_MS = 120_000;

export type SessionSetup = {
  account: string;
  cometAddress: string;
  connectorId?: string;
  chainId?: number;
  screeningStatus?: ScreeningStatus;
  isWatchOnly?: boolean;
  registry?: WrappedMarketRegistry;
};

/**
 * The session as `useLendingRoute` builds it for a connected wallet, with the wrapper validated
 * on the fork by the app's own `validateWrappedMarket` through the configured chain's provider.
 */
async function sessionFor(wallet: object, readProvider: JsonRpcProvider, setup: SessionSetup): Promise<WrappedSession> {
  const registry = setup.registry ?? FORK_REGISTRY;
  const lending: LendingSession = setup.isWatchOnly
    ? {
        connector: undefined,
        status: 'disconnected',
        account: undefined,
        chainId: setup.chainId ?? 1,
        isWatchOnly: true,
        isSignerReady: false,
        screeningStatus: setup.screeningStatus ?? 'idle',
      }
    : {
        connector: { id: setup.connectorId ?? ANCHORAGE_CONNECTOR_ID, uid: 'fork-connector' },
        status: 'connected',
        account: setup.account,
        chainId: setup.chainId ?? 1,
        isWatchOnly: false,
        isSignerReady: true,
        screeningStatus: setup.screeningStatus ?? 'allowed',
      };
  const lookup = registry.lookup(1, setup.cometAddress);
  let validation: { key: string; status: ValidationStatus } | undefined;
  if (lookup.status === 'valid') {
    validation = {
      key: wrappedRouteKey(lookup.market, lending),
      status: await validateWrappedMarket(readProvider, lookup.market),
    };
  }
  const route = resolveLendingRoute({
    market: { chainId: 1, cometAddress: setup.cometAddress },
    session: lending,
    conflictedRdns: new Set(),
    validation,
    registry,
  });
  return {
    route,
    account: lending.account,
    chainId: lending.chainId,
    screeningStatus: lending.screeningStatus,
    provider: wallet,
  };
}

function web3For(account: string | undefined, wallet: JsonRpcProvider, readProvider: JsonRpcProvider): Web3 {
  const fail = () => Promise.reject(new Error('Not available on the fork.'));
  return {
    read: { connector: undefined, chainId: 1, account, isActive: true, provider: readProvider },
    write: { connector: undefined, chainId: 1, account, isActive: true, status: 'connected', provider: wallet },
    screeningStatus: 'allowed',
    desiredWriteNetwork: 1,
    setConnector: () => undefined,
    switchReadNetwork: fail,
    switchWriteNetwork: fail,
    connectWallet: fail,
    disconnectWallet: fail,
  } as unknown as Web3;
}

const SETTLED: readonly WrappedStepState['status'][] = [
  'confirmed',
  'reverted',
  'replaced',
  'rejected',
  'provider-failure',
  'blocked',
];

export type WrappedApp<T = undefined> = Awaited<ReturnType<typeof renderWrappedApp<T>>>;

/** More of App's hooks to render beside the wrapped route, sharing its transaction manager. */
export type ExtraHooks<T> = (context: { manager: TransactionManager; web3: Web3 }) => T;

/**
 * The wrapped route as App wires it: the transaction manager, the wrapper action lifecycle, the
 * wrapped writes and the position read, against the local fork. The wallet's provider is an ethers
 * provider for the fork, and anvil signs for the impersonated account, so every check, gas estimate
 * and request is the app's own, up to the signature. `useExtra` renders more of App's hooks, such
 * as the direct Comet state and writes, with the same transaction manager.
 */
export async function renderWrappedApp<T = undefined>(
  setup: SessionSetup & { market: WrappedMarket; symbol: string },
  useExtra?: ExtraHooks<T>
) {
  const wallet = forkProvider();
  const readProvider = forkProvider();
  const initialSession = await sessionFor(wallet, readProvider, setup);
  const hook = renderHook(
    ({ session, web3 }: { session: WrappedSession; web3: Web3 }) => {
      const manager = useTransactionManager(web3);
      const action = useWrappedAction({ session, manager, readProvider });
      const write = useWriteWrappedState({
        action,
        route: session.route,
        readProvider,
        baseSymbol: setup.symbol,
        blockWait: FORK_BLOCK_WAIT,
      });
      const position = useWrappedPosition({
        route: session.route,
        account: session.account,
        provider: readProvider,
        refreshToken: positionRefreshToken(manager.transactions, manager.settledTransactions),
        minBlock: newestReceiptBlock(action.recovered.settled),
        blockWait: FORK_BLOCK_WAIT,
      });
      // `useExtra` is the same function on every render, so the hooks it calls keep their order.
      const extra = useExtra?.({ manager, web3 }) as T;
      return { manager, action, write, position, session, extra };
    },
    { initialProps: { session: initialSession, web3: web3For(initialSession.account, wallet, readProvider) } }
  );
  const { result } = hook;

  const state = (): WrappedActionState => result.current.action.state;
  const steps = (): readonly WrappedStepState[] => {
    const current = state();
    return 'steps' in current ? current.steps : [];
  };

  /** Waits until the lifecycle would start a review of `type`: no other review or transaction is in progress. */
  const waitUntilReady = async (type: WrappedActionType) => {
    await waitFor(() => expect(result.current.action.blockedReason(type)).toBeUndefined(), {
      timeout: STEP_TIMEOUT_MS,
      interval: 25,
    });
  };

  const startReview = async (start: () => WrappedBlockReason | undefined): Promise<WrappedBlockReason | undefined> => {
    let refusal: WrappedBlockReason | undefined;
    act(() => {
      refusal = start();
    });
    if (refusal !== undefined) return refusal;
    await waitFor(() => expect(['review', 'read-failed', 'discarded']).toContain(state().phase), {
      timeout: STEP_TIMEOUT_MS,
      interval: 25,
    });
    return undefined;
  };

  return {
    ...hook,
    wallet,
    readProvider,
    state,
    steps,
    waitUntilReady,
    /** Starts a wrapped supply review of `amount` base units, as the supply form does. */
    startSupply: async (amount: bigint) => {
      await waitUntilReady('supply');
      return startReview(() => result.current.write.supply(amount));
    },
    /** Starts a wrapped withdrawal review, as the withdraw form does. */
    startWithdraw: async (request: WithdrawalRequest, shownCash?: bigint) => {
      await waitUntilReady('withdraw');
      return startReview(() => result.current.write.withdraw(request, shownCash));
    },
    /** The draft in review, or the one that completed or stopped. */
    draft: () => {
      const current = state();
      if (!('draft' in current)) throw new Error(`No draft: the lifecycle is ${current.phase}.`);
      return current.draft;
    },
    /** The withdrawal as its step's check found it just before the signature, once that check passed. */
    rechecked: () => {
      const current = state();
      return 'rechecked' in current ? current.rechecked : undefined;
    },
    /** Why the review could not be read, when it could not. */
    readFailure: () => {
      const current = state();
      return current.phase === 'read-failed' ? current.message : undefined;
    },
    /** Confirms the step in review and waits until it settles or stops. Returns its final state. */
    confirmStep: async (): Promise<WrappedStepState> => {
      const current = state();
      if (current.phase !== 'review') throw new Error(`No step is in review: the lifecycle is ${current.phase}.`);
      const index = current.stepIndex;
      act(() => result.current.action.confirm());
      await waitFor(() => expect(SETTLED).toContain(steps()[index]?.status), {
        timeout: STEP_TIMEOUT_MS,
        interval: 25,
      });
      return steps()[index];
    },
    /** The receipt of a confirmed step. */
    receiptOf: (step: WrappedStepState): TransactionReceipt => {
      if (step.status !== 'confirmed') {
        throw new Error(`The step did not confirm: ${step.status}${'message' in step ? `: ${step.message}` : ''}.`);
      }
      return step.receipt;
    },
    /** Replaces the session, as a change of account, chain, market, connector or screening does. */
    changeSession: async (change: Partial<SessionSetup>) => {
      const next = { ...setup, ...change };
      const session = await sessionFor(wallet, readProvider, next);
      act(() => hook.rerender({ session, web3: web3For(session.account, wallet, readProvider) }));
      return session;
    },
    /**
     * The panel's position once it shows `shares`, the balance the chain holds. The panel reads
     * again by itself after a transaction settles, so this waits for that read.
     */
    positionShowing: async (shares: bigint) => {
      await waitFor(
        () => {
          const { state: positionState } = result.current.position;
          expect(positionState.status === 'loaded' ? positionState.position.shares : undefined).toBe(shares);
        },
        { timeout: STEP_TIMEOUT_MS, interval: 25 }
      );
      const { state: positionState } = result.current.position;
      if (positionState.status !== 'loaded') throw new Error('The position did not load.');
      return positionState.position;
    },
    /** Reads the panel's position again, as its Retry does, and returns the new read. */
    refreshPosition: async () => {
      act(() => result.current.position.retry());
      await waitFor(() => expect(result.current.position.state.status).toBe('loaded'), {
        timeout: STEP_TIMEOUT_MS,
        interval: 25,
      });
      const { state: positionState } = result.current.position;
      if (positionState.status !== 'loaded') throw new Error('The position did not load.');
      return positionState.position;
    },
  };
}

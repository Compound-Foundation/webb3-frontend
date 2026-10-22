import { Interface } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/providers';
import { act, renderHook, waitFor } from '@testing-library/react';

import {
  ANCHORAGE_CONNECTOR_ID,
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WrappedMarketRegistry,
} from '@constants/wrappedMarkets';
import { LendingSession, resolveLendingRoute, ValidationStatus, wrappedRouteKey } from '@helpers/lendingRoute';
import { SendWithdrawnError, SessionProbeResult } from '@helpers/walletErrors';
import { MarketRestriction, WrappedActionIdentity, WrappedSession, WrappedStep } from '@helpers/wrappedActions';
import type { SendResult, TransactionManager, TransactionRequest } from '@hooks/useTransactionManager';
import { useWrappedAction, WrappedActionController } from '@hooks/useWrappedAction';
import { PendingTransaction, SettledTransaction, Transaction, TransactionState } from '@types';

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000bb2';
const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';
const USDC_WRAPPER = '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73';
const USDT_WRAPPER = '0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const BROKEN_EXTENSION = new TypeError("Cannot read properties of undefined (reading 'sendMessage')");

const CALLS = new Interface([
  'function approve(address spender, uint256 amount)',
  'function supplyAndWrap(uint256 amount)',
]);
const APPROVE: WrappedStep = {
  id: 'approve',
  kind: 'approve',
  description: 'Approve USDC for the wrapper',
  request: { to: USDC, data: CALLS.encodeFunctionData('approve', [USDC_WRAPPER, 1_000_000n]) },
};
const SUPPLY: WrappedStep = {
  id: 'supply',
  kind: 'supply-and-wrap',
  description: 'Supply USDC through the wrapper',
  request: { to: USDC_WRAPPER, data: CALLS.encodeFunctionData('supplyAndWrap', [1_000_000n]) },
};
const PLAN = { amount: 1_000_000n, steps: [APPROVE, SUPPLY] };
const prepareSupply = async () => PLAN;

function openRegistry({ deposits = true } = {}): WrappedMarketRegistry {
  return buildWrappedMarketRegistry({
    markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
      ...market,
      isDepositEnabled: deposits,
      isExitEnabled: true,
    })),
  });
}
const OPEN = openRegistry();

/** A wallet provider whose reads succeed until a test breaks them. */
function walletProvider() {
  const sendUncheckedTransaction = jest.fn(async () => '0xsent');
  const wallet = {
    chainId: 1,
    readError: undefined as unknown,
    send: jest.fn(async (method: string): Promise<unknown> => {
      if (wallet.readError !== undefined && (method === 'eth_blockNumber' || wallet.readError instanceof TypeError)) {
        throw wallet.readError;
      }
      return method === 'eth_chainId' ? `0x${wallet.chainId.toString(16)}` : '0x10';
    }),
    getSigner: jest.fn(() => ({ sendUncheckedTransaction })),
    sendUncheckedTransaction,
  };
  return wallet;
}
type Wallet = ReturnType<typeof walletProvider>;

type SessionSetup = Partial<LendingSession> & {
  cometAddress?: string;
  registry?: WrappedMarketRegistry;
  validation?: ValidationStatus;
};

/** The session as the app builds it, with the wrapper validated for that session. */
function sessionFor(wallet: Wallet, setup: SessionSetup = {}): WrappedSession {
  const lending: LendingSession = {
    connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-1' },
    status: 'connected',
    account: ACCOUNT,
    chainId: 1,
    isWatchOnly: false,
    isSignerReady: true,
    screeningStatus: 'allowed',
    ...setup,
  };
  const registry = setup.registry ?? OPEN;
  const cometAddress = setup.cometAddress ?? USDC_COMET;
  const lookup = registry.lookup(1, cometAddress);
  const key = lookup.status === 'valid' ? wrappedRouteKey(lookup.market, lending) : '';
  const route = resolveLendingRoute({
    market: { chainId: 1, cometAddress },
    session: lending,
    conflictedRdns: new Set(),
    validation: { key, status: setup.validation ?? 'matched' },
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

type Manager = Pick<
  TransactionManager,
  'transactions' | 'settledTransactions' | 'walletFailure' | 'submitTransaction' | 'dismissTransaction'
>;

/** A transaction manager whose sends resolve only when the test says so. */
function fakeManager() {
  const requests: { request: TransactionRequest; resolve: (result: SendResult) => void }[] = [];
  const manager: Manager = {
    transactions: [],
    settledTransactions: [],
    walletFailure: undefined,
    dismissTransaction: jest.fn(),
    submitTransaction: jest.fn(
      (request: TransactionRequest) => new Promise<SendResult>((resolve) => requests.push({ request, resolve }))
    ),
  };
  return { manager, requests };
}

type Props = { session: WrappedSession; manager: Manager };

type Options = {
  probe?: jest.Mock<Promise<SessionProbeResult>>;
  restriction?: (identity: WrappedActionIdentity) => Promise<MarketRestriction | undefined>;
};

function renderAction(initialProps: Props, { probe, restriction }: Options = {}) {
  return renderHook(
    ({ session, manager }: Props) =>
      useWrappedAction({
        session,
        manager,
        readProvider: undefined,
        probe,
        checkRestriction: restriction ?? (async () => undefined),
      }),
    { initialProps }
  );
}

type Result = { current: WrappedActionController };

async function reachReview(result: Result) {
  act(() => {
    result.current.start('supply', prepareSupply);
  });
  await waitFor(() => expect(result.current.state.phase).toBe('review'));
}

async function confirmAndWaitForWallet(result: Result, requests: unknown[], count: number) {
  act(() => result.current.confirm());
  await waitFor(() => expect(requests).toHaveLength(count));
}

function receipt(hash: string, status = 1): TransactionReceipt {
  return { transactionHash: hash, status } as TransactionReceipt;
}

function stepStatuses(result: Result): string[] {
  const { state } = result.current;
  return 'steps' in state ? state.steps.map((step) => step.status) : [];
}

describe('useWrappedAction', () => {
  let wallet: Wallet;

  beforeEach(() => {
    wallet = walletProvider();
  });

  describe('identity changes', () => {
    const CHANGES: [string, (wallet: Wallet) => WrappedSession][] = [
      ['account', (wallet) => sessionFor(wallet, { account: OTHER_ACCOUNT })],
      ['connector', (wallet) => sessionFor(wallet, { connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-2' } })],
      ['reconnect', (wallet) => sessionFor(wallet, { status: 'reconnecting' })],
      ['chain', (wallet) => sessionFor(wallet, { chainId: 8453 })],
      ['market', (wallet) => sessionFor(wallet, { cometAddress: USDT_COMET })],
      ['wallet provider', () => sessionFor(walletProvider())],
    ];
    const STAGES = ['reads', 'review', 'approval wait', 'wallet confirmation'] as const;
    const MATRIX = STAGES.flatMap((stage) => CHANGES.map(([change, session]) => [stage, change, session] as const));

    it.each(MATRIX)(
      'discards late reads, closes review, and requires fresh confirmation after an identity change: %s, %s',
      async (stage, _change, changedSession) => {
        const { manager, requests } = fakeManager();
        const original = sessionFor(wallet);
        const { result, rerender } = renderAction({ session: original, manager });
        let finishRead: () => void = () => undefined;

        if (stage === 'reads') {
          act(() => {
            result.current.start('supply', () => new Promise((resolve) => (finishRead = () => resolve(PLAN))));
          });
          expect(result.current.state.phase).toBe('reading');
        } else {
          await reachReview(result);
        }
        if (stage === 'approval wait' || stage === 'wallet confirmation') {
          await confirmAndWaitForWallet(result, requests, 1);
          expect(stepStatuses(result)).toEqual(['awaiting-signature', 'waiting']);
        }
        if (stage === 'approval wait') {
          await act(async () => requests[0].resolve({ status: 'submitted', id: 'id-1', hash: '0xapproval' }));
          expect(stepStatuses(result)).toEqual(['submitted', 'waiting']);
        }

        rerender({ session: changedSession(wallet), manager });

        // Closed in the same render, before any effect runs.
        expect(result.current.state).toMatchObject({ phase: 'discarded', reason: 'identity-changed' });
        // Clearing the draft cancels nothing: what was sent stays listed as sent.
        if (stage === 'approval wait') expect(result.current.state).toMatchObject({ submittedHashes: ['0xapproval'] });
        if (stage === 'wallet confirmation') expect(result.current.state).toMatchObject({ isWalletRequestOpen: true });

        // Late results change nothing.
        await act(async () => {
          finishRead();
          requests[0]?.resolve({ status: 'submitted', id: 'id-1', hash: '0xlate' });
          requests[0]?.request.onSettled?.({ status: 'confirmed', receipt: receipt('0xapproval') });
        });
        expect(result.current.state.phase).toBe('discarded');

        // Returning to the reviewed session does not bring the draft back.
        rerender({ session: original, manager });
        act(() => result.current.confirm());
        expect(result.current.state.phase).toBe('discarded');
        expect(manager.submitTransaction).toHaveBeenCalledTimes(requests.length);
        expect(requests.length).toBeLessThanOrEqual(1);

        // Only a fresh review and confirmation sends anything, starting from the first step.
        await reachReview(result);
        await confirmAndWaitForWallet(result, requests, requests.length + 1);
        expect(requests[requests.length - 1].request.step).toBe('approve');
      }
    );

    it.each(CHANGES)('never renders the review after a change of %s', async (_change, changedSession) => {
      const { manager } = fakeManager();
      const phases: string[] = [];
      const { result, rerender } = renderHook(
        ({ session }: { session: WrappedSession }) => {
          const action = useWrappedAction({
            session,
            manager,
            readProvider: undefined,
            checkRestriction: async () => undefined,
          });
          phases.push(action.state.phase);
          return action;
        },
        { initialProps: { session: sessionFor(wallet) } }
      );
      await reachReview(result);

      phases.length = 0;
      rerender({ session: changedSession(wallet) });

      expect(phases.length).toBeGreaterThan(0);
      expect(phases.every((phase) => phase === 'discarded')).toBe(true);
    });

    it('drops a late read even when the session returns to the one it started in', async () => {
      const { manager } = fakeManager();
      const original = sessionFor(wallet);
      const { result, rerender } = renderAction({ session: original, manager });
      let finishRead: () => void = () => undefined;
      act(() => {
        result.current.start('supply', () => new Promise((resolve) => (finishRead = () => resolve(PLAN))));
      });

      rerender({ session: sessionFor(wallet, { account: OTHER_ACCOUNT }), manager });
      rerender({ session: original, manager });
      await act(async () => finishRead());

      expect(result.current.state.phase).toBe('discarded');
    });
  });

  it('keeps a read from an earlier start out of a fresh review', async () => {
    const { manager } = fakeManager();
    const original = sessionFor(wallet);
    const { result, rerender } = renderAction({ session: original, manager });
    let finishEarlierRead: () => void = () => undefined;
    act(() => {
      result.current.start('supply', () => new Promise((resolve) => (finishEarlierRead = () => resolve(PLAN))));
    });
    rerender({ session: sessionFor(wallet, { account: OTHER_ACCOUNT }), manager });
    rerender({ session: original, manager });

    let finishFreshRead: () => void = () => undefined;
    const freshSupply: WrappedStep = {
      ...SUPPLY,
      request: { ...SUPPLY.request, data: CALLS.encodeFunctionData('supplyAndWrap', [2_000_000n]) },
    };
    const freshPlan = { amount: 2_000_000n, steps: [freshSupply] };
    act(() => {
      result.current.start('supply', () => new Promise((resolve) => (finishFreshRead = () => resolve(freshPlan))));
    });
    await act(async () => finishEarlierRead());
    expect(result.current.state.phase).toBe('reading');

    await act(async () => finishFreshRead());
    expect(result.current.state).toMatchObject({ phase: 'review', draft: { amount: 2_000_000n } });
  });

  describe('checks before each signature', () => {
    type Check = [string, (wallet: Wallet) => WrappedSession, string];
    const CHECKS: Check[] = [
      ['signer', (wallet) => sessionFor(wallet, { isSignerReady: false }), 'no-signer'],
      ['chain', (wallet) => sessionFor(wallet, { chainId: 8453 }), 'discarded'],
      ['wrapper validation', (wallet) => sessionFor(wallet, { validation: 'not-canonical' }), 'not-canonical'],
      ['wrapper mapping', (wallet) => sessionFor(wallet, { cometAddress: USDT_COMET }), 'discarded'],
      ['screening', (wallet) => sessionFor(wallet, { screeningStatus: 'checking' }), 'discarded'],
      [
        'release controls',
        (wallet) => sessionFor(wallet, { registry: openRegistry({ deposits: false }) }),
        'discarded',
      ],
    ];

    it.each(CHECKS)(
      'rechecks signer, chain, wrapper, screening, release controls, and restrictions before each signature: %s',
      async (_name, changedSession, outcome) => {
        const { manager, requests } = fakeManager();
        const { result, rerender } = renderAction({ session: sessionFor(wallet), manager });
        await reachReview(result);
        await confirmAndWaitForWallet(result, requests, 1);
        await act(async () => requests[0].resolve({ status: 'submitted', id: 'id-1', hash: '0xapproval' }));
        act(() => requests[0].request.onSettled?.({ status: 'confirmed', receipt: receipt('0xapproval') }));
        // The supply waits for its own confirmation.
        expect(result.current.state).toMatchObject({ phase: 'review', current: 1 });

        rerender({ session: changedSession(wallet), manager });
        act(() => result.current.confirm());
        await act(async () => undefined);

        expect(manager.submitTransaction).toHaveBeenCalledTimes(1);
        if (outcome === 'discarded') {
          expect(result.current.state).toMatchObject({ phase: 'discarded', submittedHashes: ['0xapproval'] });
        } else {
          expect(result.current.state).toMatchObject({ phase: 'stopped', current: 1 });
          expect(result.current.state).toMatchObject({
            steps: [{ status: 'confirmed' }, { status: 'blocked', reason: outcome }],
          });
        }
      }
    );

    it('rechecks signer, chain, wrapper, screening, release controls, and restrictions before each signature: restrictions', async () => {
      const { manager, requests } = fakeManager();
      const restriction = jest.fn(async (): Promise<MarketRestriction | undefined> => undefined);
      const { result } = renderAction({ session: sessionFor(wallet), manager }, { restriction });
      await reachReview(result);
      await confirmAndWaitForWallet(result, requests, 1);
      await act(async () => requests[0].resolve({ status: 'submitted', id: 'id-1', hash: '0xapproval' }));
      act(() => requests[0].request.onSettled?.({ status: 'confirmed', receipt: receipt('0xapproval') }));

      restriction.mockResolvedValue('supply-paused');
      act(() => result.current.confirm());
      await waitFor(() => expect(result.current.state.phase).toBe('stopped'));

      expect(restriction).toHaveBeenCalledTimes(2);
      expect(manager.submitTransaction).toHaveBeenCalledTimes(1);
      expect(result.current.state).toMatchObject({
        steps: [{ status: 'confirmed' }, { status: 'blocked', reason: 'supply-paused' }],
      });
    });

    it('checks the first signature too, and sends nothing when the market is paused', async () => {
      const { manager } = fakeManager();
      const restriction = jest.fn(async (): Promise<MarketRestriction | undefined> => 'supply-paused');
      const { result } = renderAction({ session: sessionFor(wallet), manager }, { restriction });
      await reachReview(result);

      act(() => result.current.confirm());
      await waitFor(() => expect(result.current.state.phase).toBe('stopped'));

      expect(manager.submitTransaction).not.toHaveBeenCalled();
      expect(stepStatuses(result)).toEqual(['blocked', 'waiting']);
    });

    it('checks again after its reads, so a change during them stops the signature', async () => {
      const { manager } = fakeManager();
      let releaseRestriction: () => void = () => undefined;
      const restriction = jest.fn(
        () => new Promise<MarketRestriction | undefined>((resolve) => (releaseRestriction = () => resolve(undefined)))
      );
      const { result, rerender } = renderAction({ session: sessionFor(wallet), manager }, { restriction });
      await reachReview(result);

      act(() => result.current.confirm());
      expect(stepStatuses(result)).toEqual(['checking', 'waiting']);
      rerender({ session: sessionFor(wallet, { account: OTHER_ACCOUNT }), manager });
      await act(async () => releaseRestriction());

      expect(manager.submitTransaction).not.toHaveBeenCalled();
      expect(result.current.state.phase).toBe('discarded');
    });

    it('checks again after its reads, so a signer that stops being ready during them is caught', async () => {
      const { manager } = fakeManager();
      let releaseRestriction: () => void = () => undefined;
      const restriction = jest.fn(
        () => new Promise<MarketRestriction | undefined>((resolve) => (releaseRestriction = () => resolve(undefined)))
      );
      const { result, rerender } = renderAction({ session: sessionFor(wallet), manager }, { restriction });
      await reachReview(result);

      act(() => result.current.confirm());
      // The wallet provider is now one built for an earlier connector client.
      rerender({ session: sessionFor(wallet, { isSignerReady: false }), manager });
      await act(async () => releaseRestriction());
      await act(async () => undefined);

      expect(manager.submitTransaction).not.toHaveBeenCalled();
      expect(result.current.state).toMatchObject({
        phase: 'stopped',
        steps: [{ status: 'blocked', reason: 'no-signer' }, { status: 'waiting' }],
      });
    });

    it('makes no reads for a signature the live session already refuses', async () => {
      const { manager } = fakeManager();
      const restriction = jest.fn(async (): Promise<MarketRestriction | undefined> => undefined);
      const { result, rerender } = renderAction({ session: sessionFor(wallet), manager }, { restriction });
      await reachReview(result);
      rerender({ session: sessionFor(wallet, { isSignerReady: false }), manager });
      const readsBeforeConfirming = wallet.send.mock.calls.length;

      act(() => result.current.confirm());
      await act(async () => undefined);

      expect(result.current.state).toMatchObject({
        steps: [{ status: 'blocked', reason: 'no-signer' }, { status: 'waiting' }],
      });
      expect(restriction).not.toHaveBeenCalled();
      expect(wallet.send).toHaveBeenCalledTimes(readsBeforeConfirming);
    });

    it("runs the step's own check just before signing and stops when it refuses", async () => {
      const { manager } = fakeManager();
      const check = jest.fn(async () => ({ ok: false as const, message: 'Simulation reverted: ZeroSharesMinted()' }));
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      act(() => {
        result.current.start('supply', async () => ({ amount: 1_000_000n, steps: [{ ...SUPPLY, check }] }));
      });
      await waitFor(() => expect(result.current.state.phase).toBe('review'));

      act(() => result.current.confirm());
      await waitFor(() => expect(result.current.state.phase).toBe('stopped'));

      expect(check).toHaveBeenCalledTimes(1);
      expect(manager.submitTransaction).not.toHaveBeenCalled();
      expect(result.current.state).toMatchObject({
        steps: [{ status: 'blocked', reason: 'step-check-failed', message: 'Simulation reverted: ZeroSharesMinted()' }],
      });
    });

    it('treats a step check that throws as a refusal', async () => {
      const { manager } = fakeManager();
      const check = jest.fn(async () => Promise.reject(new Error('execution reverted')));
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      act(() => {
        result.current.start('supply', async () => ({ amount: 1_000_000n, steps: [{ ...SUPPLY, check }] }));
      });
      await waitFor(() => expect(result.current.state.phase).toBe('review'));

      act(() => result.current.confirm());
      await waitFor(() => expect(result.current.state.phase).toBe('stopped'));

      expect(manager.submitTransaction).not.toHaveBeenCalled();
      expect(result.current.state).toMatchObject({
        steps: [{ status: 'blocked', reason: 'step-check-failed', message: 'execution reverted' }],
      });
    });

    it("signs once the step's own check passes", async () => {
      const { manager, requests } = fakeManager();
      const check = jest.fn(async () => ({ ok: true as const }));
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      act(() => {
        result.current.start('supply', async () => ({ amount: 1_000_000n, steps: [{ ...SUPPLY, check }] }));
      });
      await waitFor(() => expect(result.current.state.phase).toBe('review'));

      await confirmAndWaitForWallet(result, requests, 1);

      expect(check).toHaveBeenCalledTimes(1);
      expect(requests[0].request.step).toBe('supply');
    });

    it("reads Comet's pause through the configured chain's provider, and refuses without one", async () => {
      const PAUSES = new Interface(['function isSupplyPaused() view returns (bool)']);
      const readProvider = {
        call: jest.fn(async ({ to }: { to?: string }) => {
          if (to !== USDC_COMET) throw new Error('not the Comet');
          return PAUSES.encodeFunctionResult('isSupplyPaused', [true]);
        }),
      };
      const { manager } = fakeManager();
      const { result, rerender } = renderHook(
        ({ reader }: { reader: typeof readProvider | undefined }) =>
          useWrappedAction({ session: sessionFor(wallet), manager, readProvider: reader }),
        { initialProps: { reader: readProvider as typeof readProvider | undefined } }
      );
      await reachReview(result);

      act(() => result.current.confirm());
      await waitFor(() => expect(result.current.state.phase).toBe('stopped'));
      expect(readProvider.call).toHaveBeenCalledTimes(1);
      expect(result.current.state).toMatchObject({
        steps: [{ status: 'blocked', reason: 'supply-paused' }, { status: 'waiting' }],
      });

      rerender({ reader: undefined });
      act(() => result.current.discard());
      await reachReview(result);
      act(() => result.current.confirm());
      await waitFor(() => expect(result.current.state.phase).toBe('stopped'));
      expect(result.current.state).toMatchObject({
        steps: [{ status: 'blocked', reason: 'restriction-unknown' }, { status: 'waiting' }],
      });
      expect(manager.submitTransaction).not.toHaveBeenCalled();
    });

    it('reads through the wallet immediately before each signature', async () => {
      const { manager, requests } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);
      const readsBeforeConfirming = wallet.send.mock.calls.length;

      await confirmAndWaitForWallet(result, requests, 1);

      expect(wallet.send.mock.calls.slice(readsBeforeConfirming).map(([method]) => method)).toEqual([
        'eth_chainId',
        'eth_blockNumber',
      ]);
    });

    it('reports a read that throws as a failed read', async () => {
      const { manager } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });

      act(() => {
        result.current.start('supply', () => {
          throw new Error('Allowance read failed');
        });
      });

      expect(result.current.state).toMatchObject({ phase: 'reading' });
      await waitFor(() =>
        expect(result.current.state).toMatchObject({ phase: 'read-failed', message: 'Allowance read failed' })
      );
    });

    it("refuses a step that does not call the reviewed market's own contracts", async () => {
      const { manager } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      const toAnotherWrapper: WrappedStep = { ...SUPPLY, request: { ...SUPPLY.request, to: USDT_WRAPPER } };

      act(() => {
        result.current.start('supply', async () => ({ amount: 1n, steps: [toAnotherWrapper] }));
      });
      await waitFor(() => expect(result.current.state.phase).toBe('read-failed'));

      expect(manager.submitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('unusable sessions', () => {
    it('provider failure after an extension update disables submission and offers reload/reconnect', async () => {
      const { manager } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      await waitFor(() => expect(result.current.session.status).toBe('usable'));
      await reachReview(result);

      // The extension updates under the open tab. The page still shows the wallet as connected.
      wallet.readError = BROKEN_EXTENSION;
      act(() => result.current.confirm());
      await waitFor(() => expect(result.current.session.status).toBe('unusable'));

      expect(manager.submitTransaction).not.toHaveBeenCalled();
      expect(result.current.state).toMatchObject({
        phase: 'stopped',
        steps: [{ status: 'blocked', reason: 'session-unusable' }, { status: 'waiting' }],
      });
      expect(result.current.session).toMatchObject({
        reason: 'provider-broken',
        instruction: expect.stringMatching(/Reload the page and reconnect your wallet/),
      });
      expect(result.current.blockedReason('supply')).toBe('session-unusable');
      expect(result.current.start('supply', prepareSupply)).toBe('session-unusable');
    });

    it('provider failure after an extension update disables submission and offers reload/reconnect: reported by another write', async () => {
      const { manager } = fakeManager();
      const { result, rerender } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);

      // A direct repay through the same wallet found it broken.
      rerender({
        session: sessionFor(wallet),
        manager: { ...manager, walletFailure: { provider: wallet, message: 'sendMessage' } },
      });

      expect(result.current.session).toMatchObject({ status: 'unusable', reason: 'provider-broken' });
      await waitFor(() => expect(result.current.state.phase).toBe('stopped'));
      act(() => result.current.confirm());
      expect(manager.submitTransaction).not.toHaveBeenCalled();
    });

    it('provider failure after an extension update disables submission and offers reload/reconnect: found when sending', async () => {
      const { manager, requests } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);
      await confirmAndWaitForWallet(result, requests, 1);

      await act(async () => requests[0].resolve({ status: 'session-broken', message: 'sendMessage' }));

      expect(result.current.session).toMatchObject({ status: 'unusable', reason: 'provider-broken' });
      expect(stepStatuses(result)).toEqual(['provider-failure', 'waiting']);
      expect(result.current.blockedReason('supply')).toBe('session-unusable');
    });

    it('an acknowledged network switch with failed reads remains unusable', async () => {
      const { manager } = fakeManager();
      const { result, rerender } = renderAction({ session: sessionFor(wallet), manager });
      await waitFor(() => expect(result.current.session.status).toBe('usable'));

      // The wallet acknowledges a switch to Base it cannot serve: chainChanged fires, reads fail.
      wallet.chainId = 8453;
      wallet.readError = { code: -32603, message: 'Internal error' };
      rerender({ session: sessionFor(wallet, { chainId: 8453 }), manager });
      await waitFor(() => expect(result.current.session.status).toBe('unusable'));
      expect(result.current.session).toMatchObject({
        reason: 'reads-failing',
        instruction: expect.stringMatching(/Reload the page and reconnect your wallet/),
      });

      // It acknowledges the switch back too, but its reads still fail.
      wallet.chainId = 1;
      rerender({ session: sessionFor(wallet), manager });
      await waitFor(() => expect(result.current.session.status).toBe('unusable'));
      rerender({ session: sessionFor(wallet), manager });

      expect(result.current.session).toMatchObject({ status: 'unusable', reason: 'reads-failing' });
      expect(result.current.start('supply', prepareSupply)).toBe('session-unusable');
      expect(manager.submitTransaction).not.toHaveBeenCalled();
    });

    it('treats a session check that throws as unusable', async () => {
      const { manager } = fakeManager();
      const probe = jest.fn<Promise<SessionProbeResult>, []>().mockRejectedValue(new Error('probe failed'));
      const { result } = renderAction({ session: sessionFor(wallet), manager }, { probe });

      await waitFor(() =>
        expect(result.current.session).toMatchObject({ status: 'unusable', reason: 'reads-failing' })
      );
    });

    it('stays unusable when an earlier, slower read through the same session succeeds', async () => {
      const { manager } = fakeManager();
      let finishFirstProbe: (result: SessionProbeResult) => void = () => undefined;
      const probe = jest
        .fn<Promise<SessionProbeResult>, []>()
        .mockImplementationOnce(() => new Promise((resolve) => (finishFirstProbe = resolve)))
        .mockResolvedValue({ status: 'unusable', reason: 'provider-broken' });
      const { result } = renderAction({ session: sessionFor(wallet), manager }, { probe });
      await reachReview(result);

      act(() => result.current.confirm());
      await waitFor(() => expect(result.current.session.status).toBe('unusable'));
      await act(async () => finishFirstProbe({ status: 'usable' }));

      expect(result.current.session).toMatchObject({ status: 'unusable', reason: 'provider-broken' });
      expect(manager.submitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('submission outcomes', () => {
    it('shows awaiting the wallet until it returns a hash, then the broadcast hash', async () => {
      const { manager, requests } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);

      await confirmAndWaitForWallet(result, requests, 1);
      expect(result.current.state).toMatchObject({
        phase: 'signing',
        steps: [{ status: 'awaiting-signature' }, { status: 'waiting' }],
      });

      await act(async () => requests[0].resolve({ status: 'submitted', id: 'id-1', hash: '0xapproval' }));
      expect(result.current.state).toMatchObject({
        phase: 'signing',
        steps: [{ status: 'submitted', hash: '0xapproval' }, { status: 'waiting' }],
      });
    });

    it('signs each step only after its own confirmation, through the wallet, from the reviewed account', async () => {
      const { manager, requests } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);
      await confirmAndWaitForWallet(result, requests, 1);

      expect(requests[0].request).toMatchObject({ key: USDC_WRAPPER, step: 'approve', account: ACCOUNT, chainId: 1 });
      await expect(requests[0].request.send()).resolves.toBe('0xsent');
      expect(wallet.getSigner).toHaveBeenCalledWith(ACCOUNT);
      expect(wallet.sendUncheckedTransaction).toHaveBeenCalledWith({ ...APPROVE.request, chainId: 1 });

      await act(async () => requests[0].resolve({ status: 'submitted', id: 'id-1', hash: '0xapproval' }));
      act(() => requests[0].request.onSettled?.({ status: 'confirmed', receipt: receipt('0xapproval') }));
      await act(async () => undefined);
      expect(requests).toHaveLength(1);

      await confirmAndWaitForWallet(result, requests, 2);
      expect(requests[1].request).toMatchObject({ key: USDC_WRAPPER, step: 'supply' });
      await requests[1].request.send();
      expect(wallet.sendUncheckedTransaction).toHaveBeenLastCalledWith({ ...SUPPLY.request, chainId: 1 });
      await act(async () => requests[1].resolve({ status: 'submitted', id: 'id-2', hash: '0xsupply' }));
      act(() => requests[1].request.onSettled?.({ status: 'confirmed', receipt: receipt('0xsupply') }));

      expect(result.current.state.phase).toBe('complete');
    });

    it.each<[string, SendResult | 'reverted' | 'replaced', string]>([
      ['a rejection', { status: 'rejected' }, 'rejected'],
      [
        'a provider error (not proof of rejection)',
        { status: 'provider-failure', message: 'Internal error (-32603)' },
        'provider-failure',
      ],
      ['a revert', 'reverted', 'reverted'],
      ['a replacement', 'replaced', 'replaced'],
    ])('stops on %s without retrying or sending the next step', async (_name, outcome, status) => {
      const { manager, requests } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);
      await confirmAndWaitForWallet(result, requests, 1);

      await act(async () => {
        if (typeof outcome !== 'string') {
          requests[0].resolve(outcome);
          return;
        }
        requests[0].resolve({ status: 'submitted', id: 'id-1', hash: '0xapproval' });
        await Promise.resolve();
        requests[0].request.onSettled?.(
          outcome === 'reverted' ? { status: 'reverted', receipt: receipt('0xapproval', 0) } : { status: 'replaced' }
        );
      });
      await act(async () => undefined);

      expect(result.current.state).toMatchObject({ phase: 'stopped', current: 0 });
      expect(stepStatuses(result)).toEqual([status, 'waiting']);
      expect(manager.submitTransaction).toHaveBeenCalledTimes(1);
    });

    it('keeps an outcome that arrives before the hash it belongs to is recorded', async () => {
      const { manager, requests } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);
      await confirmAndWaitForWallet(result, requests, 1);

      await act(async () => {
        requests[0].request.onSettled?.({ status: 'confirmed', receipt: receipt('0xapproval') });
        requests[0].resolve({ status: 'submitted', id: 'id-1', hash: '0xapproval' });
      });

      expect(result.current.state).toMatchObject({ phase: 'review', current: 1 });
      expect(stepStatuses(result)).toEqual(['confirmed', 'waiting']);
    });

    it('reports an open wallet request as a provider failure when the session breaks', async () => {
      const { manager, requests } = fakeManager();
      const { result, rerender } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);
      await confirmAndWaitForWallet(result, requests, 1);

      rerender({
        session: sessionFor(wallet),
        manager: { ...manager, walletFailure: { provider: wallet, message: 'sendMessage' } },
      });
      await waitFor(() => expect(result.current.state.phase).toBe('stopped'));

      expect(result.current.state).toMatchObject({
        steps: [
          { status: 'provider-failure', message: expect.stringMatching(/may still be approved in the wallet/) },
          { status: 'waiting' },
        ],
      });
    });

    it('stops a step the transaction manager refuses because the session moved on', async () => {
      const { manager, requests } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);
      await confirmAndWaitForWallet(result, requests, 1);

      await act(async () => requests[0].resolve({ status: 'session-changed' }));

      expect(result.current.state).toMatchObject({
        phase: 'stopped',
        steps: [{ status: 'blocked', reason: 'identity-changed' }, { status: 'waiting' }],
      });
    });

    it('marks a broadcast step unresolved when the session breaks before its receipt', async () => {
      const { manager, requests } = fakeManager();
      const { result, rerender } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);
      await confirmAndWaitForWallet(result, requests, 1);
      await act(async () => requests[0].resolve({ status: 'submitted', id: 'id-1', hash: '0xapproval' }));

      rerender({
        session: sessionFor(wallet),
        manager: { ...manager, walletFailure: { provider: wallet, message: 'sendMessage' } },
      });
      await waitFor(() => expect(result.current.state.phase).toBe('stopped'));

      expect(result.current.state).toMatchObject({
        steps: [{ status: 'unresolved', hash: '0xapproval' }, { status: 'waiting' }],
      });
    });

    it.each<[string, (wallet: Wallet) => WrappedSession | 'discard', string]>([
      ['the draft is cleared', () => 'discard', 'discarded'],
      ['the account changes', (wallet) => sessionFor(wallet, { account: OTHER_ACCOUNT }), 'discarded'],
      ['the signer stops being ready', (wallet) => sessionFor(wallet, { isSignerReady: false }), 'no-signer'],
    ])(
      'withdraws the request before the wallet is asked when %s while the manager prepares it',
      async (_name, change, outcome) => {
        const { manager, requests } = fakeManager();
        const { result, rerender } = renderAction({ session: sessionFor(wallet), manager });
        await reachReview(result);
        // The manager has the request and is reading the network and nonce; it has not called send.
        await confirmAndWaitForWallet(result, requests, 1);

        const changed = change(wallet);
        if (changed === 'discard') act(() => result.current.discard());
        else rerender({ session: changed, manager });

        await expect(requests[0].request.send()).rejects.toBeInstanceOf(SendWithdrawnError);
        expect(wallet.sendUncheckedTransaction).not.toHaveBeenCalled();
        await act(async () => requests[0].resolve({ status: 'session-changed' }));
        if (outcome === 'discarded') {
          expect(result.current.state.phase).toBe('discarded');
        } else {
          expect(result.current.state).toMatchObject({
            phase: 'stopped',
            steps: [{ status: 'blocked', reason: outcome }, { status: 'waiting' }],
          });
        }
      }
    );

    it('sends the call it checked, even if the step it was given changes afterwards', async () => {
      const { manager, requests } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      const supply: WrappedStep = { ...SUPPLY, request: { ...SUPPLY.request } };
      act(() => {
        result.current.start('supply', async () => ({ amount: 1_000_000n, steps: [supply] }));
      });
      await waitFor(() => expect(result.current.state.phase).toBe('review'));

      supply.request.to = USDC_COMET;
      supply.request.data = CALLS.encodeFunctionData('supplyAndWrap', [1n]);
      await confirmAndWaitForWallet(result, requests, 1);
      await requests[0].request.send();

      expect(wallet.sendUncheckedTransaction).toHaveBeenCalledWith({ ...SUPPLY.request, chainId: 1 });
      const { state } = result.current;
      if (state.phase !== 'signing') throw new Error('the step must be signing');
      expect(Object.isFrozen(state.draft.steps[0].request)).toBe(true);
    });

    it('clears a draft without cancelling what the wallet already has', async () => {
      const { manager, requests } = fakeManager();
      const { result } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);
      await confirmAndWaitForWallet(result, requests, 1);

      act(() => result.current.discard());
      expect(result.current.state).toEqual({
        phase: 'discarded',
        reason: 'cleared',
        submittedHashes: [],
        isWalletRequestOpen: true,
      });

      await act(async () => requests[0].resolve({ status: 'submitted', id: 'id-1', hash: '0xapproval' }));
      expect(result.current.state.phase).toBe('discarded');
      act(() => result.current.discard());
      expect(result.current.state).toEqual({ phase: 'idle' });
    });
  });

  describe('recovery', () => {
    function wrapperTransaction(overrides: Partial<PendingTransaction> = {}): PendingTransaction {
      return {
        id: 'restored',
        key: USDC_WRAPPER,
        networkId: 1,
        networkName: 'homestead',
        description: 'Approve USDC for the wrapper',
        nonce: 7,
        account: ACCOUNT,
        step: 'approve',
        state: TransactionState.Pending,
        hash: '0xrestored',
        ...overrides,
      };
    }

    it('requires an earlier wrapper transaction to settle before a fresh review, and resumes nothing', async () => {
      const { manager } = fakeManager();
      const pending = wrapperTransaction();
      const { result, rerender } = renderAction({
        session: sessionFor(wallet),
        manager: { ...manager, transactions: [pending] },
      });

      expect(result.current.recovered.pending).toEqual([pending]);
      expect(result.current.start('supply', prepareSupply)).toBe('transaction-pending');

      const settled: SettledTransaction = {
        ...pending,
        outcome: { status: 'confirmed', receipt: receipt('0xrestored') },
      };
      rerender({
        session: sessionFor(wallet),
        manager: { ...manager, transactions: [], settledTransactions: [settled] },
      });

      expect(result.current.recovered.settled).toEqual([settled]);
      expect(result.current.state.phase).toBe('idle');
      expect(manager.submitTransaction).not.toHaveBeenCalled();
      await reachReview(result);
      expect(stepStatuses(result)).toEqual(['waiting', 'waiting']);
    });

    it('waits for a wallet request left open at a reload, until the user dismisses it', () => {
      const { manager } = fakeManager();
      const interrupted: Transaction = {
        id: 'interrupted',
        key: USDC_WRAPPER,
        networkId: 1,
        networkName: 'homestead',
        description: 'Supply USDC through the wrapper',
        nonce: 7,
        account: ACCOUNT,
        step: 'supply',
        state: TransactionState.AwaitingConfirmation,
        isInterrupted: true,
      };
      const { result } = renderAction({
        session: sessionFor(wallet),
        manager: { ...manager, transactions: [interrupted] },
      });

      expect(result.current.start('supply', prepareSupply)).toBe('transaction-pending');
      act(() => result.current.dismissRecovered());

      expect(manager.dismissTransaction).toHaveBeenCalledWith('interrupted');
      expect(manager.submitTransaction).not.toHaveBeenCalled();
    });

    it('does not dismiss anything while a draft is in progress', async () => {
      const { manager, requests } = fakeManager();
      const { result, rerender } = renderAction({ session: sessionFor(wallet), manager });
      await reachReview(result);
      await confirmAndWaitForWallet(result, requests, 1);
      // The manager now holds the step's own record, awaiting the wallet.
      const inFlight = wrapperTransaction({ id: 'in-flight' });
      rerender({ session: sessionFor(wallet), manager: { ...manager, transactions: [inFlight] } });

      act(() => result.current.dismissRecovered());

      expect(manager.dismissTransaction).not.toHaveBeenCalled();
    });

    it("ignores other accounts', chains' and contracts' transactions", () => {
      const { manager } = fakeManager();
      const transactions = [
        wrapperTransaction({ id: 'a', account: OTHER_ACCOUNT }),
        wrapperTransaction({ id: 'b', networkId: 8453 }),
        wrapperTransaction({ id: 'c', key: USDC_COMET }),
      ];
      const { result } = renderAction({ session: sessionFor(wallet), manager: { ...manager, transactions } });

      expect(result.current.recovered.pending).toEqual([]);
      expect(result.current.blockedReason('supply')).toBeUndefined();
    });
  });

  it('refuses to start outside the wrapped route or when the release control is off', () => {
    const { manager } = fakeManager();
    const standard: WrappedSession = {
      ...sessionFor(wallet),
      route: { kind: 'standard', writes: { isEligible: true } },
    };
    const { result, rerender } = renderAction({ session: standard, manager });

    expect(result.current.start('supply', prepareSupply)).toBe('not-wrapped');
    expect(result.current.session).toEqual({ status: 'not-applicable' });

    rerender({ session: sessionFor(wallet, { registry: openRegistry({ deposits: false }) }), manager });
    expect(result.current.start('supply', prepareSupply)).toBe('deposits-disabled');
    expect(result.current.state).toEqual({ phase: 'idle' });
  });
});

import { JsonRpcProvider, TransactionResponse } from '@ethersproject/providers';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BigNumber } from 'ethers';

import { Web3 } from '@contexts/Web3Context';
import { TRANSACTION_LOCALSTORAGE_KEY } from '@helpers/constants';
import { TRX_REFRESH_INTERVAL } from '@helpers/numbers';
import { NotSentError, SendWithdrawnError } from '@helpers/walletErrors';
import { SendResult, useTransactionManager } from '@hooks/useTransactionManager';
import { PendingTransaction, SettledTransaction, Transaction, TransactionState } from '@types';

import { mockWeb3 } from '../mocks/mockWeb3';

// uuid ships ESM only, which Jest does not load here.
let mockNextId = 0;
jest.mock('uuid', () => ({ v4: () => `transaction-${++mockNextId}` }));

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000bb2';
const WRAPPER = '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73';
const COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const BROKEN_EXTENSION = new TypeError("Cannot read properties of undefined (reading 'sendMessage')");

/** A transaction hash made from a label, so that the test reads by name. */
function tx(label: string): string {
  return `0x${Buffer.from(label).toString('hex').padEnd(64, '0')}`;
}

type Chain = {
  chainId?: number;
  /** Mined transactions, by hash, with their receipt status. */
  receipts?: Record<string, number>;
  /** Transactions the node knows, by hash, with their nonce. */
  known?: Record<string, number>;
  /** Each account's confirmed nonce, by lower-case address. */
  confirmedNonces?: Record<string, number>;
};

/**
 * A stand-in for the wallet provider, answering from `chain`. Like ethers' Web3Provider, it can
 * leave `network` undefined until `getNetwork` has asked the wallet, `networkDelayMs` later.
 */
function walletProvider(chain: Chain = {}, { networkDelayMs }: { networkDelayMs?: number } = {}) {
  const chainId = chain.chainId ?? 1;
  const detected = { chainId, name: chainId === 1 ? 'homestead' : 'matic' };
  const provider = {
    network: networkDelayMs === undefined ? detected : (undefined as typeof detected | undefined),
    getNetwork: jest.fn(async () => {
      if (networkDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, networkDelayMs));
      provider.network = detected;
      return detected;
    }),
    getTransactionReceipt: jest.fn(async (hash: string) =>
      chain.receipts?.[hash] === undefined ? null : { transactionHash: hash, status: chain.receipts[hash] }
    ),
    getTransaction: jest.fn(async (hash: string) =>
      chain.known?.[hash] === undefined ? null : { hash, nonce: chain.known[hash] }
    ),
    getTransactionCount: jest.fn(async (address: string) => chain.confirmedNonces?.[address.toLowerCase()] ?? 0),
    getSigner: jest.fn(),
    send: jest.fn(),
  };
  return provider;
}
type WalletProvider = ReturnType<typeof walletProvider>;

function web3For(account: string | undefined, provider: WalletProvider): Web3 {
  return {
    ...mockWeb3,
    write: { ...mockWeb3.write, account, provider: provider as unknown as JsonRpcProvider },
  };
}

function storedRecord(hash: string, overrides: Partial<PendingTransaction> = {}): PendingTransaction {
  return {
    id: `id-${hash}`,
    key: COMET,
    networkId: 1,
    networkName: 'homestead',
    description: `Transaction ${hash}`,
    nonce: 0,
    account: ACCOUNT,
    state: TransactionState.Pending,
    hash,
    ...overrides,
  };
}

function store(records: unknown[]) {
  window.localStorage.setItem(TRANSACTION_LOCALSTORAGE_KEY, JSON.stringify(records));
}

function storedHashes(): string[] {
  const records: { hash?: string }[] = JSON.parse(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY) ?? '[]');
  return records.map((record) => record.hash ?? '').sort();
}

/** What a wallet returns for a sent transaction. A `connectUnchecked` signer returns no nonce. */
function sent(hash: string, nonce: number | null) {
  return async () => ({ hash, nonce } as unknown as TransactionResponse);
}

function hashes(transactions: Transaction[]): (string | undefined)[] {
  return transactions.map((tx) => (tx.state === TransactionState.Pending ? tx.hash : undefined));
}

function outcomes(settled: SettledTransaction[]): Record<string, string> {
  return Object.fromEntries(settled.map((transaction) => [transaction.hash, transaction.outcome.status]));
}

type Props = { web3: Web3 };

/** Lets every pending lookup and the next poll finish. */
async function settleLookups() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

function renderManager(web3: Web3) {
  return renderHook(({ web3 }: Props) => useTransactionManager(web3), { initialProps: { web3 } });
}

describe('useTransactionManager', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('restores submitted hashes for the originating account and chain without replaying an unsigned next step', async () => {
    store([
      // The approval step of a wrapper supply, mined. The supply step after it was never signed.
      storedRecord(tx('approved'), { key: WRAPPER, step: 'approve' }),
      storedRecord(tx('reverted')),
      storedRecord(tx('replaced'), { nonce: 4 }),
      storedRecord(tx('unresolved'), { nonce: 9 }),
      storedRecord(tx('other-account'), { account: OTHER_ACCOUNT, nonce: 300 }),
      storedRecord(tx('other-chain'), { networkId: 137, networkName: 'matic' }),
    ]);
    const provider = walletProvider({
      receipts: { [tx('approved')]: 1, [tx('reverted')]: 0 },
      confirmedNonces: { [ACCOUNT]: 7, [OTHER_ACCOUNT]: 250 },
    });

    const { result, rerender } = renderManager(web3For(ACCOUNT, provider));

    await waitFor(() => expect(result.current.settledTransactions).toHaveLength(3));
    expect(outcomes(result.current.settledTransactions)).toEqual({
      [tx('approved')]: 'confirmed',
      [tx('reverted')]: 'reverted',
      [tx('replaced')]: 'replaced',
    });
    expect(result.current.settledTransactions.find((settled) => settled.hash === tx('approved'))).toMatchObject({
      account: ACCOUNT,
      networkId: 1,
      key: WRAPPER,
      step: 'approve',
    });
    // Still pending: the sender's confirmed nonce has not passed it.
    expect(hashes(result.current.transactions)).toEqual([tx('unresolved')]);
    // Replacement is judged by the nonce of the account that sent the transaction.
    expect(provider.getTransactionCount.mock.calls.every(([address]) => address === ACCOUNT)).toBe(true);
    // Nothing was signed or sent, so the step after the approval was not replayed.
    expect(provider.getSigner).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
    // Settled records are gone. The other account's and the other chain's stay for when they return.
    expect(storedHashes()).toEqual([tx('other-account'), tx('other-chain'), tx('unresolved')]);

    rerender({ web3: web3For(OTHER_ACCOUNT, provider) });
    await waitFor(() =>
      expect(hashes(result.current.transactions).sort()).toEqual([tx('other-account'), tx('unresolved')])
    );
    expect(storedHashes()).toEqual([tx('other-account'), tx('other-chain'), tx('unresolved')]);
  });

  it('tracks each stored transaction before its lookup finishes, in the render that names the restored session', async () => {
    store([storedRecord(tx('supply'), { key: WRAPPER, step: 'supply', nonce: 9, nonceSource: 'transaction' })]);
    const provider = walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } });
    let finishLookup: (receipt: null) => void = () => undefined;
    provider.getTransactionReceipt.mockImplementation(() => new Promise((resolve) => (finishLookup = resolve)));
    const rendered: { isRestored: boolean; tracked: (string | undefined)[] }[] = [];
    const { result } = renderHook(() => {
      const manager = useTransactionManager(web3For(ACCOUNT, provider));
      rendered.push({ isRestored: manager.restoredSession !== undefined, tracked: hashes(manager.transactions) });
      return manager;
    });

    await waitFor(() => expect(provider.getTransactionReceipt).toHaveBeenCalledWith(tx('supply')));
    expect(result.current.restoredSession).toEqual({ provider, account: ACCOUNT, chainId: 1 });
    expect(hashes(result.current.transactions)).toEqual([tx('supply')]);
    // No render names the session restored without the transaction it restored.
    expect(rendered.filter((render) => render.isRestored).every((render) => render.tracked.length === 1)).toBe(true);

    await act(async () => finishLookup(null));
    expect(hashes(result.current.transactions)).toEqual([tx('supply')]);
  });

  it('names no restored session until it can read the chain, and tries again, sooner at first', async () => {
    jest.useFakeTimers();
    try {
      store([storedRecord(tx('unresolved'), { nonce: 9 })]);
      const provider = walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } });
      provider.getNetwork
        .mockRejectedValueOnce(new Error('could not detect network'))
        .mockRejectedValueOnce(new Error('could not detect network'));
      const { result } = renderManager(web3For(ACCOUNT, provider));
      // The first attempt fails, and so does the second, a second later.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_500);
      });
      expect(provider.getNetwork).toHaveBeenCalledTimes(2);
      expect(result.current.restoredSession).toBeUndefined();
      expect(result.current.transactions).toEqual([]);

      // The wait doubles, so nothing more is tried in the next second.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
      });
      expect(provider.getNetwork).toHaveBeenCalledTimes(2);

      // The third attempt, two seconds after the second, succeeds.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
      });
      expect(provider.getNetwork).toHaveBeenCalledTimes(3);
      expect(result.current.restoredSession).toEqual({ provider, account: ACCOUNT, chainId: 1 });
      expect(hashes(result.current.transactions)).toEqual([tx('unresolved')]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('restores each transaction once when the wallet provider is rebuilt', async () => {
    store([storedRecord(tx('unresolved'), { nonce: 9 })]);
    const chain = { confirmedNonces: { [ACCOUNT]: 7 } };
    const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
    await waitFor(() => expect(result.current.transactions).toHaveLength(1));

    const rebuilt = walletProvider(chain);
    rerender({ web3: web3For(ACCOUNT, rebuilt) });
    await waitFor(() => expect(rebuilt.getTransactionReceipt).toHaveBeenCalled());
    await settleLookups();

    expect(result.current.transactions).toHaveLength(1);
  });

  it('drops stored records it can never recover: no hash, or no sender', async () => {
    store([
      { ...storedRecord(tx('legacy')), account: undefined },
      { ...storedRecord(tx('awaiting')), state: TransactionState.AwaitingConfirmation, hash: undefined },
      storedRecord(tx('unresolved'), { nonce: 9 }),
    ]);
    const provider = walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } });
    const { result } = renderManager(web3For(ACCOUNT, provider));

    await waitFor(() => expect(provider.getTransactionReceipt).toHaveBeenCalled());
    await settleLookups();
    expect(hashes(result.current.transactions)).toEqual([tx('unresolved')]);
    expect(storedHashes()).toEqual([tx('unresolved')]);
  });

  it('judges replacement by the nonce of the account that sent the transaction', async () => {
    const chain = { confirmedNonces: { [ACCOUNT]: 7, [OTHER_ACCOUNT]: 100 } };
    const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
    await act(async () => {
      await result.current.addTransaction(COMET, 'Borrow USDC', sent(tx('sent'), null), 100_000, jest.fn(), []);
    });

    const otherWallet = walletProvider(chain);
    rerender({ web3: web3For(OTHER_ACCOUNT, otherWallet) });
    await waitFor(() => expect(otherWallet.getTransactionCount).toHaveBeenCalled());

    expect(otherWallet.getTransactionCount.mock.calls.every(([address]) => address === ACCOUNT)).toBe(true);
    expect(hashes(result.current.transactions)).toEqual([tx('sent')]);
  });

  it('uses the nonce the node reports for the transaction when it has one', async () => {
    // The wallet queues the transaction behind an earlier one, so it is sent with nonce 8 although
    // the confirmed nonce read before sending was 7.
    const chain: Chain = { known: { [tx('queued')]: 8 }, confirmedNonces: { [ACCOUNT]: 7 } };
    const provider = walletProvider(chain);
    const { result } = renderManager(web3For(ACCOUNT, provider));
    const sendQueuedTransaction = async () => {
      // The earlier transaction is mined while the wallet sends this one.
      chain.confirmedNonces = { [ACCOUNT]: 8 };
      return sent(tx('queued'), null)();
    };
    await act(async () => {
      await result.current.addTransaction(COMET, 'Borrow USDC', sendQueuedTransaction, 1, jest.fn(), []);
    });

    // The node's nonce for the transaction replaces the lower bound, in memory and in storage.
    await waitFor(() =>
      expect(result.current.transactions).toEqual([expect.objectContaining({ nonce: 8, nonceSource: 'transaction' })])
    );
    await settleLookups();

    expect(hashes(result.current.transactions)).toEqual([tx('queued')]);
    expect(result.current.settledTransactions).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY) ?? '[]')).toEqual([
      expect.objectContaining({ hash: tx('queued'), nonce: 8, nonceSource: 'transaction' }),
    ]);
  });

  it('ignores a reported nonce below the one read before sending, as a Safe reports before it executes', async () => {
    // A Safe's provider reports nonce 0 for a transaction its owners have not executed, and the Safe
    // contract's own account nonce, 1, as the confirmed nonce.
    const chain: Chain = { known: { [tx('queued')]: 0, [tx('approval')]: 0 }, confirmedNonces: { [ACCOUNT]: 1 } };
    const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
    const onSettled = jest.fn();
    await act(async () => {
      await result.current.addTransaction(
        COMET,
        'Borrow USDC',
        sent(tx('queued'), null),
        1,
        jest.fn(),
        [],
        0n,
        onSettled
      );
      await result.current.submitTransaction({
        key: WRAPPER,
        description: 'Approve USDC',
        step: 'approve',
        send: async () => tx('approval'),
      });
    });
    await settleLookups();

    expect(result.current.settledTransactions).toEqual([]);
    expect(onSettled).not.toHaveBeenCalled();
    // Still pending, and the reported nonce was not kept as either transaction's own.
    expect(result.current.transactions).toEqual([
      expect.objectContaining({ hash: tx('queued'), nonce: 1, nonceSource: 'lower-bound' }),
      expect.objectContaining({ hash: tx('approval'), nonce: 1, nonceSource: 'lower-bound' }),
    ]);

    // The owners execute both. Each one settles by its receipt.
    chain.receipts = { [tx('queued')]: 1, [tx('approval')]: 1 };
    rerender({ web3: web3For(ACCOUNT, walletProvider(chain)) });
    await waitFor(() =>
      expect(outcomes(result.current.settledTransactions)).toEqual({
        [tx('queued')]: 'confirmed',
        [tx('approval')]: 'confirmed',
      })
    );
    expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirmed' }));
  });

  describe('a step of a multi-step action', () => {
    /** Renders again with a rebuilt wallet provider on the same chain, which looks every transaction up again. */
    async function lookUpAgain(rerender: (props: Props) => void, chain: Chain) {
      const provider = walletProvider(chain);
      rerender({ web3: web3For(ACCOUNT, provider) });
      await waitFor(() => expect(provider.getTransactionReceipt).toHaveBeenCalled());
      await settleLookups();
    }

    it('is reported replaced only by its own nonce, never by the lower bound read before sending', async () => {
      const chain: Chain = { confirmedNonces: { [ACCOUNT]: 7 } };
      const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
      await act(async () => {
        await result.current.submitTransaction({
          key: WRAPPER,
          description: 'Supply USDC',
          step: 'supply',
          send: async () => tx('supply'),
        });
      });
      expect(result.current.transactions).toEqual([expect.objectContaining({ nonce: 7, nonceSource: 'lower-bound' })]);

      // An earlier transaction from the account is mined, and the node has not seen this one yet.
      chain.confirmedNonces = { [ACCOUNT]: 8 };
      await lookUpAgain(rerender, chain);
      expect(hashes(result.current.transactions)).toEqual([tx('supply')]);
      expect(result.current.settledTransactions).toEqual([]);

      // Once its own nonce is known and passed with no receipt, it was replaced.
      chain.known = { [tx('supply')]: 8 };
      await lookUpAgain(rerender, chain);
      expect(result.current.transactions).toEqual([expect.objectContaining({ nonce: 8, nonceSource: 'transaction' })]);
      chain.known = {};
      chain.confirmedNonces = { [ACCOUNT]: 9 };
      await lookUpAgain(rerender, chain);
      expect(outcomes(result.current.settledTransactions)).toEqual({ [tx('supply')]: 'replaced' });
    });

    it('keeps the lower bound for other transactions, as before', async () => {
      const chain: Chain = { confirmedNonces: { [ACCOUNT]: 7 } };
      const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
      await act(async () => {
        await result.current.addTransaction(COMET, 'Borrow USDC', sent(tx('sent'), null), 1, jest.fn(), []);
      });

      chain.confirmedNonces = { [ACCOUNT]: 8 };
      await lookUpAgain(rerender, chain);

      expect(outcomes(result.current.settledTransactions)).toEqual({ [tx('sent')]: 'replaced' });
    });

    it('stays tracked when its wallet request was open at a reload, until it is dismissed', async () => {
      store([
        {
          ...storedRecord('', { key: WRAPPER, step: 'supply' }),
          state: TransactionState.AwaitingConfirmation,
          hash: undefined,
        },
      ]);
      const { result } = renderManager(web3For(ACCOUNT, walletProvider()));

      await waitFor(() =>
        expect(result.current.transactions).toEqual([
          expect.objectContaining({
            state: TransactionState.AwaitingConfirmation,
            step: 'supply',
            isInterrupted: true,
          }),
        ])
      );
      expect(JSON.parse(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY) ?? '[]')).toHaveLength(1);

      act(() => result.current.clearTransactions());
      expect(result.current.transactions).toHaveLength(1);

      act(() => result.current.dismissTransaction(result.current.transactions[0].id));
      expect(result.current.transactions).toEqual([]);
      expect(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY)).toBe('[]');
    });

    it('is an ordinary transaction when it is not keyed to a wrapper', async () => {
      store([
        {
          ...storedRecord('', { key: COMET, step: 'supply' }),
          state: TransactionState.AwaitingConfirmation,
          hash: undefined,
        },
      ]);
      const chain: Chain = { confirmedNonces: { [ACCOUNT]: 7 } };
      const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
      await settleLookups();
      // A wallet request with no hash, not kept for a wrapper, cannot be recovered.
      expect(result.current.transactions).toEqual([]);
      expect(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY)).toBe('[]');

      await act(async () => {
        await result.current.submitTransaction({
          key: COMET,
          description: 'Repay',
          step: 'repay',
          send: async () => tx('repay'),
        });
      });
      act(() => result.current.clearTransactions());
      expect(result.current.transactions).toEqual([]);

      await act(async () => {
        await result.current.submitTransaction({
          key: COMET,
          description: 'Repay',
          step: 'repay',
          send: async () => tx('repay'),
        });
      });
      chain.confirmedNonces = { [ACCOUNT]: 8 };
      await lookUpAgain(rerender, chain);
      // Judged by the lower bound, like any other transaction not keyed to a wrapper.
      expect(outcomes(result.current.settledTransactions)).toEqual({ [tx('repay')]: 'replaced' });
    });

    it('stays in the list when the list is cleared, while other transactions go', async () => {
      const { result } = renderManager(web3For(ACCOUNT, walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } })));
      await act(async () => {
        await result.current.addTransaction(COMET, 'Borrow USDC', sent(tx('sent'), 7), 1, jest.fn(), []);
        await result.current.submitTransaction({
          key: WRAPPER,
          description: 'Supply',
          step: 'supply',
          send: async () => tx('supply'),
        });
      });

      act(() => result.current.clearTransactions());

      expect(hashes(result.current.transactions)).toEqual([tx('supply')]);
      expect(storedHashes()).toEqual([tx('supply')]);
    });
  });

  describe('after the wallet provider is rebuilt', () => {
    it('keeps looking up a pending transaction while the new provider detects its network', async () => {
      jest.useFakeTimers();
      try {
        const chain: Chain = { confirmedNonces: { [ACCOUNT]: 7 } };
        const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
        const onSettled = jest.fn();
        await act(async () => {
          await result.current.addTransaction(COMET, 'Supply', sent(tx('supply'), 7), 1, jest.fn(), [], 0n, onSettled);
        });

        rerender({ web3: web3For(ACCOUNT, walletProvider(chain, { networkDelayMs: 40 })) });
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1_000);
        });
        expect(onSettled).not.toHaveBeenCalled();

        // The transaction is mined after the rebuild, and the next poll finds it.
        chain.receipts = { [tx('supply')]: 1 };
        await act(async () => {
          await jest.advanceTimersByTimeAsync(TRX_REFRESH_INTERVAL + 1_000);
        });
        expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirmed' }));
        expect(result.current.transactions).toEqual([]);
      } finally {
        jest.useRealTimers();
      }
    });

    it("runs the transaction's callback once when the provider is rebuilt after the transaction is mined", async () => {
      const chain: Chain = { confirmedNonces: { [ACCOUNT]: 7 } };
      const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
      const onSettled = jest.fn();
      await act(async () => {
        await result.current.addTransaction(COMET, 'Supply', sent(tx('supply'), 7), 1, jest.fn(), [], 0n, onSettled);
      });

      // The transaction is mined, then the provider is rebuilt before the next poll.
      chain.receipts = { [tx('supply')]: 1 };
      rerender({ web3: web3For(ACCOUNT, walletProvider(chain, { networkDelayMs: 0 })) });

      await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
      await settleLookups();
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(outcomes(result.current.settledTransactions)).toEqual({ [tx('supply')]: 'confirmed' });
    });

    it.each(['restore', 'receipt lookup', 'wallet request'] as const)(
      'keeps the rebuilt provider recorded as broken when a request through the earlier provider fails late: %s',
      async (request) => {
        const earlier = walletProvider();
        let failEarlierRequest: (error: unknown) => void = () => undefined;
        const openRequest = jest.fn(() => new Promise<never>((_resolve, reject) => (failEarlierRequest = reject)));
        if (request === 'restore') earlier.getNetwork.mockImplementationOnce(openRequest);
        if (request === 'receipt lookup') {
          store([storedRecord(tx('pending'))]);
          earlier.getTransactionReceipt.mockImplementationOnce(openRequest);
        }
        const { result, rerender } = renderManager(web3For(ACCOUNT, earlier));
        if (request === 'wallet request') {
          act(() => {
            void result.current.submitTransaction({ key: COMET, description: 'Repay', send: openRequest });
          });
        }
        await waitFor(() => expect(openRequest).toHaveBeenCalled());

        // The rebuilt provider throws as an extension broken by an update does.
        const rebuilt = walletProvider();
        rebuilt.getNetwork.mockRejectedValue(BROKEN_EXTENSION);
        rerender({ web3: web3For(ACCOUNT, rebuilt) });
        await waitFor(() => expect(result.current.walletFailure?.provider).toBe(rebuilt));

        // The earlier provider's request then fails the same way.
        act(() => failEarlierRequest(BROKEN_EXTENSION));
        await settleLookups();

        expect(result.current.walletFailure?.provider).toBe(rebuilt);
      }
    );
  });

  it('does not track again a transaction it settled while a restore was reading storage', async () => {
    const chain: Chain = { confirmedNonces: { [ACCOUNT]: 7 } };
    const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
    await settleLookups();
    const onSettled = jest.fn();
    await act(async () => {
      await result.current.submitTransaction({
        key: COMET,
        description: 'Supply',
        send: async () => tx('mined'),
        onSettled,
      });
    });

    // The transaction is mined. The wallet provider is rebuilt, and the restore's read of the chain is slow.
    chain.receipts = { [tx('mined')]: 1 };
    const rebuilt = walletProvider(chain);
    let answerRestore: (network: { chainId: number; name: string }) => void = () => undefined;
    rebuilt.getNetwork.mockImplementationOnce(() => new Promise((resolve) => (answerRestore = resolve)));
    rerender({ web3: web3For(ACCOUNT, rebuilt) });
    await act(async () => {
      // The poll settles the transaction. Its removal is not rendered yet when the restore reads storage.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(onSettled).toHaveBeenCalledTimes(1);
      answerRestore({ chainId: 1, name: 'homestead' });
    });
    await settleLookups();

    expect(result.current.transactions).toEqual([]);
    expect(storedHashes()).toEqual([]);
    expect(outcomes(result.current.settledTransactions)).toEqual({ [tx('mined')]: 'confirmed' });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('does not write back a transaction that a late lookup reports after it settled', async () => {
    jest.useFakeTimers();
    try {
      const chain: Chain = { confirmedNonces: { [ACCOUNT]: 7 } };
      const provider = walletProvider(chain);
      let answerSlowLookup: (value: { hash: string; nonce: number } | null) => void = () => undefined;
      provider.getTransaction.mockImplementationOnce(() => new Promise((resolve) => (answerSlowLookup = resolve)));
      const { result, rerender } = renderManager(web3For(ACCOUNT, provider));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        await result.current.submitTransaction({ key: COMET, description: 'Supply', send: async () => tx('mined') });
      });
      // The first lookup finds no receipt, and the node's record of the transaction is slow to come.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(provider.getTransaction).toHaveBeenCalledTimes(1);

      // Mined. The next poll settles it, and then the slow lookup answers with the transaction's nonce.
      chain.receipts = { [tx('mined')]: 1 };
      await act(async () => {
        await jest.advanceTimersByTimeAsync(TRX_REFRESH_INTERVAL + 100);
        answerSlowLookup({ hash: tx('mined'), nonce: 8 });
        await jest.advanceTimersByTimeAsync(10);
      });
      expect(outcomes(result.current.settledTransactions)).toEqual({ [tx('mined')]: 'confirmed' });
      expect(storedHashes()).toEqual([]);

      // A later restore finds nothing to track.
      rerender({ web3: web3For(ACCOUNT, walletProvider(chain)) });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000);
      });
      expect(result.current.transactions).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not track again a settled transaction that another tab writes back', async () => {
    const chain: Chain = { confirmedNonces: { [ACCOUNT]: 7 } };
    const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
    await settleLookups();
    await act(async () => {
      await result.current.submitTransaction({ key: COMET, description: 'Supply', send: async () => tx('mined') });
    });
    // Mined, and found by the lookup that follows a rebuilt wallet provider.
    chain.receipts = { [tx('mined')]: 1 };
    rerender({ web3: web3For(ACCOUNT, walletProvider(chain)) });
    await waitFor(() => expect(result.current.settledTransactions).toHaveLength(1));

    // Another tab that still tracks the transaction writes its record back to storage.
    store([{ ...result.current.settledTransactions[0], outcome: undefined }]);
    rerender({ web3: web3For(ACCOUNT, walletProvider(chain)) });
    await settleLookups();

    expect(result.current.transactions).toEqual([]);
    expect(storedHashes()).toEqual([]);
    expect(outcomes(result.current.settledTransactions)).toEqual({ [tx('mined')]: 'confirmed' });
  });

  it('does not bring back a wallet request rejected while a restore was reading storage', async () => {
    const chain: Chain = { confirmedNonces: { [ACCOUNT]: 7 } };
    const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
    await settleLookups();
    let rejectInWallet: (error: unknown) => void = () => undefined;
    let submission: Promise<SendResult> = Promise.resolve({ status: 'session-changed' });
    act(() => {
      submission = result.current.submitTransaction({
        key: WRAPPER,
        description: 'Supply',
        step: 'supply',
        send: () => new Promise((_resolve, reject) => (rejectInWallet = reject)),
      });
    });
    await settleLookups();

    // The wallet provider is rebuilt, and the restore's read of the chain is slow.
    const rebuilt = walletProvider(chain);
    let answerRestore: (network: { chainId: number; name: string }) => void = () => undefined;
    rebuilt.getNetwork.mockImplementationOnce(() => new Promise((resolve) => (answerRestore = resolve)));
    rerender({ web3: web3For(ACCOUNT, rebuilt) });
    await act(async () => {
      // The user rejects the request, and the restore reads storage before the removal is rendered.
      rejectInWallet({ code: 4001, message: 'User rejected the request.' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      answerRestore({ chainId: 1, name: 'homestead' });
    });
    await settleLookups();

    await expect(submission).resolves.toEqual({ status: 'rejected' });
    // Not tracked again as an interrupted request, which would hold back the next wrapper review.
    expect(result.current.transactions).toEqual([]);
    expect(storedHashes()).toEqual([]);
  });

  it('reports whether a transaction succeeded to its callback', async () => {
    const provider = walletProvider({ receipts: { [tx('succeeded')]: 1, [tx('failed')]: 0 } });
    const { result } = renderManager(web3For(ACCOUNT, provider));
    const onSucceeded = jest.fn();
    const onFailed = jest.fn();

    await act(async () => {
      await result.current.addTransaction(COMET, 'Supply', sent(tx('succeeded'), 3), 1, jest.fn(), [], 0n, onSucceeded);
      await result.current.addTransaction(COMET, 'Withdraw', sent(tx('failed'), 4), 1, jest.fn(), [], 0n, onFailed);
    });

    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(onSucceeded).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirmed' }));
    expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 'reverted' }));
    expect(result.current.transactions).toEqual([]);
  });

  it('ignores malformed stored records and restores the valid ones', async () => {
    store([
      null,
      42,
      'record',
      { id: 7 },
      { ...storedRecord(tx('bad-account')), account: 7 },
      { ...storedRecord(tx('bad-nonce')), nonce: '9' },
      { ...storedRecord(tx('bad-hash')), hash: 12 },
      { ...storedRecord(tx('bad-state')), state: 'confirmed' },
      storedRecord(tx('unresolved'), { nonce: 9 }),
    ]);
    const provider = walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } });
    const { result } = renderManager(web3For(ACCOUNT, provider));

    await waitFor(() => expect(hashes(result.current.transactions)).toEqual([tx('unresolved')]));
    await settleLookups();
    expect(hashes(result.current.transactions)).toEqual([tx('unresolved')]);
    expect(provider.getTransactionReceipt.mock.calls.map(([hash]) => hash)).not.toContain(tx('bad-account'));
    expect(storedHashes()).toEqual([tx('unresolved')]);
  });

  it('keeps tracking a restored transaction whose lookup fails, and records a broken provider', async () => {
    store([storedRecord(tx('unknown'), { nonce: 9 })]);
    const provider = walletProvider();
    provider.getTransactionReceipt.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'sendMessage')")
    );
    const { result } = renderManager(web3For(ACCOUNT, provider));

    await waitFor(() => expect(hashes(result.current.transactions)).toEqual([tx('unknown')]));
    expect(result.current.settledTransactions).toEqual([]);
    expect(result.current.walletFailure?.provider).toBe(provider);
  });

  it("clears this session's transactions and keeps other accounts' stored records", async () => {
    store([storedRecord(tx('other-account'), { account: OTHER_ACCOUNT })]);
    const { result } = renderManager(web3For(ACCOUNT, walletProvider()));
    await act(async () => {
      await result.current.addTransaction(COMET, 'Supply', sent(tx('sent'), 1), 1, jest.fn(), []);
    });
    expect(storedHashes()).toEqual([tx('other-account'), tx('sent')]);

    act(() => result.current.clearTransactions());

    expect(result.current.transactions).toEqual([]);
    expect(storedHashes()).toEqual([tx('other-account')]);
  });

  describe('submitTransaction', () => {
    it('shows the request as awaiting the wallet until the wallet returns a hash', async () => {
      const provider = walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } });
      const { result } = renderManager(web3For(ACCOUNT, provider));
      let broadcast: (hash: string) => void = () => undefined;
      const send = () => new Promise<string>((resolve) => (broadcast = resolve));

      let submission: Promise<SendResult> = Promise.resolve({ status: 'session-changed' });
      act(() => {
        submission = result.current.submitTransaction({
          key: WRAPPER,
          description: 'Approve USDC',
          step: 'approve',
          send,
        });
      });
      // A mobile approval can take minutes, and until the wallet returns a hash nothing is broadcast.
      await waitFor(() =>
        expect(result.current.transactions).toEqual([
          expect.objectContaining({ state: TransactionState.AwaitingConfirmation, step: 'approve' }),
        ])
      );

      await act(async () => broadcast(tx('approval')));

      await expect(submission).resolves.toEqual({ status: 'submitted', id: expect.any(String), hash: tx('approval') });
      expect(hashes(result.current.transactions)).toEqual([tx('approval')]);
      expect(JSON.parse(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY) ?? '[]')).toEqual([
        expect.objectContaining({
          hash: tx('approval'),
          account: ACCOUNT,
          networkId: 1,
          key: WRAPPER,
          step: 'approve',
        }),
      ]);
    });

    it.each<[string, unknown, SendResult]>([
      ['an EIP-1193 rejection (4001)', { code: 4001, message: 'User rejected the request.' }, { status: 'rejected' }],
      [
        "ethers' ACTION_REJECTED",
        Object.assign(new Error('user rejected transaction'), { code: 'ACTION_REJECTED' }),
        { status: 'rejected' },
      ],
      [
        "viem's UserRejectedRequestError",
        Object.assign(new Error('User rejected the request.'), { name: 'UserRejectedRequestError' }),
        { status: 'rejected' },
      ],
      [
        'an Anchorage refusal (a bare -32603 Internal error)',
        { code: -32603, message: 'Internal error' },
        { status: 'provider-failure', message: 'Internal error (-32603)' },
      ],
      [
        'an ethers error wrapping an internal error',
        Object.assign(new Error('processing response error'), {
          code: 'SERVER_ERROR',
          error: { code: -32603, message: 'Internal error' },
        }),
        { status: 'provider-failure', message: 'processing response error (SERVER_ERROR)' },
      ],
      [
        'an extension broken by an update',
        BROKEN_EXTENSION,
        { status: 'session-broken', message: "Cannot read properties of undefined (reading 'sendMessage')" },
      ],
    ])('reports %s, and treats only an explicit rejection as one', async (_name, error, expected) => {
      const provider = walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } });
      const { result } = renderManager(web3For(ACCOUNT, provider));

      let submission: SendResult | undefined;
      await act(async () => {
        submission = await result.current.submitTransaction({
          key: WRAPPER,
          description: 'Approve USDC',
          send: async () => Promise.reject(error),
        });
      });

      expect(submission).toEqual(expected);
      expect(result.current.transactions).toEqual([]);
      expect(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY)).toBe('[]');
    });

    it('keeps a wrapper step, marked interrupted, when the wallet answers with an unknown outcome', async () => {
      const { result } = renderManager(web3For(ACCOUNT, walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } })));

      let submission: SendResult | undefined;
      await act(async () => {
        submission = await result.current.submitTransaction({
          key: WRAPPER,
          description: 'Supply USDC',
          step: 'supply',
          send: async () => Promise.reject({ code: -32603, message: 'Internal error' }),
        });
      });

      expect(submission).toEqual({ status: 'provider-failure', message: 'Internal error (-32603)' });
      // Anchorage may still send it after approval on mobile, so the next review waits for it.
      expect(result.current.transactions).toEqual([
        expect.objectContaining({ state: TransactionState.AwaitingConfirmation, step: 'supply', isInterrupted: true }),
      ]);
      expect(JSON.parse(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY) ?? '[]')).toHaveLength(1);
    });

    it('drops a wrapper step the user rejected, or one that failed before the wallet was asked', async () => {
      const { result } = renderManager(web3For(ACCOUNT, walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } })));

      const submissions: SendResult[] = [];
      await act(async () => {
        submissions.push(
          await result.current.submitTransaction({
            key: WRAPPER,
            description: 'Supply USDC',
            step: 'supply',
            send: async () => Promise.reject({ code: 4001, message: 'User rejected the request.' }),
          }),
          await result.current.submitTransaction({
            key: WRAPPER,
            description: 'Supply USDC',
            step: 'supply',
            send: async () => Promise.reject(new NotSentError({ code: -32000, message: 'execution reverted' })),
          })
        );
      });

      expect(submissions).toEqual([
        { status: 'rejected' },
        { status: 'not-sent', message: 'execution reverted (-32000)' },
      ]);
      expect(result.current.transactions).toEqual([]);
      expect(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY)).toBe('[]');
    });

    it('sends nothing when the caller withdraws the request at the last moment', async () => {
      const provider = walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } });
      const { result } = renderManager(web3For(ACCOUNT, provider));

      let submission: SendResult | undefined;
      await act(async () => {
        submission = await result.current.submitTransaction({
          key: WRAPPER,
          description: 'Approve USDC',
          send: async () => Promise.reject(new SendWithdrawnError()),
        });
      });

      expect(submission).toEqual({ status: 'session-changed' });
      expect(result.current.transactions).toEqual([]);
      expect(result.current.walletFailure).toBeUndefined();
    });

    it('records which provider broke, so the session can be marked unusable', async () => {
      const provider = walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } });
      provider.getTransactionCount.mockRejectedValue(BROKEN_EXTENSION);
      const { result } = renderManager(web3For(ACCOUNT, provider));
      const send = jest.fn();

      let submission: SendResult | undefined;
      await act(async () => {
        submission = await result.current.submitTransaction({ key: WRAPPER, description: 'Approve USDC', send });
      });

      // The nonce read failed, so the wallet was never asked and nothing was sent.
      expect(submission).toEqual({
        status: 'not-sent',
        message: "Cannot read properties of undefined (reading 'sendMessage')",
      });
      expect(send).not.toHaveBeenCalled();
      expect(result.current.walletFailure?.provider).toBe(provider);
    });

    it.each([
      ['another account', { account: OTHER_ACCOUNT }],
      ['another chain', { chainId: 137 }],
    ])('sends nothing when the session is on %s than the caller checked', async (_name, expected) => {
      const { result } = renderManager(web3For(ACCOUNT, walletProvider()));
      const send = jest.fn();

      let submission: SendResult | undefined;
      await act(async () => {
        submission = await result.current.submitTransaction({
          key: WRAPPER,
          description: 'Approve',
          send,
          ...expected,
        });
      });

      expect(submission).toEqual({ status: 'session-changed' });
      expect(send).not.toHaveBeenCalled();
      expect(result.current.transactions).toEqual([]);
    });
  });

  describe('addTransaction', () => {
    it('returns the response once sent, and nothing after a failure', async () => {
      const { result } = renderManager(web3For(ACCOUNT, walletProvider()));

      let response: TransactionResponse | undefined;
      let failed: TransactionResponse | undefined;
      await act(async () => {
        response = await result.current.addTransaction(COMET, 'Supply', sent(tx('sent'), 1), 1, jest.fn(), []);
        failed = await result.current.addTransaction(
          COMET,
          'Supply',
          async () => Promise.reject({ code: -32603, message: 'Internal error' }),
          1,
          jest.fn(),
          []
        );
      });

      expect(response?.hash).toBe(tx('sent'));
      expect(failed).toBeUndefined();
      expect(hashes(result.current.transactions)).toEqual([tx('sent')]);
    });

    it('estimates gas when no estimate is given, and passes the value and limit to the transaction', async () => {
      const { result } = renderManager(web3For(ACCOUNT, walletProvider()));
      const transactionFunction = jest.fn(sent(tx('sent'), 1));
      const estimateGas = jest.fn(async () => BigNumber.from(100_000));

      await act(async () => {
        await result.current.addTransaction(COMET, 'Supply', transactionFunction, 0, estimateGas, ['0xasset', '5'], 3n);
      });

      expect(estimateGas).toHaveBeenCalledWith('0xasset', '5', { value: 3n });
      expect(transactionFunction).toHaveBeenCalledWith('0xasset', '5', { value: 3n, gasLimit: 120_000 });
    });
  });
});

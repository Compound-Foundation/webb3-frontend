import { JsonRpcProvider, TransactionResponse } from '@ethersproject/providers';
import { act, renderHook, waitFor } from '@testing-library/react';
import { BigNumber } from 'ethers';

import { Web3 } from '@contexts/Web3Context';
import { TRANSACTION_LOCALSTORAGE_KEY } from '@helpers/constants';
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

type Chain = {
  chainId?: number;
  /** Mined transactions, by hash, with their receipt status. */
  receipts?: Record<string, number>;
  /** Transactions the node knows, by hash, with their nonce. */
  known?: Record<string, number>;
  /** Each account's confirmed nonce, by lower-case address. */
  confirmedNonces?: Record<string, number>;
};

/** A stand-in for the wallet provider, answering from `chain`. */
function walletProvider(chain: Chain = {}) {
  const chainId = chain.chainId ?? 1;
  const network = { chainId, name: chainId === 1 ? 'homestead' : 'matic' };
  return {
    network,
    getNetwork: jest.fn(async () => network),
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

function store(records: object[]) {
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
      storedRecord('0xapproved', { key: WRAPPER, step: 'approve' }),
      storedRecord('0xreverted'),
      storedRecord('0xreplaced', { nonce: 4 }),
      storedRecord('0xunresolved', { nonce: 9 }),
      storedRecord('0xother-account', { account: OTHER_ACCOUNT, nonce: 300 }),
      storedRecord('0xother-chain', { networkId: 137, networkName: 'matic' }),
    ]);
    const provider = walletProvider({
      receipts: { '0xapproved': 1, '0xreverted': 0 },
      confirmedNonces: { [ACCOUNT]: 7, [OTHER_ACCOUNT]: 250 },
    });

    const { result, rerender } = renderManager(web3For(ACCOUNT, provider));

    await waitFor(() => expect(result.current.settledTransactions).toHaveLength(3));
    expect(outcomes(result.current.settledTransactions)).toEqual({
      '0xapproved': 'confirmed',
      '0xreverted': 'reverted',
      '0xreplaced': 'replaced',
    });
    expect(result.current.settledTransactions.find((tx) => tx.hash === '0xapproved')).toMatchObject({
      account: ACCOUNT,
      networkId: 1,
      key: WRAPPER,
      step: 'approve',
    });
    // Still pending: the sender's confirmed nonce has not passed it.
    expect(hashes(result.current.transactions)).toEqual(['0xunresolved']);
    // Replacement is judged by the nonce of the account that sent the transaction.
    expect(provider.getTransactionCount.mock.calls.every(([address]) => address === ACCOUNT)).toBe(true);
    // Nothing was signed or sent, so the step after the approval was not replayed.
    expect(provider.getSigner).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
    // Settled records are gone. The other account's and the other chain's stay for when they return.
    expect(storedHashes()).toEqual(['0xother-account', '0xother-chain', '0xunresolved']);

    rerender({ web3: web3For(OTHER_ACCOUNT, provider) });
    await waitFor(() =>
      expect(hashes(result.current.transactions).sort()).toEqual(['0xother-account', '0xunresolved'])
    );
    expect(storedHashes()).toEqual(['0xother-account', '0xother-chain', '0xunresolved']);
  });

  it('restores each transaction once when the wallet provider is rebuilt', async () => {
    store([storedRecord('0xunresolved', { nonce: 9 })]);
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
      { ...storedRecord('0xlegacy'), account: undefined },
      { ...storedRecord('0xawaiting'), state: TransactionState.AwaitingConfirmation, hash: undefined },
      storedRecord('0xunresolved', { nonce: 9 }),
    ]);
    const provider = walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } });
    const { result } = renderManager(web3For(ACCOUNT, provider));

    await waitFor(() => expect(provider.getTransactionReceipt).toHaveBeenCalled());
    await settleLookups();
    expect(hashes(result.current.transactions)).toEqual(['0xunresolved']);
    expect(storedHashes()).toEqual(['0xunresolved']);
  });

  it('judges replacement by the nonce of the account that sent the transaction', async () => {
    const chain = { confirmedNonces: { [ACCOUNT]: 7, [OTHER_ACCOUNT]: 100 } };
    const { result, rerender } = renderManager(web3For(ACCOUNT, walletProvider(chain)));
    await act(async () => {
      await result.current.addTransaction(COMET, 'Borrow USDC', sent('0xsent', null), 100_000, jest.fn(), []);
    });

    const otherWallet = walletProvider(chain);
    rerender({ web3: web3For(OTHER_ACCOUNT, otherWallet) });
    await waitFor(() => expect(otherWallet.getTransactionCount).toHaveBeenCalled());

    expect(otherWallet.getTransactionCount.mock.calls.every(([address]) => address === ACCOUNT)).toBe(true);
    expect(hashes(result.current.transactions)).toEqual(['0xsent']);
  });

  it('uses the nonce the node reports for the transaction when it has one', async () => {
    // The wallet queues the transaction behind an earlier one, so it is sent with nonce 8 although
    // the confirmed nonce read before sending was 7.
    const chain: Chain = { known: { '0xqueued': 8 }, confirmedNonces: { [ACCOUNT]: 7 } };
    const provider = walletProvider(chain);
    const { result } = renderManager(web3For(ACCOUNT, provider));
    const sendQueuedTransaction = async () => {
      // The earlier transaction is mined while the wallet sends this one.
      chain.confirmedNonces = { [ACCOUNT]: 8 };
      return sent('0xqueued', null)();
    };
    await act(async () => {
      await result.current.addTransaction(COMET, 'Borrow USDC', sendQueuedTransaction, 1, jest.fn(), []);
    });

    await waitFor(() => expect(provider.getTransactionCount).toHaveBeenCalledTimes(2));
    await settleLookups();

    expect(hashes(result.current.transactions)).toEqual(['0xqueued']);
    expect(result.current.settledTransactions).toEqual([]);
  });

  it('reports whether a transaction succeeded to its callback', async () => {
    const provider = walletProvider({ receipts: { '0xsucceeded': 1, '0xfailed': 0 } });
    const { result } = renderManager(web3For(ACCOUNT, provider));
    const onSucceeded = jest.fn();
    const onFailed = jest.fn();

    await act(async () => {
      await result.current.addTransaction(COMET, 'Supply', sent('0xsucceeded', 3), 1, jest.fn(), [], 0n, onSucceeded);
      await result.current.addTransaction(COMET, 'Withdraw', sent('0xfailed', 4), 1, jest.fn(), [], 0n, onFailed);
    });

    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSucceeded).toHaveBeenCalledTimes(1));
    expect(onSucceeded).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirmed' }));
    expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 'reverted' }));
    expect(result.current.transactions).toEqual([]);
  });

  it('keeps tracking a restored transaction whose lookup fails, and records a broken provider', async () => {
    store([storedRecord('0xunknown', { nonce: 9 })]);
    const provider = walletProvider();
    provider.getTransactionReceipt.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'sendMessage')")
    );
    const { result } = renderManager(web3For(ACCOUNT, provider));

    await waitFor(() => expect(hashes(result.current.transactions)).toEqual(['0xunknown']));
    expect(result.current.settledTransactions).toEqual([]);
    expect(result.current.walletFailure?.provider).toBe(provider);
  });

  it("clears this session's transactions and keeps other accounts' stored records", async () => {
    store([storedRecord('0xother-account', { account: OTHER_ACCOUNT })]);
    const { result } = renderManager(web3For(ACCOUNT, walletProvider()));
    await act(async () => {
      await result.current.addTransaction(COMET, 'Supply', sent('0xsent', 1), 1, jest.fn(), []);
    });
    expect(storedHashes()).toEqual(['0xother-account', '0xsent']);

    act(() => result.current.clearTransactions());

    expect(result.current.transactions).toEqual([]);
    expect(storedHashes()).toEqual(['0xother-account']);
  });

  describe('submitTransaction', () => {
    const BROKEN_EXTENSION = new TypeError("Cannot read properties of undefined (reading 'sendMessage')");

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

      await act(async () => broadcast('0xapproval'));

      await expect(submission).resolves.toEqual({ status: 'submitted', id: expect.any(String), hash: '0xapproval' });
      expect(hashes(result.current.transactions)).toEqual(['0xapproval']);
      expect(JSON.parse(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY) ?? '[]')).toEqual([
        expect.objectContaining({ hash: '0xapproval', account: ACCOUNT, networkId: 1, key: WRAPPER, step: 'approve' }),
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

    it('records which provider broke, so the session can be marked unusable', async () => {
      const provider = walletProvider({ confirmedNonces: { [ACCOUNT]: 7 } });
      provider.getTransactionCount.mockRejectedValue(BROKEN_EXTENSION);
      const { result } = renderManager(web3For(ACCOUNT, provider));
      const send = jest.fn();

      let submission: SendResult | undefined;
      await act(async () => {
        submission = await result.current.submitTransaction({ key: WRAPPER, description: 'Approve USDC', send });
      });

      expect(submission).toMatchObject({ status: 'session-broken' });
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
        response = await result.current.addTransaction(COMET, 'Supply', sent('0xsent', 1), 1, jest.fn(), []);
        failed = await result.current.addTransaction(
          COMET,
          'Supply',
          async () => Promise.reject({ code: -32603, message: 'Internal error' }),
          1,
          jest.fn(),
          []
        );
      });

      expect(response?.hash).toBe('0xsent');
      expect(failed).toBeUndefined();
      expect(hashes(result.current.transactions)).toEqual(['0xsent']);
    });

    it('estimates gas when no estimate is given, and passes the value and limit to the transaction', async () => {
      const { result } = renderManager(web3For(ACCOUNT, walletProvider()));
      const transactionFunction = jest.fn(sent('0xsent', 1));
      const estimateGas = jest.fn(async () => BigNumber.from(100_000));

      await act(async () => {
        await result.current.addTransaction(COMET, 'Supply', transactionFunction, 0, estimateGas, ['0xasset', '5'], 3n);
      });

      expect(estimateGas).toHaveBeenCalledWith('0xasset', '5', { value: 3n });
      expect(transactionFunction).toHaveBeenCalledWith('0xasset', '5', { value: 3n, gasLimit: 120_000 });
    });
  });
});

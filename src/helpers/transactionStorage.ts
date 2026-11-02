import { TRANSACTION_LOCALSTORAGE_KEY } from '@helpers/constants';
import { isDirectWithdrawalStep } from '@helpers/wrappedActions';
import { HeldDirectWithdrawal, Transaction, TransactionState } from '@types';

// The transaction manager's stored records, as `useTransactionManager` writes them. Reading them
// needs no manager, so Home can check what another tab of the app has stored.

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const UNSIGNED_INTEGER = /^[0-9]{1,78}$/;
const SIGNED_INTEGER = /^-?[0-9]{1,78}$/;

/** Whether a stored value is a well-formed `heldWithdrawal`, or is absent. */
function isStoredHeldWithdrawal(value: unknown): value is HeldDirectWithdrawal | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const held = value as Record<string, unknown>;
  return (
    typeof held.amount === 'string' &&
    UNSIGNED_INTEGER.test(held.amount) &&
    typeof held.principalBefore === 'string' &&
    SIGNED_INTEGER.test(held.principalBefore) &&
    (held.blockNumber === undefined ||
      (typeof held.blockNumber === 'number' && Number.isSafeInteger(held.blockNumber) && held.blockNumber >= 0))
  );
}

/** Whether a stored value is a well-formed transaction record. Any script on the page can write storage. */
export function isStoredTransaction(value: unknown): value is Transaction {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const isCount = (field: unknown, minimum: number) =>
    typeof field === 'number' && Number.isSafeInteger(field) && field >= minimum;
  return (
    typeof record.id === 'string' &&
    typeof record.key === 'string' &&
    isCount(record.networkId, 1) &&
    typeof record.networkName === 'string' &&
    typeof record.description === 'string' &&
    isCount(record.nonce, 0) &&
    (record.nonceSource === undefined ||
      record.nonceSource === 'transaction' ||
      record.nonceSource === 'lower-bound') &&
    (record.account === undefined || (typeof record.account === 'string' && ADDRESS.test(record.account))) &&
    (record.step === undefined || typeof record.step === 'string') &&
    isStoredHeldWithdrawal(record.heldWithdrawal) &&
    (record.state === TransactionState.AwaitingConfirmation ||
      (record.state === TransactionState.Pending &&
        typeof record.hash === 'string' &&
        TRANSACTION_HASH.test(record.hash)))
  );
}

/** The well-formed stored records. Anything else is dropped at the next write. */
export function readStoredTransactions(): Transaction[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(TRANSACTION_LOCALSTORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isStoredTransaction) : [];
  } catch {
    return [];
  }
}

/**
 * The stored Comet steps of split withdrawals for `account` on `cometAddress`, as any tab of the app
 * wrote them, whether or not this tab's manager tracks them.
 */
export function readStoredDirectWithdrawalSteps(account: string, chainId: number, cometAddress: string): Transaction[] {
  return readStoredTransactions().filter(
    (record) =>
      isDirectWithdrawalStep(record) &&
      record.account?.toLowerCase() === account.toLowerCase() &&
      record.networkId === chainId &&
      record.key.toLowerCase() === cometAddress.toLowerCase()
  );
}

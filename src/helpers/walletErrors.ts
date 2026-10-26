/**
 * How a wallet request failed.
 * - `rejected`: the user declined it. Only these count: EIP-1193 code 4001, viem's
 *   `UserRejectedRequestError`, and ethers' `ACTION_REJECTED`. Ethers raises `ACTION_REJECTED` from
 *   the wallet's message ("user denied"), not from the code.
 * - `session-broken`: the provider itself is broken. An extension that updates under an open tab
 *   leaves the page showing the wallet as connected while every call throws, for example
 *   `Cannot read properties of undefined (reading 'sendMessage')`. Only these messages count: any
 *   other JavaScript error, such as a failed fetch, is a provider failure. A read through the
 *   wallet (`probeWalletSession`) catches a provider broken some other way.
 * - `pending-in-wallet`: the wallet answered with an error but still holds the request. The user
 *   can still approve the request there, and the wallet then sends it. The Anchorage Digital
 *   extension 1.1.16 answers this way in two cases, each with the ID of its operation for the
 *   request in `data.operationID` and its message again in `data.userVisibleMessage`:
 *   - code `-32005` and "This request is still pending and can still complete after this
 *     message. …", about 4 minutes 47 seconds after a request that waits for approval on a phone;
 *   - EIP-1193 code 4900 and "Stopped waiting because the dApp tab was closed or the wallet was
 *     disconnected. The request can still complete, …", when the tab's wallet is disconnected
 *     while the request waits, as when the page disconnects the wallet.
 *   Only these count: code `-32005`, a message or `data.userVisibleMessage` with "still pending" or
 *   "can still complete", and code 4900 with a `data.operationID`, each code as a number or a
 *   string. Callers handle it as a `provider-failure` and only describe it differently.
 * - `refused`: the wallet refused the request before it handled it, so no transaction and no
 *   request in the wallet exist. Only the EIP-1193 provider errors 4100 (Unauthorized), 4200
 *   (Unsupported Method), 4900 (Disconnected) and 4901 (Chain Disconnected) count, as a number or a
 *   string, and only when the error does not show a request the wallet still holds, as Anchorage's
 *   4900 above does. The Anchorage Digital extension answers 4100 "Unauthorized" when the tab's
 *   session in the extension has no wallet, as after the user logs into the extension again while
 *   the page still shows the account connected. Callers handle it as a `rejected`, since nothing
 *   was sent, and only describe it differently.
 * - `provider-failure`: anything else, an unknown outcome. Anchorage reports a request it turns
 *   down as a bare `-32603 Internal error`, which does not show whether the user declined or
 *   whether the request reached the chain.
 */
export type WalletErrorKind = 'rejected' | 'session-broken' | 'pending-in-wallet' | 'refused' | 'provider-failure';

const USER_REJECTED_REQUEST = 4001;
const BROKEN_EXTENSION_MESSAGE =
  /sendMessage|extension context invalidated|disconnected port|receiving end does not exist/i;
const REQUEST_STILL_PENDING = -32005;
/**
 * EIP-1193 Disconnected. Anchorage also answers it when it stops waiting on a request that can
 * still complete.
 */
const DISCONNECTED = 4900;
const STILL_PENDING_MESSAGE = /still pending|can still complete/i;
/** EIP-1193 provider errors for a request the provider refused before it handled it. */
const REFUSED_BEFORE_HANDLING = [4100, 4200, DISCONNECTED, 4901];

type ErrorFields = {
  code?: unknown;
  name?: unknown;
  message?: unknown;
  error?: unknown;
  cause?: unknown;
  data?: unknown;
};

/**
 * What the Anchorage extension puts in an error's `data`: its message for the user, and the ID of
 * the operation it made for the request.
 */
type AnchorageErrorData = { userVisibleMessage?: unknown; operationID?: unknown };

/**
 * An error's `data` read as Anchorage fills it. Data that is not an object, such as revert data,
 * has neither field.
 */
function anchorageData({ data }: ErrorFields): AnchorageErrorData {
  return typeof data === 'object' && data !== null ? (data as AnchorageErrorData) : {};
}

/**
 * The error and the errors it wraps: ethers keeps the provider's error in `error`, viem in `cause`,
 * and a JSON-RPC error can carry another error in `data`.
 */
function errorChain(error: unknown): ErrorFields[] {
  const chain: ErrorFields[] = [];
  const queue: unknown[] = [error];
  while (queue.length > 0 && chain.length < 8) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null || chain.includes(current as ErrorFields)) continue;
    const fields = current as ErrorFields;
    chain.push(fields);
    queue.push(fields.error, fields.cause, fields.data);
  }
  return chain;
}

function isRejection({ code, name }: ErrorFields): boolean {
  return code === USER_REJECTED_REQUEST || code === 'ACTION_REJECTED' || name === 'UserRejectedRequestError';
}

function isBrokenProvider({ message }: ErrorFields): boolean {
  return typeof message === 'string' && BROKEN_EXTENSION_MESSAGE.test(message);
}

/** Whether `code` is `expected`, as a number or a string. */
function hasCode(code: unknown, expected: number): boolean {
  return code === expected || code === String(expected);
}

function saysStillPending(text: unknown): boolean {
  return typeof text === 'string' && STILL_PENDING_MESSAGE.test(text);
}

function isStillPending(fields: ErrorFields): boolean {
  const { code, message } = fields;
  const { userVisibleMessage, operationID } = anchorageData(fields);
  return (
    hasCode(code, REQUEST_STILL_PENDING) ||
    saysStillPending(message) ||
    saysStillPending(userVisibleMessage) ||
    // Anchorage made an operation for the request, so the request exists in the wallet.
    (hasCode(code, DISCONNECTED) && operationID !== undefined && operationID !== null)
  );
}

function isRefusal({ code }: ErrorFields): boolean {
  return REFUSED_BEFORE_HANDLING.some((refusal) => hasCode(code, refusal));
}

export function classifyWalletError(error: unknown): WalletErrorKind {
  const chain = errorChain(error);
  if (chain.some(isRejection)) return 'rejected';
  if (chain.some(isBrokenProvider)) return 'session-broken';
  // Checked after the kinds above, so it can only take the place of `refused` or
  // `provider-failure`. Anchorage answers 4900, a refusal code, when it stops waiting on a request
  // that can still complete.
  if (chain.some(isStillPending)) return 'pending-in-wallet';
  // Checked last. A refusal drops the request's record, so an error that also shows a broken
  // provider or a request the wallet still holds keeps its record.
  if (chain.some(isRefusal)) return 'refused';
  return 'provider-failure';
}

function describeErrorFields(fields: ErrorFields | undefined): string {
  const message = typeof fields?.message === 'string' && fields.message !== '' ? fields.message : 'Unknown error';
  return typeof fields?.code === 'number' || typeof fields?.code === 'string' ? `${message} (${fields.code})` : message;
}

/**
 * A short description of a wallet error for the UI: its message and code. When the error or an
 * error it wraps says that the wallet still holds the request, the description is of the first
 * such error with a code, so that it names that answer's code, such as -32005 or 4900, even inside
 * another error.
 */
export function describeWalletError(error: unknown): string {
  const chain = errorChain(error);
  const stillPending = chain.find(
    (fields) => isStillPending(fields) && (typeof fields.code === 'number' || typeof fields.code === 'string')
  );
  return describeErrorFields(stillPending ?? chain[0]);
}

/**
 * A short description of a `refused` error for the UI: the message and code of the error that
 * refused the request. A wrapping error can carry another message and code, so this description
 * names the refusal's code where `describeWalletError` would not.
 */
export function describeWalletRefusal(error: unknown): string {
  const chain = errorChain(error);
  return describeErrorFields(chain.find(isRefusal) ?? chain[0]);
}

/**
 * Thrown by a request's `send` to withdraw it before the wallet is asked, for example because the
 * session changed while the transaction manager read the network and nonce. Nothing is sent.
 */
export class SendWithdrawnError extends Error {
  constructor(message = 'The request was withdrawn before the wallet was asked.') {
    super(message);
    this.name = 'SendWithdrawnError';
  }
}

/**
 * Thrown by a request's `send` when it failed before the wallet was asked to sign, for example
 * while estimating gas. Nothing was sent. `cause` is the original error.
 */
export class NotSentError extends Error {
  constructor(cause: unknown) {
    super(describeWalletError(cause));
    this.name = 'NotSentError';
    this.cause = cause;
  }
}

export type SessionProbeResult =
  | { status: 'usable' }
  | {
      status: 'unusable';
      /**
       * - `provider-broken`: the provider throws, as an extension does after it updates.
       * - `reads-failing`: a read through the wallet failed, as every read does after a wallet
       *   acknowledges a switch to a network it cannot serve.
       * - `chain-mismatch`: the wallet reports another network than the session.
       */
      reason: 'provider-broken' | 'reads-failing' | 'chain-mismatch';
    };

/** The part of an ethers provider the probe uses. */
export type ProbedProvider = { send: (method: string, params: unknown[]) => Promise<unknown> };

/**
 * Reads through the wallet provider to check that it can still serve `chainId`. A successful
 * network switch is not proof of a usable wallet: a wallet can acknowledge a switch to a network it
 * cannot serve and then fail every read. A read that fails is the only signal, so this probe makes
 * one: `eth_blockNumber` needs the wallet's node, while the wallet can answer `eth_chainId` locally.
 */
export async function probeWalletSession(provider: ProbedProvider, chainId: number): Promise<SessionProbeResult> {
  try {
    const reportedChainId = Number(await provider.send('eth_chainId', []));
    if (reportedChainId !== chainId) return { status: 'unusable', reason: 'chain-mismatch' };
    await provider.send('eth_blockNumber', []);
    return { status: 'usable' };
  } catch (error) {
    return {
      status: 'unusable',
      reason: classifyWalletError(error) === 'session-broken' ? 'provider-broken' : 'reads-failing',
    };
  }
}

/**
 * How a wallet request failed.
 * - `rejected`: the user declined it. Only an explicit rejection counts: EIP-1193 code 4001,
 *   viem's `UserRejectedRequestError`, or ethers' `ACTION_REJECTED`, which ethers raises when the
 *   wallet says the user denied the request.
 * - `session-broken`: the provider itself is broken. An extension that updates under an open tab
 *   leaves the page showing the wallet as connected while every call throws a JavaScript error,
 *   such as `Cannot read properties of undefined (reading 'sendMessage')`.
 * - `provider-failure`: anything else, an unknown outcome. Anchorage reports a refusal as a bare
 *   `-32603 Internal error`, which does not show whether the user declined or whether the request
 *   reached the chain.
 */
export type WalletErrorKind = 'rejected' | 'session-broken' | 'provider-failure';

const USER_REJECTED_REQUEST = 4001;
const BROKEN_EXTENSION_MESSAGE =
  /sendMessage|extension context invalidated|disconnected port|receiving end does not exist/i;

type ErrorFields = { code?: unknown; name?: unknown; message?: unknown; error?: unknown; cause?: unknown };

/** The error and the errors it wraps: ethers keeps the provider's error in `error`, viem in `cause`. */
function errorChain(error: unknown): ErrorFields[] {
  const chain: ErrorFields[] = [];
  const queue: unknown[] = [error];
  while (queue.length > 0 && chain.length < 8) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null || chain.includes(current as ErrorFields)) continue;
    const fields = current as ErrorFields;
    chain.push(fields);
    queue.push(fields.error, fields.cause);
  }
  return chain;
}

function isRejection({ code, name }: ErrorFields): boolean {
  return code === USER_REJECTED_REQUEST || code === 'ACTION_REJECTED' || name === 'UserRejectedRequestError';
}

function isBrokenProvider(fields: ErrorFields): boolean {
  if (fields instanceof TypeError || fields.name === 'TypeError') return true;
  return typeof fields.message === 'string' && BROKEN_EXTENSION_MESSAGE.test(fields.message);
}

export function classifyWalletError(error: unknown): WalletErrorKind {
  const chain = errorChain(error);
  if (chain.some(isRejection)) return 'rejected';
  if (chain.some(isBrokenProvider)) return 'session-broken';
  return 'provider-failure';
}

/** A short description of a wallet error for the UI, without assuming what it means. */
export function describeWalletError(error: unknown): string {
  const [first] = errorChain(error);
  const message = typeof first?.message === 'string' && first.message !== '' ? first.message : 'Unknown error';
  return typeof first?.code === 'number' || typeof first?.code === 'string' ? `${message} (${first.code})` : message;
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
 * one: `eth_blockNumber` needs the wallet's node, while `eth_chainId` may be answered locally.
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

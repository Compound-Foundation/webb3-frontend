import {
  ANCHORAGE_CONNECTOR_ID,
  WRAPPED_MARKET_REGISTRY,
  WrappedMarket,
  WrappedMarketIdentity,
  WrappedMarketLookup,
  WrappedMarketRegistry,
} from '@constants/wrappedMarkets';
import { isConnectorConflicted } from '@helpers/walletConnectors';
import type { ScreeningStatus } from '@hooks/useAddressScreening';

export type WriteBlockReason =
  | 'missing-mapping'
  | 'invalid-mapping'
  | 'watch-only'
  | 'disconnected'
  | 'reconnecting'
  | 'connector-conflict'
  | 'screening'
  | 'no-account'
  | 'no-signer'
  | 'wrong-chain'
  | 'validation-pending'
  | 'validation-failed'
  | 'asset-mismatch'
  | 'metadata-mismatch'
  | 'deposits-disabled'
  | 'exits-disabled';

/** Whether an action may be offered, and if not, the first reason it may not. */
export type Eligibility = { eligible: true } | { eligible: false; reason: WriteBlockReason; requiredChainId?: number };

/** The parts of the selected wagmi connector that routing reads. */
export type SessionConnector = { id: string; uid?: string; rdns?: string | readonly string[] };

export type LendingSession = {
  /** The selected write connector, `web3.write.connector`. Undefined when disconnected or watch-only. */
  connector: SessionConnector | undefined;
  /** wagmi's connection status. `isActive` is already true while wagmi reconnects, so it is not enough. */
  status: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
  /** `web3.write.account`, which the screening gate leaves undefined unless the address is allowed. */
  account: string | undefined;
  chainId: number | undefined;
  /** The page shows an `?account=` address the user has no signer for. */
  isWatchOnly: boolean;
  /** A wallet provider and connector client exist for this account and chain. */
  signerReady: boolean;
  screeningStatus: ScreeningStatus;
};

export type ValidationStatus = 'pending' | 'matched' | 'asset-mismatch' | 'metadata-mismatch' | 'failed';

/** The result of reading a wrapper's configuration on chain, for the route `key` names. */
export type WrapperValidation = { key: string; status: ValidationStatus };

export type LendingRoute =
  | {
      kind: 'standard';
      /** The session gates, for information only: direct Comet actions keep their existing checks. */
      writes: Eligibility;
    }
  | {
      kind: 'wrapped';
      chainId: number;
      cometAddress: string;
      lookup: WrappedMarketLookup;
      /** Wrapper metadata, kept whether or not deposits or exits are enabled. */
      market: WrappedMarket | undefined;
      /** The key a validation result must carry to apply to this route. */
      validationKey: string | undefined;
      /** Reading positions through the wrapper. Independent of the session's write gates. */
      reads: Eligibility;
      deposit: Eligibility;
      exit: Eligibility;
    };

export type LendingRouteInput = {
  market: WrappedMarketIdentity | undefined;
  session: LendingSession;
  conflictedRdns: ReadonlySet<string>;
  validation: WrapperValidation | undefined;
  registry?: WrappedMarketRegistry;
};

const ELIGIBLE: Eligibility = Object.freeze({ eligible: true });

function block(reason: WriteBlockReason, requiredChainId?: number): Eligibility {
  return requiredChainId === undefined ? { eligible: false, reason } : { eligible: false, reason, requiredChainId };
}

/**
 * Identifies one route for one session. A validation result applies only to the key it was
 * read for, so any change of market, wrapper, connector, account, chain or connection status
 * discards it in the same render.
 */
export function wrappedRouteKey(market: WrappedMarket, session: LendingSession): string {
  return [
    market.chainId,
    market.cometAddress.toLowerCase(),
    market.wrapperAddress.toLowerCase(),
    market.baseTokenAddress.toLowerCase(),
    session.connector?.id ?? '',
    session.connector?.uid ?? '',
    session.account?.toLowerCase() ?? '',
    session.chainId ?? '',
    session.status,
  ].join('|');
}

/** The gates every write passes, whichever contract it goes to. */
function sessionGate(
  session: LendingSession,
  conflictedRdns: ReadonlySet<string>,
  requiredChainId: number | undefined,
): Eligibility {
  if (session.isWatchOnly) return block('watch-only');
  if (session.status === 'disconnected') return block('disconnected');
  if (session.status !== 'connected') return block('reconnecting');
  // Checked here as well as in Web3Context, which disconnects a conflicted session only in an
  // effect after this render.
  if (session.connector === undefined || isConnectorConflicted(session.connector, conflictedRdns)) {
    return block(session.connector === undefined ? 'disconnected' : 'connector-conflict');
  }
  if (session.screeningStatus !== 'allowed') return block('screening');
  if (session.account === undefined || session.account === '') return block('no-account');
  if (!session.signerReady) return block('no-signer');
  if (requiredChainId !== undefined && session.chainId !== requiredChainId)
    return block('wrong-chain', requiredChainId);
  return ELIGIBLE;
}

function validationGate(validation: WrapperValidation | undefined, key: string): Eligibility {
  if (validation === undefined || validation.key !== key) return block('validation-pending');
  switch (validation.status) {
    case 'matched':
      return ELIGIBLE;
    case 'asset-mismatch':
      return block('asset-mismatch');
    case 'metadata-mismatch':
      return block('metadata-mismatch');
    case 'failed':
      return block('validation-failed');
    default:
      return block('validation-pending');
  }
}

function first(...gates: Eligibility[]): Eligibility {
  return gates.find((gate) => !gate.eligible) ?? ELIGIBLE;
}

/**
 * Decide, once, how the selected market is lent through for this session. The route is
 * wrapped only when the selected connector's id is Anchorage's and the registry knows the
 * market. Balances, wallet names, installed extensions and the stored connector preference
 * are not inputs, so none of them can select it. A wrapped route never turns standard
 * because something is wrong: it stays wrapped and reports why its actions are disabled.
 */
export function resolveLendingRoute({
  market,
  session,
  conflictedRdns,
  validation,
  registry = WRAPPED_MARKET_REGISTRY,
}: LendingRouteInput): LendingRoute {
  const lookup: WrappedMarketLookup =
    market === undefined ? { status: 'unconfigured' } : registry.lookup(market.chainId, market.cometAddress);

  if (market === undefined || session.connector?.id !== ANCHORAGE_CONNECTOR_ID || lookup.status === 'unconfigured') {
    return { kind: 'standard', writes: sessionGate(session, conflictedRdns, market?.chainId) };
  }

  if (lookup.status === 'invalid') {
    const mapping = block(lookup.problem === 'missing' ? 'missing-mapping' : 'invalid-mapping');
    return {
      kind: 'wrapped',
      chainId: market.chainId,
      cometAddress: market.cometAddress,
      lookup,
      market: undefined,
      validationKey: undefined,
      reads: mapping,
      deposit: mapping,
      exit: mapping,
    };
  }

  const wrapped = lookup.market;
  const validationKey = wrappedRouteKey(wrapped, session);
  const validated = validationGate(validation, validationKey);
  const writes = first(sessionGate(session, conflictedRdns, wrapped.chainId), validated);

  return {
    kind: 'wrapped',
    chainId: wrapped.chainId,
    cometAddress: wrapped.cometAddress,
    lookup,
    market: wrapped,
    validationKey,
    reads: validated,
    deposit: first(writes, wrapped.depositsEnabled ? ELIGIBLE : block('deposits-disabled')),
    exit: first(writes, wrapped.exitsEnabled ? ELIGIBLE : block('exits-disabled')),
  };
}

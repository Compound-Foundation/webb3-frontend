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
  | 'wrong-chain'
  | 'no-signer'
  | 'validation-pending'
  | 'validation-failed'
  | 'not-canonical'
  | 'asset-mismatch'
  | 'metadata-mismatch'
  | 'deposits-disabled'
  | 'exits-disabled';

/** Whether an action can be offered. When it cannot, the first reason that blocks it. */
export type Eligibility =
  { isEligible: true } | { isEligible: false; reason: WriteBlockReason; requiredChainId?: number };

/** The parts of the selected wagmi connector that routing reads. */
export type SessionConnector = { id: string; uid?: string; rdns?: string | readonly string[] };

export type LendingSession = {
  /** The selected write connector, `web3.write.connector`. Undefined when disconnected or watch-only. */
  connector: SessionConnector | undefined;
  /** wagmi's connection status. `isActive` is already true while wagmi reconnects, so it is not enough. */
  status: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
  /** `web3.write.account`. Web3Context clears it when screening has not allowed the address. */
  account: string | undefined;
  chainId: number | undefined;
  /** The page shows an `?account=` address the user has no signer for. */
  isWatchOnly: boolean;
  /** The wallet provider was built from the current connector client, for this account and chain. */
  isSignerReady: boolean;
  screeningStatus: ScreeningStatus;
};

export type ValidationStatus =
  'pending' | 'matched' | 'not-canonical' | 'asset-mismatch' | 'metadata-mismatch' | 'failed';

/** The result of reading a wrapper's configuration on chain, for the route `key` names. */
export type WrapperValidation = { key: string; status: ValidationStatus };

export type LendingRoute =
  | {
      kind: 'standard';
      /** The session gates, for information only. Direct Comet actions keep their existing checks. */
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

const ELIGIBLE: Eligibility = Object.freeze({ isEligible: true });

function ineligible(reason: WriteBlockReason, requiredChainId?: number): Eligibility {
  return requiredChainId === undefined ? { isEligible: false, reason } : { isEligible: false, reason, requiredChainId };
}

/**
 * Identifies one route for one session. A validation result applies only to the key it was
 * read for. The key covers every field of the mapping and the session's connector, account,
 * chain and connection status.
 */
export function wrappedRouteKey(market: WrappedMarket, session: LendingSession): string {
  return [
    market.chainId,
    market.cometAddress.toLowerCase(),
    market.wrapperAddress.toLowerCase(),
    market.baseTokenAddress.toLowerCase(),
    market.baseDecimals,
    market.shareDecimals,
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
  if (session.isWatchOnly) return ineligible('watch-only');
  if (session.status === 'disconnected') return ineligible('disconnected');
  if (session.status !== 'connected') return ineligible('reconnecting');
  if (session.connector === undefined) return ineligible('disconnected');
  // Web3Context also disconnects a conflicted session, but only in an effect after this render.
  if (isConnectorConflicted(session.connector, conflictedRdns)) return ineligible('connector-conflict');
  if (session.screeningStatus !== 'allowed') return ineligible('screening');
  if (session.account === undefined || session.account === '') return ineligible('no-account');
  // Before the signer check: on a chain the app does not configure, the connector client has
  // no chain, and the user has to be asked to switch rather than told there is no signer.
  if (requiredChainId !== undefined && session.chainId !== requiredChainId) {
    return ineligible('wrong-chain', requiredChainId);
  }
  if (!session.isSignerReady) return ineligible('no-signer');
  return ELIGIBLE;
}

function validationGate(validation: WrapperValidation | undefined, key: string): Eligibility {
  if (validation === undefined || validation.key !== key) return ineligible('validation-pending');
  switch (validation.status) {
    case 'matched':
      return ELIGIBLE;
    case 'not-canonical':
    case 'asset-mismatch':
    case 'metadata-mismatch':
      return ineligible(validation.status);
    case 'failed':
      return ineligible('validation-failed');
    default:
      return ineligible('validation-pending');
  }
}

function firstIneligible(...gates: Eligibility[]): Eligibility {
  return gates.find((gate) => !gate.isEligible) ?? ELIGIBLE;
}

/**
 * Decides, once, how the selected market is lent through for this session. The route is
 * wrapped only when the selected connector's id is Anchorage's and the registry knows the
 * market. Balances, wallet names, installed extensions and the stored connector preference
 * are not inputs, so none of them can select it. A wrapped route never turns standard
 * because something is wrong. It stays wrapped and reports why its actions are disabled.
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
    const mapping = ineligible(lookup.problem === 'missing' ? 'missing-mapping' : 'invalid-mapping');
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
  const writes = firstIneligible(sessionGate(session, conflictedRdns, wrapped.chainId), validated);

  return {
    kind: 'wrapped',
    chainId: wrapped.chainId,
    cometAddress: wrapped.cometAddress,
    lookup,
    market: wrapped,
    validationKey,
    reads: validated,
    deposit: firstIneligible(writes, wrapped.isDepositEnabled ? ELIGIBLE : ineligible('deposits-disabled')),
    exit: firstIneligible(writes, wrapped.isExitEnabled ? ELIGIBLE : ineligible('exits-disabled')),
  };
}

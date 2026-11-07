import {
  ANCHORAGE_CONNECTOR_ID,
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WRAPPED_MARKET_REGISTRY,
  WrappedMarket,
  WrappedMarketRegistry,
  WrappedMarketSource,
} from '@constants/wrappedMarkets';
import { CONNECTOR_LOCALSTORAGE_KEY } from '@helpers/constants';
import { getIsDeprecatedwUSDMMarket } from '@helpers/deprecatedMarkets';
import {
  Eligibility,
  LendingRoute,
  LendingSession,
  resolveLendingRoute,
  SessionConnector,
  ValidationStatus,
  wrappedRouteKey,
} from '@helpers/lendingRoute';
import { getMarket, getMarkets, marketKey, MARKETS, V2_MARKET } from '@helpers/markets';

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';

const CONFIGURED = [
  ['Ethereum USDC', '0xc3d688B66703497DAA19211EEdff47f25384cdc3'],
  ['Ethereum USDT', '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840'],
  ['Ethereum institutional USDC', '0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C'],
] as const;
const USDC_COMET = CONFIGURED[0][1];

/** Connectors other than Anchorage's, each with a label. */
const OTHER_CONNECTORS: [string, SessionConnector][] = [
  ['MetaMask', { id: 'io.metamask' }],
  ['WalletConnect', { id: 'walletConnect' }],
  ['Coinbase', { id: 'coinbaseWalletSDK', rdns: 'com.coinbase.wallet' }],
  ['Ledger', { id: 'ledger' }],
  ['generic injected', { id: 'injected' }],
];

/** The hardcoded registry with both release controls switched on, to observe the other gates. */
function registryWith(isDepositEnabled: boolean, isExitEnabled: boolean): WrappedMarketRegistry {
  return buildWrappedMarketRegistry({
    markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({ ...market, isDepositEnabled, isExitEnabled })),
  });
}
const OPEN_REGISTRY = registryWith(true, true);

function anchorage(overrides: Partial<LendingSession> = {}): LendingSession {
  return {
    connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-anchorage' },
    status: 'connected',
    account: ACCOUNT,
    chainId: 1,
    isWatchOnly: false,
    isSignerReady: true,
    screeningStatus: 'allowed',
    ...overrides,
  };
}

function wrappedMarket(registry: WrappedMarketRegistry, cometAddress: string): WrappedMarket {
  const lookup = registry.lookup(1, cometAddress);
  if (lookup.status !== 'valid') throw new Error(`no valid mapping for ${cometAddress}`);
  return lookup.market;
}

type ResolveOptions = {
  registry?: WrappedMarketRegistry;
  conflictedRdns?: ReadonlySet<string>;
  validation?: ValidationStatus | 'none';
  chainId?: number;
};

/** Resolve with a validation result recorded for exactly this route, unless told otherwise. */
function resolve(cometAddress: string, session: LendingSession, options: ResolveOptions = {}): LendingRoute {
  const registry = options.registry ?? OPEN_REGISTRY;
  const chainId = options.chainId ?? 1;
  const lookup = registry.lookup(chainId, cometAddress);
  const validation =
    lookup.status === 'valid' && options.validation !== 'none'
      ? { key: wrappedRouteKey(lookup.market, session), status: options.validation ?? 'matched' }
      : undefined;
  return resolveLendingRoute({
    market: { chainId, cometAddress },
    session,
    conflictedRdns: options.conflictedRdns ?? new Set(),
    validation,
    registry,
  });
}

function blocked(reason: string, requiredChainId?: number): Eligibility {
  return requiredChainId === undefined
    ? { isEligible: false, reason: reason as never }
    : { isEligible: false, reason: reason as never, requiredChainId };
}

const ELIGIBLE: Eligibility = { isEligible: true };

function expectWrapped(route: LendingRoute) {
  if (route.kind !== 'wrapped') throw new Error(`expected a wrapped route, got ${route.kind}`);
  return route;
}

describe('lendingRoute', () => {
  describe('selects wrapped deposits only for the active Anchorage connector and configured market', () => {
    it.each(CONFIGURED)('%s', (_label, cometAddress) => {
      const route = expectWrapped(resolve(cometAddress, anchorage()));
      expect(route.chainId).toBe(1);
      expect(route.cometAddress).toBe(cometAddress);
      expect(route.market).toEqual(wrappedMarket(OPEN_REGISTRY, cometAddress));
      expect(route.deposit).toEqual(ELIGIBLE);
      expect(route.exit).toEqual(ELIGIBLE);
      expect(route.reads).toEqual(ELIGIBLE);

      // The hardcoded registry keeps the route wrapped and opens deposits and exits.
      const shipped = expectWrapped(resolve(cometAddress, anchorage(), { registry: WRAPPED_MARKET_REGISTRY }));
      expect(shipped.deposit).toEqual(ELIGIBLE);
      expect(shipped.exit).toEqual(ELIGIBLE);
      expect(shipped.reads).toEqual(ELIGIBLE);
    });

    const unsupportedEthereum = MARKETS.filter(
      (market) =>
        market.chainInformation.chainId === 1 && !CONFIGURED.some(([, comet]) => comet === market.marketAddress),
    );
    it.each(unsupportedEthereum.map((market) => [marketKey(market), market] as const))(
      'unsupported Ethereum market %s stays standard',
      (_key, market) => {
        expect(market.chainInformation.chainId).toBe(1);
        expect(resolve(market.marketAddress, anchorage())).toEqual({ kind: 'standard', writes: ELIGIBLE });
      },
    );

    const otherChains = MARKETS.filter((market) => market.chainInformation.chainId !== 1);
    it.each(otherChains.map((market) => [marketKey(market), market] as const))(
      'non-Ethereum market %s stays standard',
      (_key, market) => {
        const chainId = market.chainInformation.chainId;
        const route = resolve(market.marketAddress, anchorage({ chainId }), { chainId });
        expect(route).toEqual({ kind: 'standard', writes: ELIGIBLE });
      },
    );

    it('keys on the chain as well as the address', () => {
      // A configured Comet address on another chain is not a configured market.
      expect(resolve(USDC_COMET, anchorage({ chainId: 8453 }), { chainId: 8453 }).kind).toBe('standard');
    });

    it('needs a market', () => {
      const route = resolveLendingRoute({
        market: undefined,
        session: anchorage(),
        conflictedRdns: new Set(),
        validation: undefined,
        registry: OPEN_REGISTRY,
      });
      expect(route).toEqual({ kind: 'standard', writes: ELIGIBLE });
    });
  });

  describe('keeps other connectors standard while Anchorage is installed', () => {
    // Installation is not an input: only the selected connector's id is.
    it.each(OTHER_CONNECTORS)('%s', (_label, connector) => {
      for (const [, cometAddress] of CONFIGURED) {
        const route = resolve(cometAddress, anchorage({ connector }));
        expect(route).toEqual({ kind: 'standard', writes: ELIGIBLE });
      }
    });
  });

  it('does not infer Anchorage from balances, display names or stored preferences', () => {
    window.localStorage.setItem(CONNECTOR_LOCALSTORAGE_KEY, ANCHORAGE_CONNECTOR_ID);
    try {
      const impostors = [
        // A wallet showing Anchorage's name is still MetaMask.
        { id: 'io.metamask', name: 'Anchorage Digital' },
        // Only the exact id counts.
        { id: 'COM.ANCHORAGE.CONNECT' },
        { id: ` ${ANCHORAGE_CONNECTOR_ID}` },
        // A connector whose declared rdns, but not id, is Anchorage's.
        { id: 'io.metamask', rdns: ANCHORAGE_CONNECTOR_ID },
      ];
      for (const connector of impostors) {
        expect(resolve(USDC_COMET, anchorage({ connector })).kind).toBe('standard');
      }
      // Holdings are not an input either: extra fields on the market change nothing.
      const withBalances = resolveLendingRoute({
        market: { chainId: 1, cometAddress: USDC_COMET, balance: 10n ** 6n, wrapperShares: 10n ** 18n } as never,
        session: anchorage({ connector: { id: 'io.metamask' } }),
        conflictedRdns: new Set(),
        validation: undefined,
        registry: OPEN_REGISTRY,
      });
      expect(withBalances.kind).toBe('standard');
    } finally {
      window.localStorage.removeItem(CONNECTOR_LOCALSTORAGE_KEY);
    }
  });

  it('keeps the market list and market identities unchanged', () => {
    const before = JSON.stringify(MARKETS, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    const keysBefore = getMarkets(false).map(marketKey);

    for (const market of MARKETS) {
      for (const session of [
        anchorage({ chainId: market.chainInformation.chainId }),
        anchorage({ connector: undefined }),
      ]) {
        resolve(market.marketAddress, session, { chainId: market.chainInformation.chainId });
      }
    }

    expect(JSON.stringify(MARKETS, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))).toBe(
      before,
    );
    expect(getMarkets(false).map(marketKey)).toEqual(keysBefore);
    // No wrapper is listed as a market of its own, and each configured Comet is listed exactly once.
    for (const [, cometAddress] of CONFIGURED) {
      const wrapper = wrappedMarket(OPEN_REGISTRY, cometAddress).wrapperAddress.toLowerCase();
      expect(MARKETS.some((market) => market.marketAddress.toLowerCase() === wrapper)).toBe(false);
      expect(
        MARKETS.filter((market) => market.marketAddress.toLowerCase() === cometAddress.toLowerCase()),
      ).toHaveLength(1);
    }
    // USDC and institutional USDC keep their own identities and URL slugs.
    expect(getMarket(1, CONFIGURED[0][1])?.slug).toBeUndefined();
    expect(getMarket(1, CONFIGURED[2][1])?.slug).toBe('usdc-institutional');
    expect(resolve(V2_MARKET.marketAddress, anchorage()).kind).toBe('standard');
  });

  describe('disables writes for disconnected, watch-only, missing-provider, wrong-chain and reconnecting sessions', () => {
    it.each(CONFIGURED)('%s', (_label, cometAddress) => {
      const cases: [Partial<LendingSession>, Eligibility][] = [
        [{ status: 'disconnected' }, blocked('disconnected')],
        [{ status: 'reconnecting' }, blocked('reconnecting')],
        [{ status: 'connecting' }, blocked('reconnecting')],
        [{ isWatchOnly: true }, blocked('watch-only')],
        [{ account: undefined }, blocked('no-account')],
        [{ isSignerReady: false }, blocked('no-signer')],
        // A mismatched signer chain asks for Ethereum. It never falls back to direct Comet.
        [{ chainId: 8453 }, blocked('wrong-chain', 1)],
        [{ chainId: undefined }, blocked('wrong-chain', 1)],
        // On a chain the app does not configure the signer is not ready either, and the user is
        // still asked to switch.
        [{ chainId: 56, isSignerReady: false }, blocked('wrong-chain', 1)],
      ];
      for (const [overrides, expected] of cases) {
        const route = expectWrapped(resolve(cometAddress, anchorage(overrides)));
        expect(route.deposit).toEqual(expected);
        expect(route.exit).toEqual(expected);
        expect(route.market).toEqual(wrappedMarket(OPEN_REGISTRY, cometAddress));
      }
    });

    it('reports the same session gates on the standard route', () => {
      // Disconnected and watch-only sessions carry no connector, so they route standard, and
      // still cannot write.
      expect(
        resolve(USDC_COMET, anchorage({ connector: undefined, status: 'disconnected', account: undefined })),
      ).toEqual({ kind: 'standard', writes: blocked('disconnected') });
      expect(resolve(USDC_COMET, anchorage({ connector: undefined, isWatchOnly: true, isSignerReady: false }))).toEqual(
        {
          kind: 'standard',
          writes: blocked('watch-only'),
        },
      );
      const metamask = { connector: { id: 'io.metamask' } };
      expect(resolve(USDC_COMET, anchorage({ ...metamask, chainId: 10 }))).toEqual({
        kind: 'standard',
        writes: blocked('wrong-chain', 1),
      });
      expect(resolve(USDC_COMET, anchorage({ ...metamask, status: 'reconnecting' }))).toEqual({
        kind: 'standard',
        writes: blocked('reconnecting'),
      });
    });
  });

  describe('preserves screening, connector-conflict and deprecated-market restrictions', () => {
    it.each(['idle', 'checking', 'blocked'] as const)('screening %s blocks wrapped writes', (screeningStatus) => {
      const route = expectWrapped(resolve(USDC_COMET, anchorage({ screeningStatus })));
      expect(route.deposit).toEqual(blocked('screening'));
      expect(route.exit).toEqual(blocked('screening'));
    });

    it('blocks a connector whose identity is conflicted', () => {
      const conflicted = new Set([ANCHORAGE_CONNECTOR_ID]);
      const route = expectWrapped(resolve(USDC_COMET, anchorage(), { conflictedRdns: conflicted }));
      expect(route.deposit).toEqual(blocked('connector-conflict'));
      expect(route.exit).toEqual(blocked('connector-conflict'));
      // A conflict on another wallet does not touch Anchorage.
      const elsewhere = expectWrapped(resolve(USDC_COMET, anchorage(), { conflictedRdns: new Set(['io.metamask']) }));
      expect(elsewhere.deposit).toEqual(ELIGIBLE);
      // The standard route reports a conflicted generic injected connector too.
      expect(
        resolve(USDC_COMET, anchorage({ connector: { id: 'injected' } }), { conflictedRdns: new Set(['io.metamask']) }),
      ).toEqual({ kind: 'standard', writes: blocked('connector-conflict') });
    });

    it('leaves the deprecated-market rules as they are', () => {
      // main has no deprecated-market action restriction for these markets: the only rule is
      // deprecated price-feed handling, which flags mainnet USDT. Routing neither consumes nor
      // changes it.
      const flags = MARKETS.map((market) => getIsDeprecatedwUSDMMarket(market.baseAsset, market.chainInformation));
      for (const [, cometAddress] of CONFIGURED) resolve(cometAddress, anchorage());
      expect(MARKETS.map((market) => getIsDeprecatedwUSDMMarket(market.baseAsset, market.chainInformation))).toEqual(
        flags,
      );
      const usdt = getMarket(1, CONFIGURED[1][1]);
      expect(usdt && getIsDeprecatedwUSDMMarket(usdt.baseAsset, usdt.chainInformation)).toBe(true);
      expect(expectWrapped(resolve(CONFIGURED[1][1], anchorage())).deposit).toEqual(ELIGIBLE);
    });
  });

  describe('disables deposits independently of reads and exits', () => {
    it('keeps metadata, reads and exits when deposits are off', () => {
      const registry = registryWith(false, true);
      const route = expectWrapped(resolve(USDC_COMET, anchorage(), { registry }));
      expect(route.market).toEqual(wrappedMarket(registry, USDC_COMET));
      expect(route.reads).toEqual(ELIGIBLE);
      expect(route.deposit).toEqual(blocked('deposits-disabled'));
      expect(route.exit).toEqual(ELIGIBLE);
    });

    it('keeps deposits when exits are off', () => {
      const route = expectWrapped(resolve(USDC_COMET, anchorage(), { registry: registryWith(true, false) }));
      expect(route.deposit).toEqual(ELIGIBLE);
      expect(route.exit).toEqual(blocked('exits-disabled'));
    });

    it('lets safety failures disable exits as well', () => {
      const route = expectWrapped(
        resolve(USDC_COMET, anchorage({ chainId: 8453 }), { registry: registryWith(false, true) }),
      );
      expect(route.exit).toEqual(blocked('wrong-chain', 1));
      // Reads do not depend on the session's write gates.
      expect(route.reads).toEqual(ELIGIBLE);
    });

    it('withholds reads until the wrapper is validated', () => {
      const route = expectWrapped(resolve(USDC_COMET, anchorage(), { validation: 'none' }));
      expect(route.reads).toEqual(blocked('validation-pending'));
      expect(route.deposit).toEqual(blocked('validation-pending'));
      expect(route.exit).toEqual(blocked('validation-pending'));
    });
  });

  describe('rehearses a deposit-disable rollback with registry fixtures', () => {
    // The release controls that docs/anchorage-release-runbook.md moves through. Each fixture is
    // the committed source with only the two controls changed, so each setting stays testable
    // whatever the committed controls are. "selects wrapped deposits only for…" checks the
    // shipped registry itself.
    const SETTINGS = [
      ['deposits and exits on', true, true],
      ['deposits off and exits on, the deposit-disable rollback', false, true],
      ['deposits and exits off', false, false],
    ] as const;
    const WATCH_ONLY: Partial<LendingSession> = { connector: undefined, isWatchOnly: true, isSignerReady: false };
    const UNMAPPED_MARKETS = MARKETS.filter(
      (market) => !CONFIGURED.some(([, comet]) => comet === market.marketAddress)
    );

    /** The wrapper a mapping names, with its units: every field but the two release controls. */
    function wrapperIdentity(market: WrappedMarket | undefined): Partial<WrappedMarketSource> {
      if (market === undefined) throw new Error('the route has no mapping');
      const identity: Partial<WrappedMarketSource> = { ...market };
      delete identity.isDepositEnabled;
      delete identity.isExitEnabled;
      return identity;
    }

    describe.each(SETTINGS)('with %s', (_setting, isDepositEnabled, isExitEnabled) => {
      const registry = registryWith(isDepositEnabled, isExitEnabled);

      it.each(CONFIGURED)(
        'keeps %s wrapped for Anchorage, with the same wrapper, its reads and its own controls',
        (_label, cometAddress) => {
          const route = expectWrapped(resolve(cometAddress, anchorage(), { registry }));
          const committed = wrappedMarket(WRAPPED_MARKET_REGISTRY, cometAddress);
          expect(wrapperIdentity(route.market)).toEqual(wrapperIdentity(committed));
          // The validation key holds no release control, so the same wrapper check applies.
          expect(route.validationKey).toBe(wrappedRouteKey(committed, anchorage()));
          expect(route.reads).toEqual(ELIGIBLE);
          expect(route.deposit).toEqual(isDepositEnabled ? ELIGIBLE : blocked('deposits-disabled'));
          expect(route.exit).toEqual(isExitEnabled ? ELIGIBLE : blocked('exits-disabled'));
        }
      );

      it.each(CONFIGURED)(
        'leaves other wallets and watch-only sessions on %s on the standard route',
        (_label, cometAddress) => {
          // Each result names its session, so a failure says which one broke.
          const routes = [...OTHER_CONNECTORS, ['watch-only', undefined] as const].map(([label, connector]) => ({
            label,
            route: resolve(cometAddress, anchorage(connector === undefined ? WATCH_ONLY : { connector }), { registry }),
          }));
          expect(routes).toEqual([
            ...OTHER_CONNECTORS.map(([label]) => ({ label, route: { kind: 'standard', writes: ELIGIBLE } })),
            { label: 'watch-only', route: { kind: 'standard', writes: blocked('watch-only') } },
          ]);
        }
      );

      it('leaves Anchorage on the standard route on every market without a wrapper', () => {
        const routes = UNMAPPED_MARKETS.map((market) => {
          const chainId = market.chainInformation.chainId;
          return {
            market: marketKey(market),
            route: resolve(market.marketAddress, anchorage({ chainId }), { registry, chainId }),
          };
        });
        expect(routes).toEqual(
          UNMAPPED_MARKETS.map((market) => ({
            market: marketKey(market),
            route: { kind: 'standard', writes: ELIGIBLE },
          }))
        );
      });
    });

    it('still closes exits under the rollback on a screening, wrapper-check or mapping failure', () => {
      // Comet's pause and the market's cash stop an exit at its review and its signature, not in the
      // route. See `readMarketRestriction` in wrappedActions and `planWrappedWithdrawal` in wrappedWithdrawals.
      // "lets safety failures disable exits as well" covers the wrong chain under the rollback.
      const rollback = registryWith(false, true);
      const screened = expectWrapped(
        resolve(USDC_COMET, anchorage({ screeningStatus: 'blocked' }), { registry: rollback })
      );
      expect(screened.exit).toEqual(blocked('screening'));
      const mismatched = expectWrapped(
        resolve(USDC_COMET, anchorage(), { registry: rollback, validation: 'asset-mismatch' })
      );
      expect(mismatched.reads).toEqual(blocked('asset-mismatch'));
      expect(mismatched.exit).toEqual(blocked('asset-mismatch'));

      // A broken USDC entry under the rollback's controls: its exit control is on, and still no exit opens.
      const broken = buildWrappedMarketRegistry({
        markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
          ...market,
          isDepositEnabled: false,
          isExitEnabled: true,
          shareDecimals: market.cometAddress === USDC_COMET ? 6 : market.shareDecimals,
        })),
      });
      const invalid = expectWrapped(resolve(USDC_COMET, anchorage(), { registry: broken }));
      expect(invalid.reads).toEqual(blocked('invalid-mapping'));
      expect(invalid.exit).toEqual(blocked('invalid-mapping'));
      // The other markets' entries stay valid, so their exits stay open.
      expect(expectWrapped(resolve(CONFIGURED[1][1], anchorage(), { registry: broken })).exit).toEqual(ELIGIBLE);
    });
  });

  describe('wrapper validation', () => {
    it.each([
      ['failed', 'validation-failed'],
      ['not-canonical', 'not-canonical'],
      ['asset-mismatch', 'asset-mismatch'],
      ['metadata-mismatch', 'metadata-mismatch'],
      ['pending', 'validation-pending'],
    ] as const)('%s keeps the route wrapped and disables it', (status, reason) => {
      const route = expectWrapped(resolve(USDC_COMET, anchorage(), { validation: status }));
      expect(route.reads).toEqual(blocked(reason));
      expect(route.deposit).toEqual(blocked(reason));
      expect(route.exit).toEqual(blocked(reason));
    });

    it('treats a result recorded for another route as pending', () => {
      const market = wrappedMarket(OPEN_REGISTRY, USDC_COMET);
      const previous = anchorage({ account: '0x0000000000000000000000000000000000000bb2' });
      const route = expectWrapped(
        resolveLendingRoute({
          market: { chainId: 1, cometAddress: USDC_COMET },
          session: anchorage(),
          conflictedRdns: new Set(),
          validation: { key: wrappedRouteKey(market, previous), status: 'matched' },
          registry: OPEN_REGISTRY,
        }),
      );
      expect(route.deposit).toEqual(blocked('validation-pending'));
    });

    it('keys the route on the market, wrapper, connector, account, chain and connection status', () => {
      const market = wrappedMarket(OPEN_REGISTRY, USDC_COMET);
      const key = wrappedRouteKey(market, anchorage());
      const variants: Partial<LendingSession>[] = [
        { account: '0x0000000000000000000000000000000000000bb2' },
        { connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-other' } },
        { chainId: 8453 },
        { status: 'reconnecting' },
      ];
      for (const variant of variants) expect(wrappedRouteKey(market, anchorage(variant))).not.toBe(key);
      // Every field of the mapping is part of the key.
      expect(wrappedRouteKey({ ...market, baseDecimals: 18 }, anchorage())).not.toBe(key);
      expect(wrappedRouteKey({ ...market, shareDecimals: 6 }, anchorage())).not.toBe(key);
      expect(wrappedRouteKey(wrappedMarket(OPEN_REGISTRY, CONFIGURED[1][1]), anchorage())).not.toBe(key);
      // Address case is not identity.
      expect(wrappedRouteKey(market, anchorage({ account: ACCOUNT.toUpperCase().replace('0X', '0x') }))).toBe(key);
    });

    it('reports a missing or invalid mapping on a routed market as a disabled wrapped route', () => {
      const routedOnly = buildWrappedMarketRegistry({ markets: [] });
      const missing = expectWrapped(resolve(USDC_COMET, anchorage(), { registry: routedOnly }));
      expect(missing.market).toBeUndefined();
      expect(missing.deposit).toEqual(blocked('missing-mapping'));
      expect(missing.exit).toEqual(blocked('missing-mapping'));
      expect(missing.reads).toEqual(blocked('missing-mapping'));

      // A mapping with no routed entry still routes wrapped, so dropping either half never
      // sends Anchorage straight to Comet.
      const mappingOnly = buildWrappedMarketRegistry(
        { markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({ ...market, isDepositEnabled: true })) },
        [],
      );
      expect(expectWrapped(resolve(USDC_COMET, anchorage(), { registry: mappingOnly })).deposit).toEqual(ELIGIBLE);

      const broken = buildWrappedMarketRegistry(
        { markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({ ...market, shareDecimals: 6 })) },
        [],
      );
      const invalid = expectWrapped(resolve(USDC_COMET, anchorage(), { registry: broken }));
      expect(invalid.deposit).toEqual(blocked('invalid-mapping'));
      expect(invalid.exit).toEqual(blocked('invalid-mapping'));

      // A source with an entry that names no market disables every routed market, even when
      // both its halves are lost or garbled.
      const unreadable = buildWrappedMarketRegistry({
        markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
          ...market,
          chainId: String(market.chainId) as unknown as number,
          isDepositEnabled: true,
        })),
      });
      for (const [, cometAddress] of CONFIGURED) {
        const route = expectWrapped(resolve(cometAddress, anchorage(), { registry: unreadable }));
        expect(route.deposit).toEqual(blocked('invalid-mapping'));
        expect(route.exit).toEqual(blocked('invalid-mapping'));
      }
    });
  });
});

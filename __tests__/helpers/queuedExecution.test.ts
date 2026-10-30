import {
  ANCHORAGE_CONNECTOR_ID,
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WrappedMarketRegistry,
} from '@constants/wrappedMarkets';
import { Eligibility, LendingRoute, LendingSession, resolveLendingRoute, wrappedRouteKey } from '@helpers/lendingRoute';
import { MAX_UINT256 } from '@helpers/numbers';
import {
  directActionsForRoute,
  isWrapperRouted,
  planQueuedExecution,
  wrappedEntryBlockLabel,
} from '@helpers/queuedExecution';
import { WrappedExecutionError } from '@helpers/wrappedActions';
import { Action, ActionType, TokenWithAccountState } from '@types';

import { mockBaseAsset } from '../mocks/mockBaseAsset';
import { mockEthCollateralAsset } from '../mocks/mockCollateralAssets';

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const WRAPPED_MARKETS = [
  { name: 'USDC', comet: '0xc3d688B66703497DAA19211EEdff47f25384cdc3', base: USDC },
  { name: 'USDT', comet: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840', base: USDT },
  { name: 'institutional USDC', comet: '0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C', base: USDC },
];
// The Ethereum WETH market, which no wrapper serves.
const WETH_COMET = '0xA17581A9E3356d9A858b789D68B4d866e593aE94';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const OPEN: WrappedMarketRegistry = buildWrappedMarketRegistry({
  markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
    ...market,
    isDepositEnabled: true,
    isExitEnabled: true,
  })),
});
// Both release controls closed, as a rollback leaves them.
const CLOSED: WrappedMarketRegistry = buildWrappedMarketRegistry({
  markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
    ...market,
    isDepositEnabled: false,
    isExitEnabled: false,
  })),
});

const session = (connectorId: string): LendingSession => ({
  connector: { id: connectorId, uid: 'uid-1' },
  status: 'connected',
  account: ACCOUNT,
  chainId: 1,
  isWatchOnly: false,
  isSignerReady: true,
  screeningStatus: 'allowed',
});

function routeFor(cometAddress: string, connectorId = ANCHORAGE_CONNECTOR_ID, registry = OPEN): LendingRoute {
  const live = session(connectorId);
  const lookup = registry.lookup(1, cometAddress);
  return resolveLendingRoute({
    market: { chainId: 1, cometAddress },
    session: live,
    conflictedRdns: new Set(),
    validation:
      lookup.status === 'valid' ? { key: wrappedRouteKey(lookup.market, live), status: 'matched' } : undefined,
    registry,
  });
}

const baseFor = (address: string, symbol = 'USDC') =>
  mockBaseAsset({ address, symbol, walletBalance: 5_000_000_000n, balance: 0n, allowance: 0n });
const COLLATERAL: TokenWithAccountState = mockEthCollateralAsset({ walletBalance: 10n ** 18n });

describe('isWrapperRouted and planQueuedExecution', () => {
  it.each(WRAPPED_MARKETS)(
    'routes a queued base supply and withdrawal on the $name market through its wrapper',
    ({ comet, base }) => {
      const route = routeFor(comet);
      const baseAsset = baseFor(base);
      const supply: Action = [ActionType.Supply, baseAsset, 1_000_000n];
      const withdraw: Action = [ActionType.Withdraw, baseAsset, 2_000_000n];

      expect(route.kind).toBe('wrapped');
      expect(isWrapperRouted(route, supply)).toBe(true);
      expect(isWrapperRouted(route, withdraw)).toBe(true);
      expect(planQueuedExecution(route, baseAsset, [], [supply])).toEqual({
        wrapper: { type: 'supply', action: supply, amount: 1_000_000n },
        direct: [],
      });
      expect(planQueuedExecution(route, baseAsset, [], [withdraw])).toEqual({
        wrapper: { type: 'withdraw', action: withdraw, request: { kind: 'partial', cash: 2_000_000n } },
        direct: [],
      });
    }
  );

  it.each(WRAPPED_MARKETS)('keeps every action direct for another wallet on the $name market', ({ comet, base }) => {
    const route = routeFor(comet, 'io.metamask');
    const baseAsset = baseFor(base);
    const actions: Action[] = [
      [ActionType.Supply, baseAsset, 1_000_000n],
      [ActionType.SupplyCollateral, COLLATERAL, 10n ** 17n],
    ];

    expect(route.kind).toBe('standard');
    expect(actions.some((action) => isWrapperRouted(route, action))).toBe(false);
    expect(planQueuedExecution(route, baseAsset, [COLLATERAL], actions)).toEqual({
      wrapper: undefined,
      direct: actions,
    });
    expect(directActionsForRoute(route, actions)).toEqual(actions);
  });

  it('keeps every action direct for the Anchorage connector on a market without a wrapper', () => {
    const route = routeFor(WETH_COMET);
    const baseAsset = baseFor(WETH, 'WETH');
    const supply: Action = [ActionType.Supply, baseAsset, 10n ** 18n];

    expect(route.kind).toBe('standard');
    expect(isWrapperRouted(route, supply)).toBe(false);
    expect(planQueuedExecution(route, baseAsset, [], [supply])).toEqual({ wrapper: undefined, direct: [supply] });
  });

  it('routes a base supply through the wrapper even while deposits are closed, so it never falls back to Comet', () => {
    const route = routeFor(WRAPPED_MARKETS[0].comet, ANCHORAGE_CONNECTOR_ID, CLOSED);
    const supply: Action = [ActionType.Supply, baseFor(USDC), 1_000_000n];

    expect(route.kind).toBe('wrapped');
    expect(planQueuedExecution(route, baseFor(USDC), [], [supply]).direct).toEqual([]);
  });

  it('keeps the other actions of a mixed queue direct, in their queued order', () => {
    const route = routeFor(WRAPPED_MARKETS[1].comet);
    const baseAsset = baseFor(USDT, 'USDT');
    const supplyCollateral: Action = [ActionType.SupplyCollateral, COLLATERAL, 10n ** 17n];
    const supply: Action = [ActionType.Supply, baseAsset, 3_000_000n];
    const withdrawCollateral: Action = [ActionType.WithdrawCollateral, COLLATERAL, 10n ** 16n];

    const plan = planQueuedExecution(route, baseAsset, [COLLATERAL], [supplyCollateral, supply, withdrawCollateral]);
    expect(plan.wrapper).toEqual({ type: 'supply', action: supply, amount: 3_000_000n });
    expect(plan.direct).toEqual([supplyCollateral, withdrawCollateral]);
    expect(directActionsForRoute(route, [supplyCollateral, supply, withdrawCollateral])).toEqual([
      supplyCollateral,
      withdrawCollateral,
    ]);
  });

  it('turns a maximum supply into the wallet balance the earlier actions leave', () => {
    const route = routeFor(WRAPPED_MARKETS[0].comet);
    const baseAsset = { ...baseFor(USDC), balance: -1_000_000_000n };
    const repay: Action = [ActionType.Repay, baseAsset, 1_000_000_000n];
    const supply: Action = [ActionType.Supply, baseAsset, MAX_UINT256];

    const plan = planQueuedExecution(route, baseAsset, [], [repay, supply]);
    expect(plan.wrapper).toEqual({ type: 'supply', action: supply, amount: 4_000_000_000n });
    expect(plan.direct).toEqual([repay]);
  });

  it('turns a maximum withdrawal into a full exit', () => {
    const route = routeFor(WRAPPED_MARKETS[2].comet);
    const withdraw: Action = [ActionType.Withdraw, baseFor(USDC), MAX_UINT256];

    expect(planQueuedExecution(route, baseFor(USDC), [], [withdraw]).wrapper).toEqual({
      type: 'withdraw',
      action: withdraw,
      request: { kind: 'full' },
    });
  });

  it('refuses a queue holding two wrapper actions, rather than submitting one of them', () => {
    const route = routeFor(WRAPPED_MARKETS[0].comet);
    const baseAsset = baseFor(USDC);
    const actions: Action[] = [
      [ActionType.Supply, baseAsset, 1_000_000n],
      [ActionType.Withdraw, baseAsset, 1_000_000n],
    ];

    expect(() => planQueuedExecution(route, baseAsset, [], actions)).toThrow(WrappedExecutionError);
  });

  it("refuses a base action whose token is not the wrapper's base token", () => {
    const route = routeFor(WRAPPED_MARKETS[0].comet);
    const other = baseFor(USDT, 'USDT');

    expect(() => planQueuedExecution(route, other, [], [[ActionType.Supply, other, 1_000_000n]])).toThrow(
      WrappedExecutionError
    );
  });
});

describe('wrappedEntryBlockLabel', () => {
  type WrappedRoute = Extract<LendingRoute, { kind: 'wrapped' }>;
  const OPEN_ROUTE = routeFor(WRAPPED_MARKETS[0].comet) as WrappedRoute;
  /** The open route with `eligibility` for both actions. */
  const routeWith = (eligibility: Eligibility): WrappedRoute => ({
    ...OPEN_ROUTE,
    deposit: eligibility,
    exit: eligibility,
  });

  it('lets the amount be queued when the action is eligible, or only waits for a network switch', () => {
    expect(wrappedEntryBlockLabel(OPEN_ROUTE, 'supply')).toBeUndefined();
    expect(
      wrappedEntryBlockLabel(routeWith({ isEligible: false, reason: 'wrong-chain', requiredChainId: 1 }), 'withdraw')
    ).toBe(undefined);
  });

  it('names closed release controls', () => {
    const closed = routeFor(WRAPPED_MARKETS[0].comet, ANCHORAGE_CONNECTOR_ID, CLOSED) as WrappedRoute;

    expect(wrappedEntryBlockLabel(closed, 'supply')).toBe('Supply Not Open Yet');
    expect(wrappedEntryBlockLabel(closed, 'withdraw')).toBe('Withdrawals Not Open Yet');
  });

  it('names closed release controls for a wallet on another network too', () => {
    const live = { ...session(ANCHORAGE_CONNECTOR_ID), chainId: 8453 };
    const lookup = CLOSED.lookup(1, WRAPPED_MARKETS[1].comet);
    if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
    const route = resolveLendingRoute({
      market: { chainId: 1, cometAddress: WRAPPED_MARKETS[1].comet },
      session: live,
      conflictedRdns: new Set(),
      validation: { key: wrappedRouteKey(lookup.market, live), status: 'matched' },
      registry: CLOSED,
    }) as WrappedRoute;

    expect(route.deposit).toMatchObject({ isEligible: false, reason: 'wrong-chain' });
    expect(wrappedEntryBlockLabel(route, 'supply')).toBe('Supply Not Open Yet');
    expect(wrappedEntryBlockLabel(route, 'withdraw')).toBe('Withdrawals Not Open Yet');
  });

  it('names a failed wrapper check, screening and a pending check', () => {
    for (const reason of ['not-canonical', 'asset-mismatch', 'metadata-mismatch', 'validation-failed'] as const) {
      expect(wrappedEntryBlockLabel(routeWith({ isEligible: false, reason }), 'supply')).toBe(
        'Unavailable For This Market'
      );
    }
    expect(wrappedEntryBlockLabel(routeWith({ isEligible: false, reason: 'screening' }), 'supply')).toBe(
      'Unavailable For This Market'
    );
    expect(wrappedEntryBlockLabel(routeWith({ isEligible: false, reason: 'validation-pending' }), 'withdraw')).toBe(
      'Checking Your Wallet And This Market'
    );
  });
});

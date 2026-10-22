import { Interface } from '@ethersproject/abi';

import {
  ANCHORAGE_CONNECTOR_ID,
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WrappedMarketRegistry,
} from '@constants/wrappedMarkets';
import { LendingRoute, LendingSession, resolveLendingRoute, wrappedRouteKey } from '@helpers/lendingRoute';
import {
  checkBeforeSignature,
  checkWrappedDraft,
  checkWrappedStep,
  isDirectExecution,
  isSameWrappedIdentity,
  planExecution,
  readMarketRestriction,
  submitExecution,
  WRAPPED_ACTION,
  WrappedActionDraft,
  WrappedActionType,
  WrappedExecutionError,
  WrappedSession,
  WrappedStep,
  wrappedActionIdentity,
} from '@helpers/wrappedActions';
import { Action, ActionType } from '@types';

import { mockBaseAsset } from '../mocks/mockBaseAsset';
import { mockCompCollateralAsset } from '../mocks/mockCollateralAssets';

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000bb2';
const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';
const USDC_WRAPPER = '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73';
const USDT_WRAPPER = '0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const BULKER = '0xa397a8C2086C554B531c02E29f3291c9704B00c7';
const PROVIDER = { name: 'wallet provider' };

const CALLS = new Interface([
  'function approve(address spender, uint256 amount)',
  'function supplyAndWrap(uint256 amount)',
  'function unwrapAndWithdraw(uint256 shares)',
  'function supply(address asset, uint256 amount)',
  'function withdraw(address asset, uint256 amount)',
]);

function registry({ deposits = true, exits = true } = {}): WrappedMarketRegistry {
  return buildWrappedMarketRegistry({
    markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
      ...market,
      isDepositEnabled: deposits,
      isExitEnabled: exits,
    })),
  });
}

type SessionSetup = Partial<LendingSession> & { cometAddress?: string; registry?: WrappedMarketRegistry };

/** The session and route the app would have, with the wrapper validated for this session. */
function liveSession(setup: SessionSetup = {}, provider: object | undefined = PROVIDER): WrappedSession {
  const session: LendingSession = {
    connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-1' },
    status: 'connected',
    account: ACCOUNT,
    chainId: 1,
    isWatchOnly: false,
    isSignerReady: true,
    screeningStatus: 'allowed',
    ...setup,
  };
  const cometAddress = setup.cometAddress ?? USDC_COMET;
  const routeRegistry = setup.registry ?? registry();
  const lookup = routeRegistry.lookup(1, cometAddress);
  const key = lookup.status === 'valid' ? wrappedRouteKey(lookup.market, session) : '';
  const route: LendingRoute = resolveLendingRoute({
    market: { chainId: 1, cometAddress },
    session,
    conflictedRdns: new Set(),
    validation: { key, status: 'matched' },
    registry: routeRegistry,
  });
  return {
    route,
    account: session.account,
    chainId: session.chainId,
    screeningStatus: session.screeningStatus,
    provider,
  };
}

function step(kind: WrappedStep['kind'], to: string, data: string, id: string = kind): WrappedStep {
  return { id, kind, description: kind, request: { to, data } };
}

const approve = (spender = USDC_WRAPPER, amount = 1_000_000n, to = USDC) =>
  step('approve', to, CALLS.encodeFunctionData('approve', [spender, amount]));
const supplyAndWrap = (to = USDC_WRAPPER) =>
  step('supply-and-wrap', to, CALLS.encodeFunctionData('supplyAndWrap', [1_000_000n]));
const unwrapAndWithdraw = (to = USDC_WRAPPER) =>
  step('unwrap-and-withdraw', to, CALLS.encodeFunctionData('unwrapAndWithdraw', [10n ** 18n]));

function draft(type: WrappedActionType, steps: WrappedStep[], session = liveSession()): WrappedActionDraft {
  const identity = wrappedActionIdentity(type, session);
  if (identity === undefined) throw new Error('the session must have a wrapped identity');
  return { kind: WRAPPED_ACTION, id: 'draft-1', identity, amount: 1_000_000n, steps };
}

const BASE_ASSET = mockBaseAsset({ address: USDC });
const BORROW: Action = [ActionType.Borrow, BASE_ASSET, 1_000_000n];
const REPAY: Action = [ActionType.Repay, BASE_ASSET, 1_000_000n];
const SUPPLY_COLLATERAL: Action = [ActionType.SupplyCollateral, mockCompCollateralAsset(), 10n ** 18n];

describe('wrappedActions', () => {
  describe('execution', () => {
    it.each<[string, unknown[]]>([
      ['direct actions then a wrapper draft', [BORROW, SUPPLY_COLLATERAL, draft('supply', [supplyAndWrap()])]],
      ['a wrapper draft then direct actions', [draft('supply', [supplyAndWrap()]), REPAY]],
      ['a withdrawal draft between direct actions', [REPAY, draft('withdraw', [unwrapAndWithdraw()]), BORROW]],
    ])('rejects mixed direct/wrapped execution before either transaction is submitted: %s', (_name, entries) => {
      const direct = jest.fn();
      const wrapped = jest.fn();

      expect(() => submitExecution(entries, { direct, wrapped })).toThrow(
        expect.objectContaining({ name: 'WrappedExecutionError', problem: 'mixed-execution' })
      );
      expect(direct).not.toHaveBeenCalled();
      expect(wrapped).not.toHaveBeenCalled();
    });

    it.each<[string, unknown[], string]>([
      [
        'a direct action naming wrapper shares',
        [BORROW, [ActionType.SupplyCollateral, { ...mockCompCollateralAsset(), address: USDC_WRAPPER }, 1n]],
        'wrapped-action',
      ],
      [
        'two wrapper drafts',
        [draft('supply', [supplyAndWrap()]), draft('withdraw', [unwrapAndWithdraw()])],
        'several-wrapped-actions',
      ],
      ['an entry that is not an action', [BORROW, ['wrapped-supply', BASE_ASSET, 1n]], 'unknown-entry'],
      ['nothing that is an action', [undefined], 'unknown-entry'],
    ])('refuses %s whole, submitting nothing', (_name, entries, problem) => {
      const direct = jest.fn();
      const wrapped = jest.fn();

      expect(() => submitExecution(entries, { direct, wrapped })).toThrow(expect.objectContaining({ problem }));
      expect(direct).not.toHaveBeenCalled();
      expect(wrapped).not.toHaveBeenCalled();
    });

    it('sends direct actions down the direct path and one draft down the wrapper path', () => {
      const supply = draft('supply', [approve(), supplyAndWrap()]);
      const direct = jest.fn(() => 'direct');
      const wrapped = jest.fn(() => 'wrapped');

      expect(submitExecution([BORROW, REPAY], { direct, wrapped })).toBe('direct');
      expect(direct).toHaveBeenCalledWith([BORROW, REPAY]);
      expect(submitExecution([supply], { direct, wrapped })).toBe('wrapped');
      expect(wrapped).toHaveBeenCalledWith(supply);
      expect(planExecution([])).toEqual({ kind: 'none' });
    });

    it('tells whether a request would go down the direct path whole', () => {
      expect(isDirectExecution([BORROW, REPAY])).toBe(true);
      expect(isDirectExecution([BORROW, draft('supply', [supplyAndWrap()])])).toBe(false);
      expect(isDirectExecution([draft('supply', [supplyAndWrap()])])).toBe(false);
      expect(isDirectExecution([])).toBe(false);
    });

    it('throws a typed error', () => {
      expect(() => planExecution([BORROW, draft('supply', [supplyAndWrap()])])).toThrow(WrappedExecutionError);
    });
  });

  describe('identity', () => {
    it("is the route's validation key with the account, chain, contracts, screening and release control", () => {
      const session = liveSession();
      const identity = wrappedActionIdentity('supply', session);

      expect(identity).toEqual({
        type: 'supply',
        routeKey: session.route.kind === 'wrapped' ? session.route.validationKey : '',
        account: ACCOUNT,
        chainId: 1,
        cometAddress: USDC_COMET,
        wrapperAddress: USDC_WRAPPER,
        baseTokenAddress: USDC,
        screeningStatus: 'allowed',
        isReleased: true,
        provider: PROVIDER,
      });
    });

    it('does not exist without a wrapped route, an account or a wallet provider', () => {
      const standard: WrappedSession = { ...liveSession(), route: { kind: 'standard', writes: { isEligible: true } } };

      expect(wrappedActionIdentity('supply', standard)).toBeUndefined();
      expect(wrappedActionIdentity('supply', { ...liveSession(), account: undefined })).toBeUndefined();
      expect(wrappedActionIdentity('supply', { ...liveSession(), provider: undefined })).toBeUndefined();
      expect(
        wrappedActionIdentity('supply', liveSession({ registry: buildWrappedMarketRegistry({ markets: [] }) }))
      ).toBeUndefined();
    });

    it.each<[string, WrappedSession]>([
      ['account', liveSession({ account: OTHER_ACCOUNT })],
      ['connector', liveSession({ connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-2' } })],
      ['connection status', liveSession({ status: 'reconnecting' })],
      ['chain', liveSession({ chainId: 8453 })],
      ['market and wrapper', liveSession({ cometAddress: USDT_COMET })],
      ['screening status', liveSession({ screeningStatus: 'checking' })],
      ['release control', liveSession({ registry: registry({ deposits: false }) })],
      ['wallet provider', liveSession({}, { name: 'rebuilt wallet provider' })],
    ])('changes with the %s', (_name, changed) => {
      const reviewed = wrappedActionIdentity('supply', liveSession());

      expect(isSameWrappedIdentity(reviewed, wrappedActionIdentity('supply', changed))).toBe(false);
      expect(isSameWrappedIdentity(reviewed, wrappedActionIdentity('supply', liveSession()))).toBe(true);
    });
  });

  describe('submission guard', () => {
    it('allows an approval of the base token to the wrapper and the wrapper calls', () => {
      const supply = draft('supply', [{ ...approve(USDC_WRAPPER, 0n), id: 'reset' }, approve(), supplyAndWrap()]);

      expect(supply.steps.map((supplyStep) => checkWrappedStep(supply, supplyStep))).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(checkWrappedDraft(supply)).toBeUndefined();
      expect(checkWrappedDraft(draft('withdraw', [unwrapAndWithdraw()]))).toBeUndefined();
    });

    it.each<[string, WrappedActionType, WrappedStep, string]>([
      [
        "Comet's supply",
        'supply',
        step('supply-and-wrap', USDC_COMET, CALLS.encodeFunctionData('supply', [USDC, 1n])),
        'wrong-target',
      ],
      ['supplyAndWrap sent to Comet', 'supply', supplyAndWrap(USDC_COMET), 'wrong-target'],
      [
        "Comet's withdraw on the wrapper",
        'withdraw',
        step('unwrap-and-withdraw', USDC_WRAPPER, CALLS.encodeFunctionData('withdraw', [USDC, 1n])),
        'malformed-call',
      ],
      ['an approval to Comet', 'supply', approve(USDC_COMET), 'wrong-spender'],
      ['an approval to the Bulker', 'supply', approve(BULKER), 'wrong-spender'],
      ['an approval of another token', 'supply', approve(USDC_WRAPPER, 1n, USDT_WRAPPER), 'wrong-target'],
      ["another market's wrapper", 'supply', supplyAndWrap(USDT_WRAPPER), 'wrong-target'],
      ['an exit in a supply', 'supply', unwrapAndWithdraw(), 'step-not-allowed'],
      ['an approval in a withdrawal', 'withdraw', approve(), 'step-not-allowed'],
      [
        'unwrapAndWithdraw labelled as a supply',
        'supply',
        step('supply-and-wrap', USDC_WRAPPER, CALLS.encodeFunctionData('unwrapAndWithdraw', [1n])),
        'wrong-method',
      ],
      [
        'trailing bytes',
        'supply',
        step('supply-and-wrap', USDC_WRAPPER, `${CALLS.encodeFunctionData('supplyAndWrap', [1n])}00`),
        'malformed-call',
      ],
    ])('refuses %s', (_name, type, refusedStep, problem) => {
      const refused = draft(type, [refusedStep]);

      expect(checkWrappedStep(refused, refusedStep)).toBe(problem);
      expect(checkWrappedDraft(refused)).toBe(problem);
    });

    it.each<[string, WrappedActionType, WrappedStep[]]>([
      ['no steps', 'supply', []],
      ['an approval after the supply', 'supply', [supplyAndWrap(), approve()]],
      [
        'two supplies',
        'supply',
        [step('supply-and-wrap', USDC_WRAPPER, supplyAndWrap().request.data, 'a'), supplyAndWrap()],
      ],
      ['an approval alone', 'supply', [approve()]],
      ['repeated step ids', 'supply', [approve(), { ...supplyAndWrap(), id: 'approve' }]],
    ])('refuses a draft with %s', (_name, type, steps) => {
      expect(checkWrappedDraft(draft(type, steps))).toBe('bad-sequence');
    });
  });

  describe('checkBeforeSignature', () => {
    const reviewed = draft('supply', [approve(), supplyAndWrap()]);
    const [approval] = reviewed.steps;

    it('passes in the session the draft was reviewed in', () => {
      expect(checkBeforeSignature(reviewed, approval, liveSession(), false)).toBeUndefined();
    });

    it.each<[string, WrappedSession, string]>([
      ['the account changed', liveSession({ account: OTHER_ACCOUNT }), 'identity-changed'],
      ['the chain changed', liveSession({ chainId: 8453 }), 'identity-changed'],
      ['the wrapper changed', liveSession({ cometAddress: USDT_COMET }), 'identity-changed'],
      ['screening is no longer allowed', liveSession({ screeningStatus: 'blocked' }), 'identity-changed'],
      ['deposits were turned off', liveSession({ registry: registry({ deposits: false }) }), 'identity-changed'],
      ['the wallet provider was rebuilt', liveSession({}, { name: 'rebuilt' }), 'identity-changed'],
      ['the signer is not ready', liveSession({ isSignerReady: false }), 'no-signer'],
    ])('refuses when %s', (_name, live, reason) => {
      expect(checkBeforeSignature(reviewed, approval, live, false)).toBe(reason);
    });

    it('refuses an unusable session before anything else', () => {
      expect(checkBeforeSignature(reviewed, approval, liveSession(), true)).toBe('session-unusable');
    });

    it('refuses a route whose wrapper check no longer matches', () => {
      const live = liveSession();
      if (live.route.kind !== 'wrapped') throw new Error('the route must be wrapped');
      const failedValidation: WrappedSession = {
        ...live,
        route: { ...live.route, deposit: { isEligible: false, reason: 'not-canonical' } },
      };

      expect(checkBeforeSignature(reviewed, approval, failedValidation, false)).toBe('not-canonical');
    });
  });

  describe('readMarketRestriction', () => {
    const PAUSES = new Interface([
      'function isSupplyPaused() view returns (bool)',
      'function isWithdrawPaused() view returns (bool)',
    ]);

    function comet(paused: Record<string, boolean | Error>) {
      return {
        call: jest.fn(async ({ to, data }: { to: string; data: string }) => {
          if (to !== USDC_COMET) throw new Error('not the Comet');
          const method = PAUSES.getFunction(data.slice(0, 10)).name;
          const value = paused[method];
          if (value instanceof Error) throw value;
          return PAUSES.encodeFunctionResult(method, [value]);
        }),
      };
    }

    it('reads the pause the wrapper call depends on', async () => {
      const supply = wrappedActionIdentity('supply', liveSession());
      const withdraw = wrappedActionIdentity('withdraw', liveSession());
      if (supply === undefined || withdraw === undefined) throw new Error('identities must exist');
      const pausedSupply = comet({ isSupplyPaused: true, isWithdrawPaused: false });
      const pausedWithdrawals = comet({ isSupplyPaused: false, isWithdrawPaused: true });

      await expect(readMarketRestriction(pausedSupply, supply)).resolves.toBe('supply-paused');
      await expect(readMarketRestriction(pausedSupply, withdraw)).resolves.toBeUndefined();
      await expect(readMarketRestriction(pausedWithdrawals, supply)).resolves.toBeUndefined();
      await expect(readMarketRestriction(pausedWithdrawals, withdraw)).resolves.toBe('withdraw-paused');
    });

    it('treats a failed read as a restriction', async () => {
      const supply = wrappedActionIdentity('supply', liveSession());
      if (supply === undefined) throw new Error('the identity must exist');

      await expect(readMarketRestriction(comet({ isSupplyPaused: new Error('RPC down') }), supply)).resolves.toBe(
        'restriction-unknown'
      );
    });
  });
});

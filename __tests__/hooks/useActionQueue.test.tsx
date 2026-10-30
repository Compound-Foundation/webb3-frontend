import { act, renderHook } from '@testing-library/react';

import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { WRAPPED_ACTION, WrappedExecutionError } from '@helpers/wrappedActions';
import { QueueSession, useActionQueue } from '@hooks/useActionQueue';
import { Action, ActionQueue, ActionType, MarketData, PendingAction, RewardsState, StateType } from '@types';

import { mockBaseAsset } from '../mocks/mockBaseAsset';
import { mockCompCollateralAsset } from '../mocks/mockCollateralAssets';

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000bb2';
const SESSION: QueueSession = { account: ACCOUNT, connector: 'connector-uid-1', status: 'connected' };

const MAINNET_USDC = getMarket(1, '0xc3d688B66703497DAA19211EEdff47f25384cdc3') as MarketData;
const MAINNET_ETH = getMarket(1, '0xA17581A9E3356d9A858b789D68B4d866e593aE94') as MarketData;
const BASE_USDC = getMarket(8453, '0xb125E6687d4313864e53df431d5425969c15Eb2F') as MarketData;
// Arbitrum's USDC market and Base's USDbC market share one Comet address.
const SHARED_COMET = '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf';
const ARBITRUM_USDC = getMarket(42161, SHARED_COMET) as MarketData;
const BASE_USDBC = getMarket(8453, SHARED_COMET) as MarketData;

const BASE_ASSET = mockBaseAsset();
const COMP = mockCompCollateralAsset({ walletBalance: 10n ** 20n });
const NO_REWARDS: RewardsState = [StateType.Loading];

const BORROW: Action = [ActionType.Borrow, BASE_ASSET, 1_000_000_000n];
const SUPPLY_COMP: Action = [ActionType.SupplyCollateral, COMP, 10n ** 18n];
const PENDING_REPAY: PendingAction = [ActionType.Repay, BASE_ASSET, 5_000_000n];

type Props = { market: MarketData; session: QueueSession };

function renderQueue(initialProps: Props) {
  return renderHook(
    ({ market, session }: Props) => useActionQueue([StateType.Hydrated, market], () => undefined, session),
    { initialProps }
  );
}

const visibleActions = (queue: ActionQueue) => queue.getActions(BASE_ASSET, [COMP], NO_REWARDS);
const pendingAction = (queue: ActionQueue) => queue.getPendingAction(BASE_ASSET, [COMP]);

/** Defers `actions` until `market` is selected, as the rewards menu does for another chain. */
function defer(queue: ActionQueue, market: MarketData, actions: Action[]) {
  queue.queueActions(market.chainInformation.chainId, market.marketAddress, actions);
}

/** Queues two actions, opens an amount form, and defers an action for `deferredMarket`. */
function fill(queue: ActionQueue, deferredMarket: MarketData) {
  act(() => {
    queue.addOrUpdateAction(BORROW);
    queue.addOrUpdateAction(SUPPLY_COMP);
    queue.setPendingAction(PENDING_REPAY);
    defer(queue, deferredMarket, [SUPPLY_COMP]);
  });
}

type Change = [name: string, from: Props, to: Props];

const CHANGES: Change[] = [
  [
    'account on the same market',
    { market: MAINNET_USDC, session: SESSION },
    { market: MAINNET_USDC, session: { ...SESSION, account: OTHER_ACCOUNT } },
  ],
  [
    'disconnect',
    { market: MAINNET_USDC, session: SESSION },
    { market: MAINNET_USDC, session: { account: undefined, connector: undefined, status: 'disconnected' } },
  ],
  [
    'connector/session',
    { market: MAINNET_USDC, session: SESSION },
    { market: MAINNET_USDC, session: { ...SESSION, connector: 'connector-uid-2' } },
  ],
  [
    'reconnect with the same account and connector',
    { market: MAINNET_USDC, session: SESSION },
    { market: MAINNET_USDC, session: { ...SESSION, status: 'reconnecting' } },
  ],
  [
    'chain, with the same Comet address',
    { market: ARBITRUM_USDC, session: SESSION },
    { market: BASE_USDBC, session: SESSION },
  ],
  ['market', { market: MAINNET_USDC, session: SESSION }, { market: MAINNET_ETH, session: SESSION }],
];

describe('useActionQueue', () => {
  it.each(CHANGES)(
    'clears visible, pending, and deferred actions on account, connector/session, chain, and market change: %s',
    (_name, from, to) => {
      const { result, rerender } = renderQueue(from);
      fill(result.current, BASE_USDC);
      expect(visibleActions(result.current)).toHaveLength(2);
      expect(pendingAction(result.current)).toBeDefined();

      rerender(to);
      expect(visibleActions(result.current)).toEqual([]);
      expect(pendingAction(result.current)).toBeUndefined();

      // The deferred action was dropped with the rest, so selecting its market later adds nothing.
      rerender({ ...to, market: BASE_USDC });
      expect(visibleActions(result.current)).toEqual([]);
    }
  );

  it.each(CHANGES)('never renders the previous queue after a change of %s', (_name, from, to) => {
    const rendered: Action[][] = [];
    const { result, rerender } = renderHook(
      ({ market, session }: Props) => {
        const queue = useActionQueue([StateType.Hydrated, market], () => undefined, session);
        rendered.push(queue.getActions(BASE_ASSET, [COMP], NO_REWARDS));
        return queue;
      },
      { initialProps: from }
    );
    fill(result.current, BASE_USDC);

    rendered.length = 0;
    rerender(to);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.every((actions) => actions.length === 0)).toBe(true);
  });

  it('drops deferred actions after a same-market account change, so a later market switch replays nothing', () => {
    const { result, rerender } = renderQueue({ market: MAINNET_USDC, session: SESSION });
    act(() => defer(result.current, MAINNET_ETH, [SUPPLY_COMP]));

    const otherSession = { ...SESSION, account: OTHER_ACCOUNT };
    rerender({ market: MAINNET_USDC, session: otherSession });
    rerender({ market: MAINNET_ETH, session: otherSession });

    expect(visibleActions(result.current)).toEqual([]);
  });

  it('replays deferred actions when the same session selects their market', () => {
    const { result, rerender } = renderQueue({ market: MAINNET_USDC, session: SESSION });
    fill(result.current, MAINNET_ETH);

    rerender({ market: MAINNET_ETH, session: SESSION });

    expect(visibleActions(result.current)).toEqual([SUPPLY_COMP]);
    expect(pendingAction(result.current)).toBeUndefined();
  });

  it('replays deferred actions only on the chain they were deferred for', () => {
    const { result, rerender } = renderQueue({ market: MAINNET_USDC, session: SESSION });
    act(() => defer(result.current, ARBITRUM_USDC, [SUPPLY_COMP]));

    rerender({ market: BASE_USDBC, session: SESSION });

    expect(visibleActions(result.current)).toEqual([]);
  });

  it('ignores updates from a callback kept from before an account change', () => {
    const { result, rerender } = renderQueue({ market: MAINNET_USDC, session: SESSION });
    const kept = result.current;

    rerender({ market: MAINNET_USDC, session: { ...SESSION, account: OTHER_ACCOUNT } });
    act(() => {
      kept.addOrUpdateAction(BORROW);
      kept.setPendingAction(PENDING_REPAY);
      defer(kept, MAINNET_ETH, [SUPPLY_COMP]);
    });

    expect(visibleActions(result.current)).toEqual([]);
    expect(pendingAction(result.current)).toBeUndefined();
    rerender({ market: MAINNET_ETH, session: { ...SESSION, account: OTHER_ACCOUNT } });
    expect(visibleActions(result.current)).toEqual([]);
  });

  it("does not let an earlier session's transaction callback clear the current queue", () => {
    const { result, rerender } = renderQueue({ market: MAINNET_USDC, session: SESSION });
    // A submitted transaction's callback clears the queue it was submitted from when it settles.
    const { clearActions: clearOnSettle } = result.current;

    const otherSession = { ...SESSION, account: OTHER_ACCOUNT };
    rerender({ market: MAINNET_USDC, session: otherSession });
    act(() => result.current.addOrUpdateAction(BORROW));
    act(() => clearOnSettle());

    expect(visibleActions(result.current)).toEqual([BORROW]);
  });

  it.each<[string, Props]>([
    ['account', { market: MAINNET_USDC, session: { ...SESSION, account: OTHER_ACCOUNT } }],
    ['market', { market: MAINNET_ETH, session: SESSION }],
    ['connection, across a reconnect', { market: MAINNET_USDC, session: { ...SESSION, status: 'reconnecting' } }],
  ])('ignores a callback kept from an earlier visit to the same %s', (_name, elsewhere) => {
    const { result, rerender } = renderQueue({ market: MAINNET_USDC, session: SESSION });
    // A transaction submitted on the first visit clears the queue and closes the form when it settles.
    const { clearActions: clearOnSettle, setPendingAction: closeFormOnSettle } = result.current;

    rerender(elsewhere);
    rerender({ market: MAINNET_USDC, session: SESSION });
    act(() => {
      result.current.addOrUpdateAction(BORROW);
      result.current.setPendingAction(PENDING_REPAY);
    });
    act(() => {
      clearOnSettle();
      closeFormOnSettle(undefined);
    });

    expect(visibleActions(result.current)).toEqual([BORROW]);
    expect(pendingAction(result.current)).toEqual(PENDING_REPAY);
  });

  it('refuses a wrapper action with a typed error and leaves the queue as it was', () => {
    const { result, rerender } = renderQueue({ market: MAINNET_USDC, session: SESSION });
    act(() => result.current.addOrUpdateAction(BORROW));
    const draft = { kind: WRAPPED_ACTION, id: 'draft-1', steps: [] } as unknown as Action;
    const shares = { ...COMP, address: '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73' };
    const wrapperShareSupply: Action = [ActionType.SupplyCollateral, shares, 1n];

    expect(() => result.current.addOrUpdateAction(draft)).toThrow(WrappedExecutionError);
    expect(() => result.current.addOrUpdateAction(wrapperShareSupply)).toThrow(WrappedExecutionError);
    // The direct action deferred with the draft is refused with it, not deferred alone.
    expect(() => defer(result.current, MAINNET_ETH, [SUPPLY_COMP, draft])).toThrow(WrappedExecutionError);
    expect(visibleActions(result.current)).toEqual([BORROW]);

    rerender({ market: MAINNET_ETH, session: SESSION });
    expect(visibleActions(result.current)).toEqual([]);
  });

  it('keeps a queued Max repay as MAX_UINT256 instead of the debt in the latest Comet read', () => {
    const { result } = renderQueue({ market: MAINNET_USDC, session: SESSION });
    const borrower = mockBaseAsset({ balance: -5_000_000n });
    act(() => result.current.addOrUpdateAction([ActionType.Repay, BASE_ASSET, MAX_UINT256]));

    // Comet repays the borrow balance at execution for MAX_UINT256, so the repay leaves no excess.
    expect(result.current.getActions(borrower, [COMP], NO_REWARDS)).toEqual([
      [ActionType.Repay, borrower, MAX_UINT256],
    ]);
  });

  describe('with an unchanged session and market', () => {
    it('adds, updates, removes and clears actions as before', () => {
      const onActionsChanged = jest.fn();
      const { result } = renderHook(() =>
        useActionQueue([StateType.Hydrated, MAINNET_USDC], onActionsChanged, SESSION)
      );

      act(() => {
        result.current.addOrUpdateAction(BORROW);
        result.current.addOrUpdateAction(SUPPLY_COMP);
      });
      expect(visibleActions(result.current)).toEqual([BORROW, SUPPLY_COMP]);
      expect(onActionsChanged).toHaveBeenLastCalledWith([BORROW, SUPPLY_COMP]);

      const largerBorrow: Action = [ActionType.Borrow, BASE_ASSET, 2_000_000_000n];
      act(() => result.current.addOrUpdateAction(largerBorrow));
      expect(visibleActions(result.current)).toEqual([largerBorrow, SUPPLY_COMP]);

      act(() => result.current.removeAction(SUPPLY_COMP));
      expect(visibleActions(result.current)).toEqual([largerBorrow]);

      act(() => result.current.setPendingAction(PENDING_REPAY));
      expect(pendingAction(result.current)).toEqual(PENDING_REPAY);

      act(() => result.current.clearActions());
      expect(visibleActions(result.current)).toEqual([]);
    });

    it('keeps the queue across renders, including a change of account letter case', () => {
      const { result, rerender } = renderQueue({ market: MAINNET_USDC, session: SESSION });
      fill(result.current, MAINNET_ETH);

      rerender({ market: MAINNET_USDC, session: { ...SESSION, account: ACCOUNT.toUpperCase().replace('0X', '0x') } });

      expect(visibleActions(result.current)).toEqual([BORROW, SUPPLY_COMP]);
      expect(pendingAction(result.current)).toEqual(PENDING_REPAY);
    });
  });
});

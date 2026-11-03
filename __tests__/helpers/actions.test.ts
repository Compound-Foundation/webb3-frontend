import {
  ActionRules,
  lendsBaseDirectly,
  validateAddingAction,
  validateAllowanceForAction,
  WrappedBaseRules,
} from '@helpers/actions';
import { MAX_UINT256 } from '@helpers/numbers';
import { Action, ActionType, BaseAssetWithAccountState, TokenWithAccountState } from '@types';

import { mockBaseAction, mockCollateralAction } from '../mocks/mockAction';
import { mockBaseAsset } from '../mocks/mockBaseAsset';
import { mockEthCollateralAsset } from '../mocks/mockCollateralAssets';

const getActions = (): Action[] => [];

describe('validateAddingAction', () => {
  let baseAssetPre: BaseAssetWithAccountState;
  let collateralAssetsPre: TokenWithAccountState[];
  let actions: Action[];
  let baseActionToAdd: Action;
  let collateralActionToAdd: Action;

  describe('Borrow', () => {
    beforeEach(() => {
      baseAssetPre = mockBaseAsset();
      collateralAssetsPre = [mockEthCollateralAsset()];
      actions = getActions();
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Borrow });
    });

    it('ok', () => {
      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result).toBe('ok');
    });

    // Failure cases

    it('Amount Exceeds Borrow Capacity', () => {
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Borrow, amount: 10000000000n });
      collateralAssetsPre = [mockEthCollateralAsset({ balance: 0n })];

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Amount Exceeds Borrow Capacity');
    });

    it('Minimum Borrow. isMax = false', () => {
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Borrow, amount: 100n });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Minimum Borrow of 1,000.0000 USDC');
    });

    it('Minimum Borrow. isMax = true', () => {
      // 0.1 ETH collateral is worth ~$191 which is below minimum
      collateralAssetsPre = [mockEthCollateralAsset({ balance: 100000000000000000n })];
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Borrow, amount: MAX_UINT256 });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Minimum Borrow of 1,000.0000 USDC');
    });

    it('Not Enough Market Liquidity. isMax = false', () => {
      baseAssetPre = mockBaseAsset({ balanceOfComet: 0n });
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Borrow, amount: 10000000000n });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Not Enough Market Liquidity');
    });

    it('Not Enough Market Liquidity. isMax = true', () => {
      baseAssetPre = mockBaseAsset({ balanceOfComet: 0n });
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Borrow, amount: MAX_UINT256 });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Not Enough Market Liquidity');
    });

    it('Has existing supply', () => {
      baseAssetPre = mockBaseAsset({ balance: 10000000000n });
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Borrow, amount: 10000000000n });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Must Withdraw Full USDC Balance');
    });
  });

  describe('Supply', () => {
    beforeEach(() => {
      baseAssetPre = mockBaseAsset();
      collateralAssetsPre = [mockEthCollateralAsset()];
      actions = getActions();
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Supply });
    });

    it('ok', () => {
      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result).toBe('ok');
    });

    // Failure cases
    it('Amount Exceeds Wallet Balance', () => {
      baseAssetPre = mockBaseAsset({ walletBalance: 0n });
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Supply, amount: 10000000000n });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Amount Exceeds Wallet Balance');
    });

    it('Must Repay Borrow First', () => {
      baseAssetPre = mockBaseAsset({ balance: -10000000000n }); // $10,000 USDC
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Supply, amount: 10000000000n });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Must Repay Borrow First');
    });
  });

  describe('Repay', () => {
    beforeEach(() => {
      baseAssetPre = mockBaseAsset();
      collateralAssetsPre = [mockEthCollateralAsset()];
      actions = getActions();
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Repay });
    });

    it('ok', () => {
      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result).toBe('ok');
    });

    // Failure cases
    it('Amount Exceeds Wallet Balance. isMax = false', () => {
      baseAssetPre = mockBaseAsset({ walletBalance: 0n });
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Repay, amount: 10000000000n });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Amount Exceeds Wallet Balance');
    });

    it('Amount Exceeds Wallet Balance. isMax = true', () => {
      baseAssetPre = mockBaseAsset({ walletBalance: 0n, balance: -10000000000n });
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Repay, amount: MAX_UINT256 });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Amount Exceeds Wallet Balance');
    });
  });

  describe('Withdraw', () => {
    beforeEach(() => {
      baseAssetPre = mockBaseAsset({ balance: 10000000000n });
      collateralAssetsPre = [mockEthCollateralAsset()];
      actions = getActions();
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Withdraw });
    });

    it('ok', () => {
      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result).toBe('ok');
    });

    // Failure cases
    it('Amount Exceeds Balance', () => {
      baseAssetPre = mockBaseAsset({ balance: 0n });
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Withdraw, amount: 10000000000n });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Amount Exceeds Balance');
    });

    it('Must Repay Borrow First', () => {
      baseAssetPre = mockBaseAsset({ balance: -10000000000n });
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Withdraw, amount: 10000000000n });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Must Repay Borrow First');
    });

    it('Not Enough Market Liquidity. isMax = false', () => {
      baseAssetPre = mockBaseAsset({ balanceOfComet: 0n, balance: 10000000000n });
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Withdraw, amount: 10000000000n });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Not Enough Market Liquidity');
    });

    it('Not Enough Market Liquidity. isMax = true', () => {
      baseAssetPre = mockBaseAsset({ balanceOfComet: 0n, balance: 10000000000n });
      baseActionToAdd = mockBaseAction({ actionType: ActionType.Withdraw, amount: MAX_UINT256 });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, baseActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Not Enough Market Liquidity');
    });
  });

  describe('SupplyCollateral', () => {
    beforeEach(() => {
      baseAssetPre = mockBaseAsset();
      collateralAssetsPre = [mockEthCollateralAsset()];
      actions = getActions();
      collateralActionToAdd = mockCollateralAction({ actionType: ActionType.SupplyCollateral });
    });

    it('ok', () => {
      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, collateralActionToAdd);
      expect(result).toBe('ok');
    });

    // Failure cases
    it("Collateral Asset Doesn't Exist", () => {
      collateralActionToAdd = mockCollateralAction({
        actionType: ActionType.SupplyCollateral,
        tokenWithAccountState: { symbol: 'fakeETH' },
      });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, collateralActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe("Collateral Asset Doesn't Exist");
    });

    it('Amount Exceeds Wallet Balance', () => {
      collateralAssetsPre = [mockEthCollateralAsset({ walletBalance: 0n })];
      collateralActionToAdd = mockCollateralAction({
        actionType: ActionType.SupplyCollateral,
        amount: 10000000000n,
      });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, collateralActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Amount Exceeds Wallet Balance');
    });

    it('Amount Exceeds Supply Cap', () => {
      collateralAssetsPre = [mockEthCollateralAsset({ supplyCap: 0n })];
      collateralActionToAdd = mockCollateralAction({
        actionType: ActionType.SupplyCollateral,
        amount: 10000000000n,
      });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, collateralActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Amount Exceeds Supply Cap');
    });
  });

  describe('WithdrawCollateral', () => {
    beforeEach(() => {
      baseAssetPre = mockBaseAsset();
      collateralAssetsPre = [mockEthCollateralAsset()];
      actions = getActions();
      collateralActionToAdd = mockCollateralAction({ actionType: ActionType.WithdrawCollateral });
    });

    it('ok', () => {
      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, collateralActionToAdd);
      expect(result).toBe('ok');
    });

    // Failure cases
    it("Collateral Asset Doesn't Exist", () => {
      collateralActionToAdd = mockCollateralAction({
        actionType: ActionType.SupplyCollateral,
        tokenWithAccountState: { symbol: 'fakeETH' },
      });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, collateralActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe("Collateral Asset Doesn't Exist");
    });

    it('Amount Exceeds Balance', () => {
      collateralAssetsPre = [mockEthCollateralAsset({ balance: 0n })];
      collateralActionToAdd = mockCollateralAction({
        actionType: ActionType.WithdrawCollateral,
        amount: 10000000000n,
      });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, collateralActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Amount Exceeds Balance');
    });

    it('Borrow Balance Will Exceed Capacity', () => {
      baseAssetPre = mockBaseAsset({ balance: -10000000000n }); // $10,000 USDC
      collateralActionToAdd = mockCollateralAction({
        actionType: ActionType.WithdrawCollateral,
        amount: 10000000000000000000n,
      });

      const result = validateAddingAction(baseAssetPre, collateralAssetsPre, actions, collateralActionToAdd);
      expect(result[0]).toBe(false);
      expect(result[1]).toBe('Borrow Balance Will Exceed Capacity');
    });
  });
});

describe('validateAddingAction with base lending through the wrapper', () => {
  const OPEN_BASE: WrappedBaseRules = {
    supplyBlockedReason: undefined,
    withdrawBlockedReason: undefined,
    maxPartialWithdrawal: 2_000_000_000n,
    canWithdrawAll: true,
  };
  const OPEN: ActionRules = { wrappedBase: OPEN_BASE };
  const collateralAssetsPre = () => [mockEthCollateralAsset()];
  // An account with no allowance to Comet. A wrapped supply spends its allowance to the wrapper.
  const noAllowance = (overrides: Partial<BaseAssetWithAccountState> = {}) =>
    mockBaseAsset({ allowance: 0n, walletBalance: 5_000_000_000n, ...overrides });
  const supply = (amount: bigint) => mockBaseAction({ actionType: ActionType.Supply, amount });
  const withdraw = (amount: bigint) => mockBaseAction({ actionType: ActionType.Withdraw, amount });

  it("checks a base supply against the allowance to the wrapper, not Comet's", () => {
    const action = supply(1_000_000_000n);
    const withWrapperAllowance = (supplyAllowance: bigint | undefined): ActionRules => ({
      wrappedBase: { ...OPEN_BASE, supplyAllowance },
    });

    expect(validateAddingAction(noAllowance(), collateralAssetsPre(), [], action, OPEN)).toBe('ok');
    expect(
      validateAllowanceForAction(noAllowance(), collateralAssetsPre(), [], action, withWrapperAllowance(1_000_000_000n))
    ).toBe('ok');
    // An allowance to the wrapper below the amount, or not read yet, fails as an allowance to Comet does.
    for (const supplyAllowance of [999_999_999n, undefined]) {
      expect(
        validateAllowanceForAction(
          noAllowance(),
          collateralAssetsPre(),
          [],
          action,
          withWrapperAllowance(supplyAllowance)
        )
      ).toEqual([false, 'Approval Failed']);
    }
    // A full allowance to Comet does not cover a wrapped supply.
    expect(
      validateAllowanceForAction(noAllowance({ allowance: MAX_UINT256 }), collateralAssetsPre(), [], action, OPEN)
    ).toEqual([false, 'Approval Failed']);
    // Max supplies the wallet balance, so the allowance must cover that.
    const max = supply(MAX_UINT256);
    expect(
      validateAllowanceForAction(noAllowance(), collateralAssetsPre(), [], max, withWrapperAllowance(5_000_000_000n))
    ).toBe('ok');
    expect(
      validateAllowanceForAction(noAllowance(), collateralAssetsPre(), [], max, withWrapperAllowance(4_999_999_999n))
    ).toEqual([false, 'Approval Failed']);
    // On the standard route the same supply still needs its approval first.
    expect(validateAllowanceForAction(noAllowance(), collateralAssetsPre(), [], action)).toEqual([
      false,
      'Approval Failed',
    ]);
  });

  it('keeps the wallet balance check of a base supply', () => {
    expect(validateAddingAction(noAllowance(), collateralAssetsPre(), [], supply(5_000_000_001n), OPEN)).toEqual([
      false,
      'Amount Exceeds Wallet Balance',
    ]);
  });

  it("shows the route's blocked reason instead of queueing, while the release controls are closed", () => {
    const closed: ActionRules = {
      wrappedBase: {
        supplyBlockedReason: 'Supply Not Open Yet',
        withdrawBlockedReason: 'Withdrawals Not Open Yet',
        maxPartialWithdrawal: 2_000_000_000n,
        canWithdrawAll: true,
      },
    };
    const withBalance = noAllowance({ balance: 2_500_000_000n });

    expect(validateAddingAction(withBalance, collateralAssetsPre(), [], supply(1n), closed)).toEqual([
      false,
      'Supply Not Open Yet',
    ]);
    expect(validateAddingAction(withBalance, collateralAssetsPre(), [], withdraw(1n), closed)).toEqual([
      false,
      'Withdrawals Not Open Yet',
    ]);
  });

  it('limits a partial withdrawal to what the wrapper pays now, and allows a full exit', () => {
    const withBalance = noAllowance({ balance: 2_500_000_000n });

    expect(validateAddingAction(withBalance, collateralAssetsPre(), [], withdraw(2_000_000_000n), OPEN)).toBe('ok');
    expect(validateAddingAction(withBalance, collateralAssetsPre(), [], withdraw(2_000_000_001n), OPEN)).toEqual([
      false,
      'Amount Exceeds Withdrawable Balance',
    ]);
    expect(validateAddingAction(withBalance, collateralAssetsPre(), [], withdraw(MAX_UINT256), OPEN)).toBe('ok');
  });

  it('refuses a full exit the wrapper cannot pay now, and any withdrawal before the position is read', () => {
    const withBalance = noAllowance({ balance: 2_500_000_000n });
    const cannotExit: ActionRules = {
      wrappedBase: { ...OPEN_BASE, maxPartialWithdrawal: 0n, canWithdrawAll: false },
    };
    const unread: ActionRules = {
      wrappedBase: { ...OPEN_BASE, maxPartialWithdrawal: undefined, canWithdrawAll: false },
    };

    expect(validateAddingAction(withBalance, collateralAssetsPre(), [], withdraw(MAX_UINT256), cannotExit)).toEqual([
      false,
      'Withdrawal Unavailable Now',
    ]);
    expect(validateAddingAction(withBalance, collateralAssetsPre(), [], withdraw(1n), unread)).toEqual([
      false,
      'Balance Not Loaded Yet',
    ]);
  });

  it('allows a full exit the wrapper can pay, though the gross position exceeds the market cash', () => {
    // A gross position of 2,500.125000 less the wrapper's buffer of 0.000003 pays 2,500.124997,
    // which is exactly the market's cash. The wrapper pays the exit; Comet never pays the gross.
    const position = noAllowance({ balance: 2_500_125_000n, balanceOfComet: 2_500_124_997n });
    const payable: ActionRules = {
      wrappedBase: { ...OPEN_BASE, maxPartialWithdrawal: 2_500_124_997n, canWithdrawAll: true },
    };

    expect(validateAddingAction(position, collateralAssetsPre(), [], withdraw(MAX_UINT256), payable)).toBe('ok');
    expect(validateAddingAction(position, collateralAssetsPre(), [], withdraw(2_500_124_997n), payable)).toBe('ok');
    // A direct withdrawal of the same position still needs the gross amount in the market.
    expect(validateAddingAction(position, collateralAssetsPre(), [], withdraw(MAX_UINT256))).toEqual([
      false,
      'Not Enough Market Liquidity',
    ]);
  });

  it('still refuses a wrapped withdrawal while the account borrows directly', () => {
    const borrower = noAllowance({ balance: -1_000_000_000n });

    expect(validateAddingAction(borrower, collateralAssetsPre(), [], withdraw(MAX_UINT256), OPEN)).toEqual([
      false,
      'Must Repay Borrow First',
    ]);
  });

  it('refuses a supply and a withdrawal in one queue', () => {
    const withBalance = noAllowance({ balance: 2_500_000_000n });

    expect(
      validateAddingAction(withBalance, collateralAssetsPre(), [withdraw(1_000_000n)], supply(1_000_000n), OPEN)
    ).toEqual([false, 'Submit Supply And Withdrawal Separately']);
    expect(
      validateAddingAction(withBalance, collateralAssetsPre(), [supply(1_000_000n)], withdraw(1_000_000n), OPEN)
    ).toEqual([false, 'Submit Supply And Withdrawal Separately']);
  });

  it('refuses a wrapped supply while the account borrows directly, even after a queued repay', () => {
    // The wrapper's steps go before the direct actions, so a supply could spend what the repay needs.
    const borrower = noAllowance({ balance: -1_000_000_000n });
    const repayAll = mockBaseAction({ actionType: ActionType.Repay, amount: MAX_UINT256 });

    expect(validateAddingAction(borrower, collateralAssetsPre(), [], supply(1_000_000n), OPEN)).toEqual([
      false,
      'Must Repay Borrow First',
    ]);
    expect(validateAddingAction(borrower, collateralAssetsPre(), [repayAll], supply(1_000_000n), OPEN)).toEqual([
      false,
      'Must Repay Borrow First',
    ]);
  });

  it('rejects a repay above the debt, whose excess would become a direct supply', () => {
    const result = validateAddingAction(
      mockBaseAsset({ balance: -10000000000n }),
      collateralAssetsPre(),
      [],
      mockBaseAction({ actionType: ActionType.Repay, amount: 10000000001n }),
      OPEN
    );
    expect(result).toEqual([false, 'Amount Exceeds Borrow Balance']);
  });

  it('measures the debt after the actions already queued', () => {
    const queuedRepay = mockBaseAction({ actionType: ActionType.Repay, amount: 4000000000n });
    const result = validateAddingAction(
      mockBaseAsset({ balance: -10000000000n }),
      collateralAssetsPre(),
      [queuedRepay],
      mockBaseAction({ actionType: ActionType.Repay, amount: 6000000001n }),
      OPEN
    );
    expect(result).toEqual([false, 'Amount Exceeds Borrow Balance']);
  });

  it('allows repaying exactly the debt, or all of it', () => {
    const baseAssetPre = mockBaseAsset({ balance: -10000000000n });
    const exact = mockBaseAction({ actionType: ActionType.Repay, amount: 10000000000n });
    const full = mockBaseAction({ actionType: ActionType.Repay, amount: MAX_UINT256 });

    expect(validateAddingAction(baseAssetPre, collateralAssetsPre(), [], exact, OPEN)).toBe('ok');
    expect(validateAddingAction(baseAssetPre, collateralAssetsPre(), [], full, OPEN)).toBe('ok');
  });

  it('leaves borrowing and collateral actions unchanged', () => {
    const borrow = mockBaseAction({ actionType: ActionType.Borrow });
    const supplyCollateral = mockCollateralAction({ actionType: ActionType.SupplyCollateral });

    expect(validateAddingAction(mockBaseAsset(), collateralAssetsPre(), [], borrow, OPEN)).toBe('ok');
    expect(validateAddingAction(mockBaseAsset(), collateralAssetsPre(), [], supplyCollateral, OPEN)).toBe('ok');
  });

  it('changes nothing on the standard route', () => {
    const overRepay = mockBaseAction({ actionType: ActionType.Repay, amount: 10000000001n });

    expect(validateAddingAction(mockBaseAsset(), collateralAssetsPre(), [], supply(1n))).toBe('ok');
    expect(validateAddingAction(mockBaseAsset({ balance: -10000000000n }), collateralAssetsPre(), [], overRepay)).toBe(
      'ok'
    );
  });
});

describe('validateAddingAction on a single-action queue', () => {
  const SINGLE: ActionRules = {
    isSingleAction: true,
    wrappedBase: {
      supplyBlockedReason: undefined,
      withdrawBlockedReason: undefined,
      maxPartialWithdrawal: 2_000_000_000n,
      canWithdrawAll: true,
      supplyAllowance: MAX_UINT256,
    },
  };
  const baseAssetPre = () => mockBaseAsset({ balance: 1_000_000_000n, walletBalance: 5_000_000_000n });
  const collateralAssetsPre = () => [mockEthCollateralAsset({ walletBalance: 10n ** 18n })];
  const QUEUED_FIRST = 'Submit Or Remove The Queued Action First';
  const actionsOfEachKind = (): [string, Action][] => [
    ['supply', mockBaseAction({ actionType: ActionType.Supply, amount: 1_000_000n })],
    ['withdrawal', mockBaseAction({ actionType: ActionType.Withdraw, amount: 1_000_000n })],
    ['borrow', mockBaseAction({ actionType: ActionType.Borrow, amount: 1_000_000_000n })],
    ['collateral supply', mockCollateralAction({ actionType: ActionType.SupplyCollateral, amount: 10n ** 16n })],
    ['collateral withdrawal', mockCollateralAction({ actionType: ActionType.WithdrawCollateral, amount: 10n ** 16n })],
  ];
  const distinctPairs = actionsOfEachKind().flatMap(([queuedName, queued]) =>
    actionsOfEachKind()
      .filter(([addedName]) => addedName !== queuedName)
      .map(([addedName, added]): [string, string, Action, Action] => [queuedName, addedName, queued, added])
  );

  it.each(distinctPairs)('refuses, after a queued %s, a %s', (_queuedName, _addedName, queued, added) => {
    expect(validateAddingAction(baseAssetPre(), collateralAssetsPre(), [queued], added, SINGLE)).toEqual([
      false,
      QUEUED_FIRST,
    ]);
  });

  it('refuses a repay after a queued collateral supply, and the reverse', () => {
    const borrower = mockBaseAsset({ balance: -1_000_000_000n, walletBalance: 5_000_000_000n });
    const repay = mockBaseAction({ actionType: ActionType.Repay, amount: 1_000_000n });
    const supplyCollateral = mockCollateralAction({ actionType: ActionType.SupplyCollateral, amount: 10n ** 16n });

    expect(validateAddingAction(borrower, collateralAssetsPre(), [supplyCollateral], repay, SINGLE)).toEqual([
      false,
      QUEUED_FIRST,
    ]);
    expect(validateAddingAction(borrower, collateralAssetsPre(), [repay], supplyCollateral, SINGLE)).toEqual([
      false,
      QUEUED_FIRST,
    ]);
  });

  // A withdrawal and a borrow have amount rules of their own, which other tests cover.
  const withoutAmountRules = actionsOfEachKind().filter(([name]) => name !== 'withdrawal' && name !== 'borrow');

  it.each(withoutAmountRules)('accepts a %s into an empty queue', (_name, action) => {
    expect(validateAddingAction(baseAssetPre(), collateralAssetsPre(), [], action, SINGLE)).toBe('ok');
  });

  it('allows several actions when the queue is not limited to one', () => {
    const batching: ActionRules = { ...SINGLE, isSingleAction: false };
    const supply = mockBaseAction({ actionType: ActionType.Supply, amount: 1_000_000n });
    const supplyCollateral = mockCollateralAction({ actionType: ActionType.SupplyCollateral, amount: 10n ** 16n });

    expect(validateAddingAction(baseAssetPre(), collateralAssetsPre(), [supplyCollateral], supply, batching)).toBe(
      'ok'
    );
    expect(validateAddingAction(baseAssetPre(), collateralAssetsPre(), [supplyCollateral], supply)).toBe('ok');
  });
});

describe('lendsBaseDirectly', () => {
  const collateralAssetsPre = () => [mockEthCollateralAsset()];

  it('finds a base supply or a base withdrawal anywhere in the queue', () => {
    const supplyQueue = [
      mockCollateralAction({ actionType: ActionType.SupplyCollateral }),
      mockBaseAction({ actionType: ActionType.Supply }),
    ];
    const withdrawQueue = [
      mockCollateralAction({ actionType: ActionType.SupplyCollateral }),
      mockBaseAction({ actionType: ActionType.Withdraw, amount: MAX_UINT256 }),
    ];
    expect(lendsBaseDirectly(mockBaseAsset(), collateralAssetsPre(), supplyQueue)).toBe(true);
    expect(lendsBaseDirectly(mockBaseAsset(), collateralAssetsPre(), withdrawQueue)).toBe(true);
  });

  it('finds a repay larger than the debt left by the actions before it', () => {
    const actions = [
      mockBaseAction({ actionType: ActionType.Repay, amount: 4000000000n }),
      mockBaseAction({ actionType: ActionType.Repay, amount: 6000000001n }),
    ];
    expect(lendsBaseDirectly(mockBaseAsset({ balance: -10000000000n }), collateralAssetsPre(), actions)).toBe(true);
  });

  it('finds a base supply even when it is invalid for another reason', () => {
    const actions = [mockBaseAction({ actionType: ActionType.Supply, amount: 10n ** 30n })];
    expect(lendsBaseDirectly(mockBaseAsset(), collateralAssetsPre(), actions)).toBe(true);
  });

  it('accepts a queue of borrowing, repaying in full and collateral actions', () => {
    const actions = [
      mockCollateralAction({ actionType: ActionType.SupplyCollateral }),
      mockBaseAction({ actionType: ActionType.Repay, amount: MAX_UINT256 }),
    ];
    expect(lendsBaseDirectly(mockBaseAsset({ balance: -10000000000n }), collateralAssetsPre(), actions)).toBe(false);
  });
});

describe('validateAddingAction with a wrapper action', () => {
  const USDC_WRAPPER = '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73';

  it.each([ActionType.Supply, ActionType.SupplyCollateral, ActionType.WithdrawCollateral])(
    'refuses a %s naming wrapper shares, whatever the rules',
    (actionType) => {
      const shares = { ...mockEthCollateralAsset(), address: USDC_WRAPPER, symbol: 'wcUSDCv3' };
      const action = [actionType, shares, 1n] as Action;

      expect(validateAddingAction(mockBaseAsset(), [mockEthCollateralAsset()], [], action)).toEqual([
        false,
        'Wrapped Actions Are Submitted Separately',
      ]);
    }
  );
});

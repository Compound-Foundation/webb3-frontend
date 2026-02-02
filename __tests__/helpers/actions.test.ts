import { validateAddingAction } from '@helpers/actions';
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

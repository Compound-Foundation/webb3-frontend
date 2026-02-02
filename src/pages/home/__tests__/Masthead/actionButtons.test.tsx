import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { Theme } from '@hooks/useThemeManager';
import { Action, ActionType, BaseAssetWithAccountState, PendingAction, StateType } from '@types';

import { MockBaseAssetWithAccountState, MockBaseAssetWithState } from '../../../../../__tests__/mocks/mockTokens';
import Masthead, { MastheadState } from '../../components/Masthead';

type HydratedMastheadState = {
  baseAssetToUse: BaseAssetWithAccountState;
  baseAssetPost?: BaseAssetWithAccountState;
  pendingAction?: PendingAction;
  actions?: Action[];
};

const hydratedMasthead = ({ baseAssetToUse, baseAssetPost, pendingAction, actions }: HydratedMastheadState) => {
  return (
    <div>
      <div id="overlay"></div>
      <Masthead
        state={[
          StateType.Hydrated,
          {
            actions: actions ? actions : [],
            baseAsset: baseAssetToUse,
            baseAssetPost: baseAssetPost ? baseAssetPost : baseAssetToUse,
            borrowAPR: 0n,
            borrowRewardsAPR: 0n,
            collateralAssets: [],
            collateralValue: 0n,
            collateralValuePost: 0n,
            compare: false,
            earnAPR: 0n,
            earnRewardsAPR: 0n,
            liquidationCapacity: 0n,
            liquidationCapacityPost: 0n,
            onSupplyAction: () => undefined,
            onWithdrawAction: () => undefined,
            setCompare: () => undefined,
            pendingAction: pendingAction,
            theme: Theme.Dark,
          },
        ]}
      />
    </div>
  );
};

// These tests verify the behavior of the Masthead buttons for
// supplying and borrowing base asset of a market.
// All states are enumerated in the Figma here:
// https://www.figma.com/file/L8pLVK8WgaB45Aag22HX4q/%5BARCHIVED%5D-V3-Interface-(fka-Bulker)?node-id=1475-59446&t=GOPyCADtLlAqx6Oj-0

describe('Loading State', () => {
  it('both buttons are disabled', () => {
    const mastheadState: MastheadState = [StateType.Loading];

    render(<Masthead state={mastheadState} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(2);
    buttons.forEach((x) => expect(x).toBeDisabled());
  });
});

describe('No Wallet State', () => {
  it('both buttons are disabled', () => {
    const mastheadState: MastheadState = [StateType.NoWallet, { baseAsset: MockBaseAssetWithState, earnAPR: 0n }];

    render(<Masthead state={mastheadState} />);

    const supplyButton = screen.getByRole('button', { name: 'Supply USDC' });
    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    expect(supplyButton).toBeDisabled();
    expect(borrowButton).toBeDisabled();
    expect(screen.getAllByRole('button').length).toBe(2);
  });
});

describe('Zero Supply Balance', () => {
  it('supply and borrow both enabled', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 0n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase }));

    const supplyButton = screen.getByRole('button', { name: 'Supply USDC' });
    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    expect(supplyButton).toBeEnabled();
    expect(borrowButton).toBeEnabled();
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('no borrow capacity', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 0n,
      borrowCapacity: 0n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase }));

    const supplyButton = screen.getByRole('button', { name: 'Supply USDC' });
    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    expect(supplyButton).toBeEnabled();
    expect(borrowButton).toBeDisabled();
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('no wallet balance', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 0n,
      walletBalance: 0n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase }));

    const supplyButton = screen.getByRole('button', { name: 'Supply USDC' });
    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    expect(supplyButton).toBeDisabled();
    expect(borrowButton).toBeEnabled();
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('supply pending action', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 0n,
      walletBalance: 1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, pendingAction: [ActionType.Supply, mockBase, undefined] }));

    const supplyButton = screen.getByRole('button', { name: 'Supply USDC' });
    const borrowButton = screen.queryByRole('button', { name: 'Borrow USDC' });
    expect(supplyButton).toBeEnabled();
    expect(borrowButton).toBeNull();
    expect(screen.getAllByRole('button').length).toBe(1);
  });

  it('supply action in action queue', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 0n,
      walletBalance: 1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, actions: [[ActionType.Supply, mockBase, 5000000n]] }));

    const supplyButton = screen.getByRole('button', { name: 'Supply 5.0000 USDC' });
    const borrowButton = screen.queryByRole('button', { name: 'Borrow USDC' });
    expect(supplyButton).toBeEnabled();
    expect(borrowButton).toBeNull();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('borrow pending action', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 0n,
      walletBalance: 1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, pendingAction: [ActionType.Borrow, mockBase, undefined] }));

    const supplyButton = screen.queryByRole('button', { name: 'Supply USDC' });
    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    expect(supplyButton).toBeNull();
    expect(borrowButton).toBeEnabled();
    expect(screen.getAllByRole('button').length).toBe(1);
  });

  it('borrow action in action queue', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 0n,
      walletBalance: 1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, actions: [[ActionType.Borrow, mockBase, 5000000n]] }));

    const supplyButton = screen.queryByRole('button', { name: 'Supply USDC' });
    const borrowButton = screen.getByRole('button', { name: 'Borrow 5.0000 USDC' });
    expect(supplyButton).toBeNull();
    expect(borrowButton).toBeEnabled();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(2);
  });
});

describe('Has Earn Balance', () => {
  it('supply and withdraw buttons enabled', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase }));

    const supplyButton = screen.getByRole('button', { name: 'Supply USDC' });
    const borrowButton = screen.getByRole('button', { name: 'Withdraw USDC' });
    expect(supplyButton).toBeEnabled();
    expect(borrowButton).toBeEnabled();
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('no wallet balance', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 1000000n,
      walletBalance: 0n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase }));

    const supplyButton = screen.getByRole('button', { name: 'Supply USDC' });
    const withdrawButton = screen.getByRole('button', { name: 'Withdraw USDC' });
    expect(supplyButton).toBeDisabled();
    expect(withdrawButton).toBeEnabled();
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('supply pending action', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 1000000n,
      walletBalance: 1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, pendingAction: [ActionType.Supply, mockBase, undefined] }));

    const supplyButton = screen.getByRole('button', { name: 'Supply USDC' });
    const withdrawButton = screen.queryByRole('button', { name: 'Withdraw USDC' });
    expect(supplyButton).toBeEnabled();
    expect(withdrawButton).toBeNull();
    expect(screen.getAllByRole('button').length).toBe(1);
  });

  it('supply action in action queue', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 1000000n,
      walletBalance: 1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, actions: [[ActionType.Supply, mockBase, 10000000n]] }));

    const supplyButton = screen.getByRole('button', { name: 'Supply 10.0000 USDC' });
    const withdrawButton = screen.queryByRole('button', { name: 'Withdraw USDC' });
    expect(supplyButton).toBeEnabled();
    expect(withdrawButton).toBeNull();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('withdraw pending action', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 1000000n,
      walletBalance: 1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, pendingAction: [ActionType.Withdraw, mockBase, undefined] }));

    const supplyButton = screen.queryByRole('button', { name: 'Supply USDC' });
    const withdrawButton = screen.getByRole('button', { name: 'Withdraw USDC' });
    expect(supplyButton).toBeNull();
    expect(withdrawButton).toBeEnabled();
    expect(screen.getAllByRole('button').length).toBe(1);
  });

  it('withdraw action in action queue', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 1000000n,
      walletBalance: 1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, actions: [[ActionType.Withdraw, mockBase, 2500000n]] }));

    const supplyButton = screen.queryByRole('button', { name: 'Supply USDC' });
    const withdrawButton = screen.getByRole('button', { name: 'Withdraw 2.5000 USDC' });
    expect(supplyButton).toBeNull();
    expect(withdrawButton).toBeEnabled();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('max withdraw in action queue', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 1000000n,
      walletBalance: 1000000n,
    };

    const mockBasePost = {
      ...mockBase,
      balance: 0n,
    };

    render(
      hydratedMasthead({
        baseAssetToUse: mockBase,
        baseAssetPost: mockBasePost,
        actions: [[ActionType.Withdraw, mockBasePost, 1000000n]],
      })
    );

    const withdrawButton = screen.getByRole('button', { name: 'Withdraw 1.0000 USDC' });
    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    expect(withdrawButton).toBeEnabled();
    expect(borrowButton).toBeEnabled();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(3);
  });

  it('max withdraw in action queue but no borrow capacity', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 1000000n,
      borrowCapacity: 0n,
      walletBalance: 1000000n,
    };

    const mockBasePost = {
      ...mockBase,
      balance: 0n,
    };

    render(
      hydratedMasthead({
        baseAssetToUse: mockBase,
        baseAssetPost: mockBasePost,
        actions: [[ActionType.Withdraw, mockBasePost, 1000000n]],
      })
    );

    const withdrawButton = screen.getByRole('button', { name: 'Withdraw 1.0000 USDC' });
    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    expect(withdrawButton).toBeEnabled();
    expect(borrowButton).toBeDisabled();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(3);
  });

  it('max withdraw in action queue and pending borrow action', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 1000000n,
      walletBalance: 1000000n,
    };

    const mockBasePost = {
      ...mockBase,
      balance: 0n,
    };

    render(
      hydratedMasthead({
        baseAssetToUse: mockBase,
        baseAssetPost: mockBasePost,
        actions: [[ActionType.Withdraw, mockBasePost, 1000000n]],
        pendingAction: [ActionType.Borrow, mockBase, undefined],
      })
    );

    const withdrawButton = screen.getByRole('button', { name: 'Withdraw 1.0000 USDC' });
    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    expect(withdrawButton).toBeDisabled();
    expect(borrowButton).toBeEnabled();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(3);
  });

  it('max withdraw followed by borrow in action queue', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 1000000n,
      walletBalance: 1000000n,
    };

    const mockBasePost = {
      ...mockBase,
      balance: -5000000n,
    };

    render(
      hydratedMasthead({
        baseAssetToUse: mockBase,
        baseAssetPost: mockBasePost,
        actions: [
          [ActionType.Withdraw, { ...mockBase, balance: 0n }, 1000000n],
          [ActionType.Borrow, mockBasePost, 5000000n],
        ],
      })
    );

    const withdrawButton = screen.getByRole('button', { name: 'Withdraw 1.0000 USDC' });
    const borrowButton = screen.getByRole('button', { name: 'Borrow 5.0000 USDC' });
    expect(withdrawButton).toBeEnabled();
    expect(borrowButton).toBeEnabled();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(3);
  });
});

describe('Has Borrow Balance', () => {
  it('borrow and repay buttons enabled', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: -1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase }));

    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    const repayButton = screen.getByRole('button', { name: 'Repay USDC' });
    expect(borrowButton).toBeEnabled();
    expect(repayButton).toBeEnabled();
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('no wallet balance', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: -1000000n,
      walletBalance: 0n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase }));

    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    const repayButton = screen.getByRole('button', { name: 'Repay USDC' });
    expect(borrowButton).toBeEnabled();
    expect(repayButton).toBeDisabled();
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('no borrow capacity', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: -1000000n,
      borrowCapacity: 0n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase }));

    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    const repayButton = screen.getByRole('button', { name: 'Repay USDC' });
    expect(borrowButton).toBeDisabled();
    expect(repayButton).toBeEnabled();
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('no wallet balance and no borrow capacity', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: -1000000n,
      borrowCapacity: 0n,
      walletBalance: 0n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase }));

    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    const repayButton = screen.getByRole('button', { name: 'Repay USDC' });
    expect(borrowButton).toBeDisabled();
    expect(repayButton).toBeDisabled();
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('borrow pending action', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: -1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, pendingAction: [ActionType.Borrow, mockBase, undefined] }));

    const borrowButton = screen.getByRole('button', { name: 'Borrow USDC' });
    const repayButton = screen.queryByRole('button', { name: 'Repay USDC' });
    expect(borrowButton).toBeEnabled();
    expect(repayButton).toBeNull();
    expect(screen.getAllByRole('button').length).toBe(1);
  });

  it('borrow action in action queue', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: 1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, actions: [[ActionType.Borrow, mockBase, 10000000n]] }));

    const borrowButton = screen.getByRole('button', { name: 'Borrow 10.0000 USDC' });
    const repayButton = screen.queryByRole('button', { name: 'Repay USDC' });
    expect(borrowButton).toBeEnabled();
    expect(repayButton).toBeNull();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('repay pending action', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: -1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, pendingAction: [ActionType.Repay, mockBase, undefined] }));

    const borrowButton = screen.queryByRole('button', { name: 'Borrow USDC' });
    const repayButton = screen.getByRole('button', { name: 'Repay USDC' });
    expect(borrowButton).toBeNull();
    expect(repayButton).toBeEnabled();
    expect(screen.getAllByRole('button').length).toBe(1);
  });

  it('repay action in action queue', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: -1000000n,
    };

    render(hydratedMasthead({ baseAssetToUse: mockBase, actions: [[ActionType.Repay, mockBase, 500000n]] }));

    const borrowButton = screen.queryByRole('button', { name: 'Borrow USDC' });
    const repayButton = screen.getByRole('button', { name: 'Repay 0.5000 USDC' });
    expect(borrowButton).toBeNull();
    expect(repayButton).toBeEnabled();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('max repay in action queue', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: -1000000n,
    };

    const mockBasePost = {
      ...mockBase,
      balance: 0n,
    };

    render(
      hydratedMasthead({
        baseAssetToUse: mockBase,
        baseAssetPost: mockBasePost,
        actions: [[ActionType.Repay, mockBasePost, 1000000n]],
      })
    );

    const supplyButton = screen.getByRole('button', { name: 'Supply USDC' });
    const repayButton = screen.getByRole('button', { name: 'Repay 1.0000 USDC' });
    expect(supplyButton).toBeEnabled();
    expect(repayButton).toBeEnabled();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(3);
  });

  it('max repay in action queue and no wallet balance', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: -1000000n,
      walletBalance: 1000000n,
    };

    const mockBasePost = {
      ...mockBase,
      balance: 0n,
      walletBalance: 0n,
    };

    render(
      hydratedMasthead({
        baseAssetToUse: mockBase,
        baseAssetPost: mockBasePost,
        actions: [[ActionType.Repay, mockBasePost, 1000000n]],
      })
    );

    const supplyButton = screen.getByRole('button', { name: 'Supply USDC' });
    const repayButton = screen.getByRole('button', { name: 'Repay 1.0000 USDC' });
    expect(supplyButton).toBeDisabled();
    expect(repayButton).toBeEnabled();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(3);
  });

  it('max repay in action queue and pending supply action', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: -1000000n,
    };

    const mockBasePost = {
      ...mockBase,
      balance: 0n,
    };

    render(
      hydratedMasthead({
        baseAssetToUse: mockBase,
        baseAssetPost: mockBasePost,
        actions: [[ActionType.Repay, mockBasePost, 1000000n]],
        pendingAction: [ActionType.Supply, mockBasePost, undefined],
      })
    );

    const supplyButton = screen.getByRole('button', { name: 'Supply USDC' });
    const repayButton = screen.getByRole('button', { name: 'Repay 1.0000 USDC' });
    expect(supplyButton).toBeEnabled();
    expect(repayButton).toBeDisabled();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(3);
  });

  it('max repay in and supply action in action queue', () => {
    const mockBase = {
      ...MockBaseAssetWithAccountState,
      balance: -1000000n,
    };

    const mockBasePost = {
      ...mockBase,
      balance: 1000000n,
    };

    render(
      hydratedMasthead({
        baseAssetToUse: mockBase,
        baseAssetPost: mockBasePost,
        actions: [
          [ActionType.Repay, { ...mockBase, balance: 0n }, 1000000n],
          [ActionType.Supply, mockBasePost, 1000000n],
        ],
      })
    );

    const supplyButton = screen.getByRole('button', { name: 'Supply 1.0000 USDC' });
    const repayButton = screen.getByRole('button', { name: 'Repay 1.0000 USDC' });
    expect(supplyButton).toBeEnabled();
    expect(repayButton).toBeEnabled();

    const compareButton = screen.queryAllByRole('button').slice(-1)[0];
    expect(compareButton).toBeInTheDocument();
    expect(compareButton).toHaveClass('button--circle');
    expect(compareButton).toHaveClass('button--compare');
    expect(screen.getAllByRole('button').length).toBe(3);
  });
});

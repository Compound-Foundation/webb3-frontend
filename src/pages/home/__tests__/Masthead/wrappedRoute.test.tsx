import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { Theme } from '@hooks/useThemeManager';
import { Action, ActionType, BaseAssetWithAccountState, StateType } from '@types';

import { MockBaseAssetWithAccountState } from '../../../../../__tests__/mocks/mockTokens';
import Masthead from '../../components/Masthead';

const renderMasthead = (
  baseAsset: BaseAssetWithAccountState,
  isDirectBaseSupplyBlocked: boolean,
  actions: Action[] = []
) =>
  render(
    <div>
      <div id="overlay"></div>
      <Masthead
        state={[
          StateType.Hydrated,
          {
            actions,
            baseAsset,
            baseAssetPost: baseAsset,
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
            theme: Theme.Dark,
            isInstitutional: false,
            isDirectBaseSupplyBlocked,
          },
        ]}
      />
    </div>
  );

describe('Masthead on the wrapped route', () => {
  const emptyAccount = { ...MockBaseAssetWithAccountState, balance: 0n };

  it('does not offer a direct base supply to an empty account', () => {
    renderMasthead(emptyAccount, true);

    expect(screen.queryByRole('button', { name: 'Supply USDC' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Borrow USDC' })).toBeEnabled();
  });

  it('leaves borrowing exactly as on the standard route', () => {
    const noCapacity = { ...emptyAccount, borrowCapacity: 0n };

    renderMasthead(noCapacity, true);
    expect(screen.getByRole('button', { name: 'Borrow USDC' })).toBeDisabled();
  });

  it('still offers repaying a direct borrow', () => {
    renderMasthead({ ...MockBaseAssetWithAccountState, balance: -1_000_000_000n }, true);

    expect(screen.getByRole('button', { name: 'Repay USDC' })).toBeInTheDocument();
  });

  it('offers the direct base supply on the standard route', () => {
    renderMasthead(emptyAccount, false);

    expect(screen.getByRole('button', { name: 'Supply USDC' })).toBeEnabled();
  });
});

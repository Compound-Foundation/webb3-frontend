import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import { DelegateTypeEnum } from '@types';

import DelegateProfile from '../components/DelegateProfile';

const mockChangeDelegate = jest.fn();
const address = '0x0000000000000000000000000000000000000000';

const renderDelegateProfile = (delegateType: DelegateTypeEnum, delegateAddress: string) => {
  return render(
    <DelegateProfile
      delegateType={delegateType}
      delegateAddress={delegateAddress}
      chainId={1}
      chainKey={'mainnet'}
      onChangeDelegate={mockChangeDelegate}
    />
  );
};

describe('DelegateProfile', () => {
  test('renders self delegation', () => {
    renderDelegateProfile(DelegateTypeEnum.Self, address);
    expect(screen.getByText('Self')).toBeInTheDocument();
  });

  test('renders undelegated user', () => {
    renderDelegateProfile(DelegateTypeEnum.Undelegated, address);
    expect(screen.getByText('Undelegated')).toBeInTheDocument();
  });

  test('renders delegate user address or display account', async () => {
    renderDelegateProfile(DelegateTypeEnum.Delegated, address);
    expect(screen.getByText('0x0000...0000')).toBeInTheDocument();

    const delegateName = await screen.findByText('Example Delegate');
    expect(delegateName).toBeInTheDocument();
  });

  test('renders change delegate button', async () => {
    renderDelegateProfile(DelegateTypeEnum.Self, address);
    const buttons = screen.queryAllByRole('button');
    expect(buttons.length).toBe(1);

    fireEvent.click(screen.getByLabelText('Change delegate'));
    expect(mockChangeDelegate).toHaveBeenCalled();
  });
});

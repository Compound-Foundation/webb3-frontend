import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { StateType } from '@types';

import VoteWallet, { VoteWalletState } from '../components/VoteWallet';

const renderVoteWallet = (state: VoteWalletState) => {
  return render(<VoteWallet state={state} />);
};

describe('Vote Wallet', () => {
  test('renders no wallet state', () => {
    renderVoteWallet([StateType.NoWallet]);

    const connectButton = screen.getByText('Connect Wallet to Get Started');
    expect(connectButton).toBeInTheDocument();
    expect(connectButton).toHaveProperty('disabled');
  });
});

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router';

import { initializeContext } from '@contexts/SelectedMarketContext';
import { TALLY_GOV_URL } from '@helpers/urls';
import { StateType } from '@types';

import { mockWeb3 } from '../../../__tests__/mocks/mockWeb3';
import Header from '../Header';

jest.mock('@hooks/useTransactionHistory', () => ({
  RECENT_NUM: 3,
  useTransactionHistory: () => ({ state: [StateType.Loading] }),
}));
jest.mock('../MarketSelector', () => () => null);
jest.mock('../RewardsButton', () => () => null);
jest.mock('../WalletButton', () => ({ __esModule: true, default: () => null, TRX_HISTORY_ROUTE: '/transactions' }));

initializeContext({
  selectedMarket: [StateType.Loading, undefined],
  selectMarket: jest.fn(),
  selectMarketByAddress: jest.fn(),
} as never);

test('every Vote link, desktop and mobile, opens Tally', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Header
        web3={mockWeb3}
        transactions={[]}
        clearTransactions={jest.fn()}
        onConnectWalletClick={jest.fn()}
        onWalletDisconnect={jest.fn()}
      />
    </MemoryRouter>
  );

  const voteLinks = screen.getAllByRole('link', { name: 'Vote' });
  expect(voteLinks).toHaveLength(2);
  for (const link of voteLinks) {
    expect(link).toHaveAttribute('href', TALLY_GOV_URL);
    expect(link).toHaveAttribute('target', '_blank');
  }
});

import { render, screen } from '@testing-library/react';

import '@testing-library/jest-dom';
import type { Web3 } from '@contexts/Web3Context';

import { MockMarketsProvider } from '../../../__tests__/mocks/mockMarkets';
import { mockWeb3 } from '../../../__tests__/mocks/mockWeb3';
import AlertBanner from '../AlertBanner';

const MARKET_UNAVAILABLE = 'Market unavailable. Please check back shortly.';
const UNSUPPORTED_NETWORK = 'Compound III is not supported on this network. Please switch to a supported network.';

const renderBanner = (isMarketUnavailable: boolean, web3: Web3 = mockWeb3) =>
  render(
    <MockMarketsProvider>
      <AlertBanner web3={web3} isMarketUnavailable={isMarketUnavailable} />
    </MockMarketsProvider>
  );

describe('AlertBanner', () => {
  test('shows the message when the market is unavailable', () => {
    renderBanner(true);
    expect(screen.getByText(MARKET_UNAVAILABLE)).toBeInTheDocument();
  });

  test('stays hidden when the market is available', () => {
    renderBanner(false);
    expect(screen.queryByText(MARKET_UNAVAILABLE)).not.toBeInTheDocument();
  });

  test('shows both messages on an unsupported network with an unavailable market', () => {
    renderBanner(true, { ...mockWeb3, write: { ...mockWeb3.write, chainId: 999999 } });
    expect(screen.getByText(UNSUPPORTED_NETWORK)).toBeInTheDocument();
    expect(screen.getByText(MARKET_UNAVAILABLE)).toBeInTheDocument();
  });
});

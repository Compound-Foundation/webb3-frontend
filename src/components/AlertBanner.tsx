import { useContext } from 'react';
import { useLocation } from 'react-router';

import { useMarketsContext } from '@contexts/MarketsContext';
import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import { MarketData } from '@types';

export type AlertBannerProps = {
  web3: Web3;
  isCometStateError: boolean;
  isMarketsStateError: boolean;
};

const AlertBanner = ({ web3, isCometStateError, isMarketsStateError }: AlertBannerProps) => {
  const location = useLocation();

  const { markets, isLoading, getMarketStatus } = useMarketsContext();

  const { selectedMarket, isSelectedMarketError } = useContext(getSelectedMarketContext());

  const isHomePage = location.pathname === '/';

  const isMarketPage = /^\/markets\/[^/]+/.test(location.pathname);

  // The market summary can report the selected market in the error status even when its on-chain data loads
  const selected = selectedMarket[1];
  const isSelectedMarketStatusError =
    selected !== undefined && getMarketStatus(selected.chainInformation.chainId, selected.marketAddress) === 'error';

  const isMarketDataError =
    (isHomePage && (isSelectedMarketError || isCometStateError || isSelectedMarketStatusError)) ||
    (isMarketPage && (isSelectedMarketError || isMarketsStateError));

  const messages: string[] = [];
  // Until the registry loads every network would look unsupported
  if (!isLoading && web3.write.chainId && !isSupportedNetwork(markets, web3.write.chainId)) {
    messages.push('Compound III is not supported on this network. Please switch to a supported network.');
  }

  if (isMarketDataError) {
    messages.push('Market temporarily unavailable. Please check back shortly.');
  }

  const hideBannerClass = messages.length === 0 ? '--hide' : '';

  return (
    <div className={`alert-banner${hideBannerClass}`}>
      {messages.map((message) => (
        <div key={message} className="message">
          {message}
        </div>
      ))}
    </div>
  );
};

function isSupportedNetwork(markets: MarketData[], chainId: number): boolean {
  const marketForChainId = markets.find((market) => market.chainInformation.chainId === chainId);
  return marketForChainId !== undefined;
}

export default AlertBanner;

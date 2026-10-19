import { useContext } from 'react';
import { useLocation } from 'react-router';

import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import { useMarkets } from '@hooks/useMarkets';
import { StateType } from '@types';

export type AlertBannerProps = {
  web3: Web3;
};

const AlertBanner = ({ web3 }: AlertBannerProps) => {
  const [marketsStateType, marketsState] = useMarkets();
  const { selectedMarket } = useContext(getSelectedMarketContext());
  const { pathname } = useLocation();

  const isMarketPage = pathname === '/' || /^\/markets\/[^/]+/.test(pathname);

  const isMarketUnavailable = isMarketPage && selectedMarket[1]?.status === 'error';

  const messages: string[] = [];

  if (
    marketsStateType === StateType.Hydrated &&
    web3.write.chainId &&
    !marketsState.markets.some((market) => market.chainInformation.chainId === web3.write.chainId)
  ) {
    messages.push('Compound III is not supported on this network. Please switch to a supported network.');
  }

  if (isMarketUnavailable) {
    messages.push('Market temporarily unavailable. Please check back shortly.');
  }

  return (
    <div className={`alert-banner${messages.length === 0 ? '--hide' : ''}`}>
      {messages.map((message) => (
        <div key={message} className="message">
          {message}
        </div>
      ))}
    </div>
  );
};

export default AlertBanner;

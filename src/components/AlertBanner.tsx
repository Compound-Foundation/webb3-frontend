import type { Web3 } from '@contexts/Web3Context';
import { useMarkets } from '@hooks/useMarkets';
import { MarketData, StateType } from '@types';

export type AlertBannerProps = {
  web3: Web3;
  isMarketUnavailable: boolean;
};

const AlertBanner = ({ web3, isMarketUnavailable }: AlertBannerProps) => {
  const [marketsStateType, marketsState] = useMarkets();

  const messages: string[] = [];
  // Until the market list loads every network would look unsupported
  if (
    marketsStateType === StateType.Hydrated &&
    web3.write.chainId &&
    !isSupportedNetwork(marketsState.markets, web3.write.chainId)
  ) {
    messages.push('Compound III is not supported on this network. Please switch to a supported network.');
  }

  if (isMarketUnavailable) {
    messages.push('Market unavailable. Please check back shortly.');
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

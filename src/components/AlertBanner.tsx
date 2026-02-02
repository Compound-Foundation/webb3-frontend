import type { Web3 } from '@contexts/Web3Context';
import { MARKETS } from '@helpers/markets';

export type AlertBannerProps = {
  web3: Web3;
};

const AlertBanner = ({ web3 }: AlertBannerProps) => {
  const hideBanner = web3.write.chainId ? isSupportedNetwork(web3.write.chainId) : true;
  const hideBannerClass = hideBanner ? '--hide' : '';

  return (
    <div className={`alert-banner${hideBannerClass}`}>
      <div className="message">
        Compound III is not supported on this network. Please switch to a supported network.
      </div>
    </div>
  );
};

function isSupportedNetwork(chainId: number): boolean {
  const marketForChainId = MARKETS.find((market) => market.chainInformation.chainId === chainId);
  return marketForChainId !== undefined;
}

export default AlertBanner;

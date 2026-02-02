import { ExternalLink } from '@components/Icons';
import PanelWithHeader from '@components/PanelWithHeader';
import { getBlockExplorerUrlForAddress } from '@helpers/urls';
import { StateType } from '@types';

type AdditionalMarketDataPanelLoading = [StateType.Loading];

type AdditionalMarketDataPanelHydrated = [
  StateType.Hydrated,
  {
    currentChainName: string;
    currentChainId: number;
    currentBaseToken: string;
    marketAddress: string;
  }
];

type AdditionalMarketDataPanelContent = {
  blockAnalytica: string | undefined;
  etherscan: string | undefined;
  chaosLabs: string | undefined;
  gauntlet: string | undefined;
};

export type AdditionalMarketDataPanelState = AdditionalMarketDataPanelLoading | AdditionalMarketDataPanelHydrated;

function getAdditionalMarketDataUrls(state: AdditionalMarketDataPanelState): AdditionalMarketDataPanelContent {
  const [panelState, panelProps] = state;
  if (panelState === StateType.Loading) {
    return {
      blockAnalytica: undefined,
      etherscan: undefined,
      chaosLabs: undefined,
      gauntlet: undefined,
    };
  } else {
    const { currentBaseToken, currentChainName, currentChainId, marketAddress } = panelProps as {
      currentChainName: string;
      currentChainId: number;
      currentBaseToken: string;
      marketAddress: string;
    };

    return {
      blockAnalytica: getblockAnalyticaUrlForMarket(currentBaseToken, currentChainName),
      etherscan: getBlockExplorerUrlForAddress(currentChainId, marketAddress),
      chaosLabs: getChaosLabsUrlForMarket(currentBaseToken, currentChainName),
      gauntlet: getGauntletUrlForMarket(currentBaseToken, currentChainName),
    };
  }
}

type AdditionalMarketDataPanelProps = {
  state: AdditionalMarketDataPanelState;
};

export enum AnalyticSource {
  Etherscan = 'Etherscan',
  Gauntlet = 'Gauntlet',
  Analitica = 'Block Analitica',
  ChaosLabs = 'Chaos Labs',
}

const getblockAnalyticaUrlForMarket = (baseSymbol: string, chainName: string) => {
  switch (chainName) {
    case 'Ethereum':
      if (baseSymbol === 'USDC') {
        return 'https://compound.blockanalitica.com/v3/ethereum/usdc/markets/';
      } else {
        return 'https://compound.blockanalitica.com/v3/ethereum/eth/markets/';
      }
    default:
      return '';
  }
};

const getChaosLabsUrlForMarket = (baseSymbol: string, chainName: string) => {
  switch (chainName) {
    case 'Ethereum':
      if (baseSymbol === 'USDC') {
        return 'https://community.chaoslabs.xyz/compound/risk/markets/Ethereum-USDC/overview';
      } else {
        return 'https://community.chaoslabs.xyz/compound/risk/markets/Ethereum-WETH/overview';
      }
    case 'Polygon':
      return 'https://community.chaoslabs.xyz/compound/risk/markets/Polygon-USDC/overview';
    case 'Abitrum':
      return 'https://community.chaoslabs.xyz/compound/risk/markets/Arbitrum-USDC/overview';
    default:
      return '';
  }
};

const getGauntletUrlForMarket = (baseSymbol: string, chainName: string) => {
  switch (chainName) {
    case 'Ethereum':
      if (baseSymbol === 'USDC') {
        return 'https://risk.gauntlet.network/protocols/compound/markets/v3-eth-usdc';
      } else {
        return 'https://risk.gauntlet.network/protocols/compound/markets/v3-eth-weth';
      }
    case 'Polygon':
      return 'https://risk.gauntlet.network/protocols/compound/markets/v3-polygon-usdc';
    case 'Abitrum':
      return 'https://risk.gauntlet.network/protocols/compound/markets/v3-arbitrum';
    default:
      return '';
  }
};

const AdditionalMarketDataPanel = ({ state }: AdditionalMarketDataPanelProps) => {
  const { chaosLabs, etherscan, gauntlet, blockAnalytica } = getAdditionalMarketDataUrls(state);

  const getContent = (sourceType: AnalyticSource, sourceUrl: string | undefined) => {
    return (
      <div className="additional-market-data__content">
        {sourceUrl ? (
          <a href={sourceUrl} target="_blank" rel="noreferrer" className="text-link">
            <p className="L3 body--emphasized text-color--1">{sourceType}</p>
            <ExternalLink className="external-link svg--icon--2" />
          </a>
        ) : gauntlet === undefined ? (
          <p className="placeholder-content"></p>
        ) : (
          <></>
        )}
      </div>
    );
  };

  if (chaosLabs === '' && etherscan === '' && gauntlet == '' && blockAnalytica === '') return <></>;

  return (
    <PanelWithHeader header={'Additional Market Data'} className="grid-column--12">
      <div className="additional-market-data L2">
        {getContent(AnalyticSource.Etherscan, etherscan)}
        {getContent(AnalyticSource.Gauntlet, gauntlet)}
        {getContent(AnalyticSource.Analitica, blockAnalytica)}
        {getContent(AnalyticSource.ChaosLabs, chaosLabs)}
      </div>
    </PanelWithHeader>
  );
};

export default AdditionalMarketDataPanel;

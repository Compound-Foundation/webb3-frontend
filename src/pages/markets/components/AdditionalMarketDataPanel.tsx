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

const links: Record<string, Record<string, string>> = {
  Ethereum: {
    WBTC: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-ethereum-wbtc',
    wstETH: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-ethereum-wsteth',
    USDS: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-ethereum-usds',
    USDT: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-ethereum-usdt',
    ETH: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-ethereum-weth',
    USDC: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-ethereum-usdc',
  },
  Optimism: {
    ETH: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-optimism-weth',
    USDT: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-optimism-usdt',
    USDC: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-optimism-usdc'
  },
  Polygon: {
    'USDC.e': 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-polygon-usdc',
    USDT0: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-polygon-usdt'
  },
  Ronin: {
    RON: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-ronin-wron',
    WETH: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-ronin-weth'
  },
  Mantle: {
    USDe: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-mantle-usde'
  },
  Base: {
    USDbC: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-base-usdbc',
    AERO: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-base-aero',
    USDS: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-base-usds',
    ETH: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-base-weth',
    USDC: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-base-usdc',
  },
  Arbitrum: {
    ETH: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-arbitrum-weth',
    USDC: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-arbitrum-usdc',
    'USD₮0': 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-arbitrum-usdt',
    'USDC.e': 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-arbitrum-usdce'
  },
  Linea: {
    USDC: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-linea-usdc'
  },
  Scroll: {
    USDC: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-scroll-usdc'
  },
  Unichain: {
    USDC: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-unichain-usdc',
    ETH: 'https://dashboards.gauntlet.xyz/protocols/compound/markets/v3-unichain-weth'
  }
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
      return links['Ethereum'][baseSymbol];
    case 'Optimism':
      return links['Optimism'][baseSymbol];
    case 'Polygon':
      return links['Polygon'][baseSymbol];
    case 'Ronin':
      return links['Ronin'][baseSymbol];
    case 'Mantle':
      return links['Mantle'][baseSymbol];
    case 'Base':
      return links['Base'][baseSymbol];
    case 'Arbitrum':
      return links['Arbitrum'][baseSymbol];
    case 'Linea':
      return links['Linea'][baseSymbol];
    case 'Scroll':
      return links['Scroll'][baseSymbol];
    case 'Unichain':
      return links['Unichain'][baseSymbol];
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

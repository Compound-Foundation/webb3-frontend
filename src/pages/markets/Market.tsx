import { ReactNode, useContext } from 'react';
import { Link } from 'react-router';

import IconPair from '@components/IconPair';
import { ArrowLeft, ExternalLink } from '@components/Icons';
import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import { institutionalSupplyRewards } from '@helpers/institutionalRates';
import { getMarket, isV2Market } from '@helpers/markets';
import { formatTokenBalance, getTokenValue, PRICE_PRECISION } from '@helpers/numbers';
import { getBlockExplorerUrlForAddress, INSTITUTIONAL_MARKET_URL } from '@helpers/urls';
import { CTokenWithMarketState, Currency, StateType, TokenWithMarketState } from '@types';

import AdditionalMarketDataPanel from './components/AdditionalMarketDataPanel';
import AssetsTableRow from './components/AssetsTableRow';
import CollateralAssetsPanel from './components/CollateralAssetsPanel';
import type { InterestRateModelState } from './components/InterestRateModel';
import MarketHistoryPanel from './components/MarketHistoryPanel';
import MarketOverviewPanel, { MarketOverviewPanelView } from './components/MarketOverviewPanel';
import MarketRatesPanel from './components/MarketRatesPanel';
import MarketStatsPanel from './components/MarketStatsPanel';
import RateModelPanel from './components/RateModelPanel';
import { useMarketsState } from './hooks/useMarketsState';

type MarketsProps = {
  web3: Web3;
};

const Market = ({ web3 }: MarketsProps) => {
  const { selectedMarket } = useContext(getSelectedMarketContext());

  const marketCurrencyToShow = Currency.USD;

  const state = useMarketsState(web3, selectedMarket);
  const [marketStateType, marketStateData] = state;
  const [, market] = selectedMarket;
  const [currentChainName, currentChainId, currentBaseToken] =
    market !== undefined
      ? [market.chainInformation.name, market.chainInformation.chainId, market.baseAsset.symbol]
      : ['Connecting', -1, undefined];
  // The configured market entry keeps the display name and institutional flags,
  // which the hydrated market's on-chain base asset data doesn't carry
  const configMarket = market !== undefined ? getMarket(market.chainInformation.chainId, market.marketAddress) : undefined;
  const marketDisplayName = configMarket?.institutional ? configMarket.baseAsset.name : currentBaseToken;
  let assetRows: ReactNode = null;
  let marketOverviewPanel: ReactNode = null;
  let marketStatsPanel: ReactNode = null;
  let marketRatesPanel: ReactNode = null;
  let interestRateModelPanel: ReactNode = null;
  let additionalMarketDataPanel: ReactNode = null;
  let debtOutstandingFormatted = '';
  let collateralValueFormatted = '';
  let collateralHistoryPanel: ReactNode = null;
  let borrowHistoryPanel: ReactNode = null;
  let marketAddress: string | undefined;
  let blockExplorerUrl = '';
  let v2Markets = false;
  if (marketStateType === StateType.Loading && market !== undefined && isV2Market(market)) {
    marketOverviewPanel = <MarketOverviewPanel state={[StateType.Loading, undefined]} />;
    assetRows = [0, 0, 0, 0].map((_, index) => (
      <MarketOverviewPanel key={index} state={[StateType.Loading, undefined]} />
    ));
    marketAddress = market.marketAddress;
    v2Markets = true;
  } else if (marketStateType === StateType.Loading || market === undefined) {
    marketOverviewPanel = <MarketOverviewPanel state={[StateType.Loading, undefined]} />;
    assetRows = (
      <CollateralAssetsPanel>
        {[...Array(5)].map((_, index) => (
          <AssetsTableRow key={index} state={[StateType.Loading]} />
        ))}
      </CollateralAssetsPanel>
    );

    marketStatsPanel = <MarketStatsPanel state={[StateType.Loading]} />;
    marketRatesPanel = <MarketRatesPanel state={[StateType.Loading]} />;
    interestRateModelPanel = <RateModelPanel state={[StateType.Loading]} />;
    additionalMarketDataPanel = <AdditionalMarketDataPanel state={[StateType.Loading]} />;
  } else if (marketStateData?.type === 'V2ProtocolState') {
    const { cTokens, totalBorrow, totalSupply } = marketStateData;
    collateralValueFormatted = totalSupply;
    debtOutstandingFormatted = totalBorrow;
    marketAddress = market.marketAddress;
    v2Markets = true;

    assetRows = cTokens
      .sort((a: CTokenWithMarketState, b: CTokenWithMarketState): number =>
        a.unformattedTotalSupply > b.unformattedTotalSupply ? -1 : 1
      )
      .map((token, index) => {
        const modelState: InterestRateModelState = [
          StateType.Hydrated,
          {
            borrowRates: token.borrowRates,
            supplyRates: token.supplyRates,
            borrowAPR: token.borrowAPR,
            supplyAPR: token.supplyAPR,
            utilization: token.utilization,
            graphConfig: {
              height: 178,
              width: 400,
              graphMinX: 6,
              graphMaxX: 394,
              graphMinY: 60,
              graphMaxY: 160,
              isV2Graph: true,
            },
          },
        ];

        return (
          <MarketOverviewPanelView
            {...{
              baseAsset: { name: token.name, symbol: token.symbol },
              baseAssetPrice: token.price,
              borrowAPR: token.borrowAPR,
              borrowCap: token.borrowCap,
              collateralFactor: token.collateralFactor,
              earnAPR: token.supplyAPR,
              interestRateModel: modelState,
              reserveFactor: token.reserveFactor,
              reserves: token.reserves,
              rewardsAsset: 'COMP',
              totalBorrow: token.totalBorrow,
              totalSupply: token.totalSupply,
              withHeader: true,
            }}
            key={index}
          />
        );
      });
  } else if (marketStateData?.type === 'ProtocolAndMarketState') {
    const {
      borrowAPR,
      borrowRates,
      earnAPR,
      baseAsset,
      collateralAssets,
      reserves,
      supplyRates,
      totalBorrow,
      totalSupply,
      utilization,
    } = marketStateData;
    // Institutional markets pay USDC-terms rewards on top of the regular supply rate
    const { earnRewardsAPR, rewardsAsset, isInstitutionalReward } = institutionalSupplyRewards(
      market,
      undefined,
      undefined,
      baseAsset,
      marketStateData.totalBaseSupplyUsd,
    );

    assetRows = (
      <CollateralAssetsPanel>
        {collateralAssets
          .sort((a: TokenWithMarketState, b: TokenWithMarketState): number =>
            Number(a.totalSupply / BigInt(10 ** a.decimals)) * Number(a.price) >
            Number(b.totalSupply / BigInt(10 ** b.decimals)) * Number(b.price)
              ? -1
              : 1
          )
          .map((token, index) => (
            <AssetsTableRow key={index} state={[StateType.Hydrated, token, baseAsset]} />
          ))}
      </CollateralAssetsPanel>
    );

    marketRatesPanel = (
      <MarketRatesPanel
        state={[
          StateType.Hydrated,
          {
            borrowAPR,
            earnAPR,
            earnRewardsAPR,
            rewardsAsset,
            institutionalRewardsAPR: isInstitutionalReward ? earnRewardsAPR : undefined,
          },
        ]}
      />
    );

    marketStatsPanel = (
      <MarketStatsPanel
        state={[
          StateType.Hydrated,
          {
            baseAsset,
            reserves,
            totalBorrow,
            totalSupply,
            currency: marketCurrencyToShow,
          },
        ]}
      />
    );

    interestRateModelPanel = (
      <RateModelPanel
        state={[
          StateType.Hydrated,
          {
            borrowRates,
            supplyRates,
            borrowAPR,
            supplyAPR: earnAPR,
            utilization,
          },
        ]}
      />
    );

    additionalMarketDataPanel = (
      <AdditionalMarketDataPanel
        state={[
          StateType.Hydrated,
          {
            currentChainName,
            currentChainId,
            currentBaseToken: baseAsset.symbol,
            marketAddress: market.marketAddress,
          },
        ]}
      />
    );
    const debtOutstandingValue = getTokenValue(
      (totalBorrow * baseAsset.price) / BigInt(10 ** baseAsset.decimals),
      marketCurrencyToShow,
      baseAsset.baseAssetPriceInDollars,
      baseAsset.symbol
    );

    debtOutstandingFormatted = formatTokenBalance(PRICE_PRECISION, debtOutstandingValue, true, marketCurrencyToShow);
    const collateralAssetSumInDollars = collateralAssets.reduce((prev, curr) => {
      prev += (curr.totalSupply * curr.price) / BigInt(10 ** curr.decimals);
      return prev;
    }, 0n);

    const collateralValue = getTokenValue(
      collateralAssetSumInDollars,
      marketCurrencyToShow,
      baseAsset.baseAssetPriceInDollars,
      baseAsset.symbol
    );

    collateralValueFormatted = formatTokenBalance(PRICE_PRECISION, collateralValue, true, marketCurrencyToShow);

    collateralHistoryPanel = (
      <MarketHistoryPanel
        isBorrow={false}
        totalValue={collateralValueFormatted}
        marketHistory={marketStateData.marketHistory}
        currency={marketCurrencyToShow}
        baseAsset={baseAsset}
      />
    );
    borrowHistoryPanel = (
      <MarketHistoryPanel
        isBorrow={true}
        totalValue={debtOutstandingFormatted}
        marketHistory={marketStateData.marketHistory}
        currency={marketCurrencyToShow}
        baseAsset={baseAsset}
      />
    );

    blockExplorerUrl = getBlockExplorerUrlForAddress(market.chainInformation.chainId, market.marketAddress);
  }

  return (
    <>
      <main className="markets page grid-container">
        <section className="markets__masthead grid-column--12">
          <Link to="/markets" className="markets__back text-link">
            <ArrowLeft className="svg--icon--2 markets__arrow" />
            <div className="label text-color--2 L1">Markets</div>
          </Link>
          {market !== undefined && (
            <div className="token-pair L1">
              <div className="token-pair__icons">
                <IconPair className="icon-pair--reverse-draw" icon1={market.iconPair[1]} icon2={market.iconPair[0]} />
              </div>
              <div className="token-pair__info">
                <h2 className="token-pair__names heading heading--emphasized text-color--1">
                  {marketDisplayName}
                  <span className="token-pair__names__divider">•</span>
                  <span className="token-pair__names__chain-name">{currentChainName}</span>
                  {configMarket?.isNew && (
                    <span className="token-pair__names__new-badge new-badge new-badge--large label">New</span>
                  )}
                </h2>
                {v2Markets ? (
                  <div className="token-pair__address">
                    <label className="label">{marketAddress}</label>
                    <a href={blockExplorerUrl} target="_blank" rel="noreferrer" className="line-icon">
                      <ExternalLink className="svg--icon--2" />
                    </a>
                  </div>
                ) : (
                  <></>
                )}
              </div>
              {configMarket?.institutional && (
                <a
                  className="button button--large token-pair__learn-more"
                  href={INSTITUTIONAL_MARKET_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Learn More
                </a>
              )}
            </div>
          )}
          {marketStateData !== undefined && market !== undefined && (
            <div className="split-panels">
              <div className="split-panels__item">{collateralHistoryPanel}</div>
              <div className="split-panels__item">{borrowHistoryPanel}</div>
            </div>
          )}
        </section>
        {marketStatsPanel}
        {v2Markets ? marketOverviewPanel : marketRatesPanel}
        {interestRateModelPanel}
        {assetRows}
        {additionalMarketDataPanel}
      </main>
    </>
  );
};

export default Market;

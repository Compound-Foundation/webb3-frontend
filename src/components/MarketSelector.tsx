import { useState, useRef, useContext, useEffect, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';

import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import { iconNameForChainId } from '@helpers/assets';
import { V2_ALERT_DISMISSED_KEY } from '@helpers/constants';
import { areSameMarket, getMarketsByNetwork, isV2Market, V2_MARKET_KEY } from '@helpers/markets';
import { V2_URL } from '@helpers/urls';
import useOnClickOutside from '@hooks/useOnClickOutside';
import { MarketData, MarketDataLoaded, MarketsByNetwork } from '@types';

import IconPair from './IconPair';
import { ArrowRightNoDash, CaretDown, CheckMark, Close, MagnifyingGlass, TailSpin } from './Icons';
import MarketNetworkIcon from './MarketNetworkIcon';

const APPROVE_IN_WALLET = 'Approve in wallet';
const LEGACY = 'Legacy';

const MarketSelector = () => {
  const [marketDropdownActive, setMarketDropdownActive] = useState<boolean>(false);
  const { selectedMarket, selectMarket } = useContext(getSelectedMarketContext());
  const [selectedChainId, setSelectedChainId] = useState<number>(selectedMarket[1]?.chainInformation.chainId ?? 1);
  const [, currentMarket] = selectedMarket;
  const [searchParams] = useSearchParams();
  const marketsByNetwork = getMarketsByNetwork(searchParams.has('testnet'));

  const ref = useRef(null);

  useOnClickOutside(ref, () => setMarketDropdownActive(false));

  return (
    <div ref={ref} className="header__pill-dropdown market-selector L2">
      <div className="dropdown">
        <SelectedMarket
          active={marketDropdownActive}
          market={currentMarket}
          onClick={() => {
            setMarketDropdownActive(!marketDropdownActive);
          }}
        />

        {marketDropdownActive && (
          <div className={`dropdown__content`}>
            <SupportedNetworks
              marketsByNetwork={marketsByNetwork}
              selectedChainId={selectedChainId}
              setSelectedChainId={setSelectedChainId}
            />
            <SupportedMarkets
              currentMarket={currentMarket}
              markets={marketsByNetwork[selectedChainId].markets}
              pathname={location.pathname}
              onSelectMarket={(market: MarketData) => {
                setMarketDropdownActive(false);
                selectMarket(market);
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

type SelectedMarketProps = {
  active: boolean;
  market: MarketData | MarketDataLoaded | undefined;
  onClick: () => void;
};

const SelectedMarket = ({ active, market, onClick }: SelectedMarketProps) => {
  const [currentChainName, currentBaseToken] =
    market !== undefined ? [market.chainInformation.name, market.baseAsset.symbol] : ['Connecting', undefined];
  return (
    <div
      className={`button market-selector__selected-market${active ? ' market-selector__selected-market--active' : ''}`}
      onClick={onClick}
    >
      {market !== undefined && market.iconPair ? (
        <IconPair className="mobile-hide" icon1={market.iconPair[1]} icon2={market.iconPair[0]} />
      ) : null}

      <div className="market-selector__selected-market__info">
        {currentBaseToken && <label className="label text-color--1 L1">{currentBaseToken}</label>}
      </div>
      <div className="market-selector__selected-market__info">
        <label className="label text-color--2 L1">{currentChainName}</label>
      </div>
      <div className="market-selector__selected-market__info">
        <label className="label label--secondary text-color--2">
          <CaretDown className="market-selector__selected-market__info--caret-down" />
        </label>
      </div>
    </div>
  );
};

type SupportedNetworksProps = {
  marketsByNetwork: MarketsByNetwork;
  selectedChainId: number;
  setSelectedChainId: (chainId: number) => void;
};

const SupportedNetworks = ({ marketsByNetwork, selectedChainId, setSelectedChainId }: SupportedNetworksProps) => {
  const networks = Object.entries(marketsByNetwork)
    .sort((a, b) => {
      if (a[1].markets.length < b[1].markets.length) {
        return -1;
      }
      if (a[1].markets.length > b[1].markets.length) {
        return 1;
      }

      return b[1].chainInformation.name.localeCompare(a[1].chainInformation.name);
    })
    .reverse();

  if (networks.length <= 1) {
    return null;
  }

  return (
    <>
      <div className="market-selector__options">
        {networks.map(([_chainId, { chainInformation, markets }]) => {
          const chainId = Number(_chainId);
          return (
            <div
              className={`market-selector__option${
                chainId === selectedChainId ? ' market-selector__option--active' : ''
              }`}
              onMouseEnter={() => {
                setSelectedChainId(chainId);
              }}
              key={chainId}
            >
              <MarketNetworkIcon icon={iconNameForChainId(chainId)} />
              <div className="market-selector__option__info">
                <span className="label text-color--1 L1">{chainInformation.name}</span>
              </div>

              <div className="market-selector__option__info--right">
                <span className="label text-color--2 L1">{markets.length}</span>
              </div>
              <div className="market-selector__option__info market-selector__option--arrow">
                <ArrowRightNoDash className="svg--icon--3 extension-list-row__arrow-select" />
              </div>
            </div>
          );
        })}
      </div>
      <div className="divider"></div>
    </>
  );
};

type MarketOptionProps = {
  isCurrentMarket: boolean;
  market: MarketData;
  pathname: string;
  onClick: () => void;
  loading: boolean;
};

const MarketOption = ({ isCurrentMarket, market, pathname, onClick, loading }: MarketOptionProps) => {
  const content = (
    <>
      <MarketNetworkIcon icon={market.iconPair[1]} />
      <div className="market-selector__option__info">
        <span className="label text-color--1 L1">{market.baseAsset.symbol}</span>
        {loading && <span className="label label--secondary text-color--2">{APPROVE_IN_WALLET}</span>}
      </div>
      {isCurrentMarket && <CheckMark className="svg--supply" />}
      {loading && <TailSpin className="svg--spin" />}
    </>
  );

  if (isV2Market(market) && pathname === '/') {
    // V2 market isn't supported so should link out to the V2 app
    return (
      <a
        key={market.baseAsset.symbol}
        className={`market-selector__option`}
        href={V2_URL}
        target="_blank"
        rel="noreferrer"
        onClick={onClick}
      >
        {content}
      </a>
    );
  }

  return (
    <div key={market.baseAsset.symbol} className={`market-selector__option`} onClick={onClick}>
      {content}
    </div>
  );
};

type SupportedMarketsProps = {
  currentMarket: MarketData | MarketDataLoaded | undefined;
  markets: MarketData[];
  pathname: string;
  onSelectMarket: (market: MarketData) => void;
};

const SupportedMarkets = ({ currentMarket, markets, pathname, onSelectMarket }: SupportedMarketsProps) => {
  return (
    <div className={`market-selector__options`}>
      {markets.map((market: MarketData, index: number) => {
        const onClick = () => {
          onSelectMarket(market);
        };

        const isCurrentMarket = currentMarket === undefined ? false : areSameMarket(currentMarket, market);
        return (
          <Fragment key={`${index}-${market.baseAsset}`}>
            {market.baseAsset.symbol === V2_MARKET_KEY && (
              <div className="legacy-wrapper">
                <label className="label label--secondary text-color--2">{LEGACY}</label>
              </div>
            )}
            <MarketOption
              key={market.marketAddress}
              isCurrentMarket={isCurrentMarket}
              market={market}
              pathname={pathname}
              onClick={(pathname === '/' && isV2Market(market)) || isCurrentMarket ? () => undefined : onClick}
              loading={false} // TODO(mykelp): This actually needs to be handled properly
            />
          </Fragment>
        );
      })}
    </div>
  );
};

export default MarketSelector;

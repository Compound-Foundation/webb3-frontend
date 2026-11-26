import { useState, useRef, useContext, Fragment } from 'react';

import Tooltip from '@components/Tooltip';
import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import { iconNameForChainId } from '@helpers/assets';
import { areSameMarket, getMarket, getMarketsByNetwork, isV2Market, V2_MARKET_KEY } from '@helpers/markets';
import { V2_URL } from '@helpers/urls';
import { useMarkets } from '@hooks/useMarkets';
import useOnClickOutside from '@hooks/useOnClickOutside';
import { Theme } from '@hooks/useThemeManager';
import { MarketData, MarketDataLoaded, MarketsByNetwork, StateType } from '@types';

import IconPair from './IconPair';
import { ArrowRightNoDash, CaretDown, CheckMark, CircleExclamation, HoverUnder, TailSpin } from './Icons';
import MarketNetworkIcon from './MarketNetworkIcon';

const APPROVE_IN_WALLET = 'Approve in wallet';
const LEGACY = 'Legacy';
const INSTITUTIONAL = 'Institutional';
const MARKETS_SECTION = 'Markets';
const NEW = 'New';
const MARKETS_UNAVAILABLE = 'Markets unavailable';
const MARKET_UNAVAILABLE = 'Market temporarily unavailable.';
const INACTIVE_MARKETS = 'Inactive Markets';
const INACTIVE_MARKETS_TOOLTIP =
  'These markets no longer accept new deposits or loans. Users with existing balances can still withdraw or repay loans.';

type SelectedNetwork = { chainId: number; isInactive: boolean };

const MarketSelector = ({ theme }: { theme: Theme }) => {
  const [marketDropdownActive, setMarketDropdownActive] = useState<boolean>(false);
  const { selectedMarket, selectMarket } = useContext(getSelectedMarketContext());
  // A network with both kinds of markets is listed twice, so the hovered entry is its chain plus the list it's in
  const [selectedNetwork, setSelectedNetwork] = useState({
    chainId: selectedMarket[1]?.chainInformation.chainId ?? 1,
    isInactive: !!selectedMarket[1]?.isInactive,
  });
  const [, currentMarket] = selectedMarket;
  const [marketsStateType, marketsState] = useMarkets();
  const marketsByNetwork = getMarketsByNetwork(marketsStateType === StateType.Hydrated ? marketsState.markets : []);
  // A market list refresh can drop the network picked earlier
  const shownNetwork: SelectedNetwork =
    selectedNetwork.chainId in marketsByNetwork
      ? selectedNetwork
      : { chainId: Number(Object.keys(marketsByNetwork)[0]), isInactive: false };

  const ref = useRef(null);

  useOnClickOutside(ref, () => setMarketDropdownActive(false));

  if (marketsStateType === StateType.Loading && marketsState.loadFailed) {
    return (
      <div className="header__pill-dropdown market-selector">
        <label className="label label--secondary market-selector__unavailable-label market-selector__unavailable-label-container">
          {MARKETS_UNAVAILABLE}
        </label>
      </div>
    );
  }

  if (currentMarket === undefined) {
    return null;
  }

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
              selectedNetwork={shownNetwork}
              theme={theme}
              onSelectNetwork={setSelectedNetwork}
            />
            <SupportedMarkets
              currentMarket={currentMarket}
              markets={
                marketsByNetwork[shownNetwork.chainId]?.markets.filter(
                  (market) => !!market.isInactive === shownNetwork.isInactive
                ) ?? []
              }
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
  market: MarketData | MarketDataLoaded;
  onClick: () => void;
};

const SelectedMarket = ({ active, market, onClick }: SelectedMarketProps) => {
  const [marketsStateType, marketsState] = useMarkets();
  // The market list symbol stays the same once the market loads, unlike the on-chain one,
  // so the label doesn't change
  const configMarket =
    marketsStateType === StateType.Hydrated
      ? getMarket(marketsState.markets, market.chainInformation.chainId, market.marketAddress)
      : undefined;
  const currentChainName = market.chainInformation.name;
  const currentBaseToken = configMarket?.baseAsset.symbol ?? market.baseAsset.symbol;

  return (
    <div
      className={`button market-selector__selected-market${active ? ' market-selector__selected-market--active' : ''}`}
      onClick={onClick}
    >
      {market.iconPair ? (
        <IconPair className="mobile-hide" icon1={market.iconPair[1]} icon2={market.iconPair[0]} />
      ) : null}

      <div className="market-selector__selected-market__info">
        <label className="label text-color--1 L1">{currentBaseToken}</label>
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
  selectedNetwork: SelectedNetwork;
  theme: Theme;
  onSelectNetwork: (network: SelectedNetwork) => void;
};

const sortNetworks = (networks: MarketsByNetwork[number][]) =>
  networks
    .sort((a, b) => {
      if (a.markets.length < b.markets.length) {
        return -1;
      }
      if (a.markets.length > b.markets.length) {
        return 1;
      }

      return b.chainInformation.name.localeCompare(a.chainInformation.name);
    })
    .reverse();

const SupportedNetworks = ({
  marketsByNetwork,
  selectedNetwork,
  theme,
  onSelectNetwork,
}: SupportedNetworksProps) => {
  const [networks, inactiveNetworks] = [false, true].map((isInactive) =>
    sortNetworks(
      Object.values(marketsByNetwork)
        .map((network) => ({
          ...network,
          markets: network.markets.filter((market) => !!market.isInactive === isInactive),
        }))
        .filter((network) => network.markets.length > 0)
    )
  );

  if (networks.length + inactiveNetworks.length <= 1) {
    return null;
  }

  const renderNetworks = (entries: typeof networks, isInactive: boolean) =>
    entries.map(({ chainInformation, markets }) => {
      const { chainId } = chainInformation;
      const isActive = chainId === selectedNetwork.chainId && isInactive === selectedNetwork.isInactive;
      return (
        <div
          className={`market-selector__option${isActive ? ' market-selector__option--active' : ''}`}
          onMouseEnter={() => {
            onSelectNetwork({ chainId, isInactive });
          }}
          key={chainId}
        >
          <MarketNetworkIcon icon={iconNameForChainId(chainId)} />
          <div className="market-selector__option__info">
            <span className="label text-color--1 L1">{chainInformation.name}</span>
          </div>

          <div className="market-selector__option__info--right">
            <span className="label text-color--2 L1">{markets.filter((market) => !isV2Market(market)).length}</span>
          </div>
          <div className="market-selector__option__info market-selector__option--arrow">
            <ArrowRightNoDash className="svg--icon--3 extension-list-row__arrow-select" />
          </div>
        </div>
      );
    });

  return (
    <>
      <div className="market-selector__options">
        {renderNetworks(networks, false)}
        {inactiveNetworks.length > 0 && (
          <>
            <div className="legacy-wrapper">
              <Tooltip
                content={<span className="market-selector__tooltip-text">{INACTIVE_MARKETS_TOOLTIP}</span>}
                width={230}
                yOffset={14}
                interactive={true}
              >
                <div className="market-selector__inactive-label">
                  <label className="label label--secondary text-color--2">{INACTIVE_MARKETS}</label>
                  <HoverUnder className="hover-under" long={true} theme={theme} />
                </div>
              </Tooltip>
            </div>
            {renderNetworks(inactiveNetworks, true)}
          </>
        )}
      </div>
      <div className="divider"></div>
    </>
  );
};

type MarketOptionProps = {
  isCurrentMarket: boolean;
  isError: boolean;
  market: MarketData;
  pathname: string;
  onClick: () => void;
  loading: boolean;
};

const MarketOption = ({ isCurrentMarket, isError, market, pathname, onClick, loading }: MarketOptionProps) => {
  const [hovered, setHovered] = useState(false);
  const hoverHandlers = { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) };
  const content = (
    <>
      <MarketNetworkIcon icon={market.iconPair[1]} className={`${isError ? 'icon-disabled' : ''}`}/>
      <div className="market-selector__option__info">
        <span className={`label text-color--1 L1 ${isError ? "text-color--3" : ''}`}>{market.baseAsset.symbol}</span>
        {loading && <span className="label label--secondary text-color--2">{APPROVE_IN_WALLET}</span>}
      </div>
      {isError && (
        <Tooltip
          open={hovered}
          width={200}
          yOffset={12}
          content={<span className="market-selector__tooltip-text">{MARKET_UNAVAILABLE}</span>}
        >
          <span className="market-selector__option__exclamation">
            <CircleExclamation className="svg--icon--3 market-selector__option__exclamation-icon" />
          </span>
        </Tooltip>
      )}
      {market.isNew && <span className="new-badge label label--secondary">{NEW}</span>}
      {isCurrentMarket && <CheckMark className="svg--supply" />}
      {loading && <TailSpin className="svg--spin" />}
    </>
  );

  if (isV2Market(market) && pathname === '/' && !isError) {
    // V2 market isn't supported so should link out to the V2 app
    return (
      <a
        key={market.baseAsset.symbol}
        className={`market-selector__option`}
        href={V2_URL}
        target="_blank"
        rel="noreferrer"
        onClick={onClick}
        {...hoverHandlers}
      >
        {content}
      </a>
    );
  }

  return (
    <div
      key={market.baseAsset.symbol}
      className={`market-selector__option`}
      aria-disabled={isError}
      onClick={onClick}
      {...hoverHandlers}
    >
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
  const institutionalMarkets = markets.filter((market: MarketData) => market.institutional);
  const standardMarkets = markets.filter((market: MarketData) => !market.institutional);

  const renderMarket = (market: MarketData, index: number) => {
    const onClick = () => {
      onSelectMarket(market);
    };

    const isCurrentMarket = currentMarket === undefined ? false : areSameMarket(currentMarket, market);
    // Markets in the error status are shown but can't be picked
    const isError = market.status === 'error';
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
          isError={isError}
          market={market}
          pathname={pathname}
          onClick={(pathname === '/' && isV2Market(market)) || isCurrentMarket || isError ? () => undefined : onClick}
          loading={false} // TODO(mykelp): This actually needs to be handled properly
        />
      </Fragment>
    );
  };

  return (
    <div className={`market-selector__options`}>
      {institutionalMarkets.length > 0 && (
        <>
          <div className="legacy-wrapper">
            <label className="label label--secondary text-color--2">{INSTITUTIONAL}</label>
          </div>
          {institutionalMarkets.map(renderMarket)}
          <div className="legacy-wrapper">
            <label className="label label--secondary text-color--2">{MARKETS_SECTION}</label>
          </div>
        </>
      )}
      {standardMarkets.map(renderMarket)}
    </div>
  );
};

export default MarketSelector;

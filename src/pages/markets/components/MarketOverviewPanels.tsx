import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import CircleMeter from '@components/CircleMeter';
import DetailSheet from '@components/DetailSheet';
import IconPair from '@components/IconPair';
import { CaretDown, CheckMark } from '@components/Icons';
import PanelWithHeader from '@components/PanelWithHeader';
import PanelWithNoHeader from '@components/PanelWithNoHeader';
import { CHAINS } from '@constants/chains';
import { assetIconForAssetSymbol, iconNameForChainId } from '@helpers/assets';
import { getMarketDescriptors } from '@helpers/markets';
import { BASE_FACTOR, PRICE_PRECISION, formatValueInDollars } from '@helpers/numbers';
import useOnClickOutside from '@hooks/useOnClickOutside';

import { LatestMarketSummaries, MarketSummary } from '../../../types';

const SORT_BY_OPTIONS = [
  'Utilization',
  'Earn APR',
  'Borrow APR',
  'Total Earning',
  'Total Borrowing',
  'Total Collateral',
] as const;
const SORT_ORDER_OPTIONS = ['Ascending', 'Descending'] as const;

type MarketOverviewPanelsProps = {
  latestMarketSummaries: LatestMarketSummaries;
};
const MarketOverviewPanels = ({ latestMarketSummaries }: MarketOverviewPanelsProps) => {
  const [sortBy, setSortBy] = useState<(typeof SORT_BY_OPTIONS)[number]>('Utilization');
  const [sortOrder, setSortOrder] = useState<(typeof SORT_ORDER_OPTIONS)[number]>('Ascending');
  const [sortByDropdownActive, setSortByDropdownActive] = useState<boolean>(false);
  const [sortOrderDropdownActive, setSortOrderDropdownActive] = useState<boolean>(false);

  const sortByDropdownRef = useRef(null);
  useOnClickOutside(sortByDropdownRef, () => setSortByDropdownActive(false));
  const sortOrderDropdownRef = useRef(null);
  useOnClickOutside(sortOrderDropdownRef, () => setSortOrderDropdownActive(false));

  // Groups market summaries by chain ID
  const marketSummariesByChain = latestMarketSummaries.reduce((acc, marketSummary) => {
    const { chainId } = marketSummary;
    if (!acc[chainId]) {
      acc[chainId] = [];
    }
    acc[chainId].push(marketSummary);
    return acc;
  }, {} as { [chainId: string]: LatestMarketSummaries });

  // Sort the markets in place
  Object.values(marketSummariesByChain).forEach((marketSummaries) => {
    const sortByMap = {
      Utilization: 'utilization',
      'Earn APR': 'supplyAPR',
      'Borrow APR': 'borrowAPR',
      'Total Earning': 'totalSupplyValue',
      'Total Borrowing': 'totalBorrowValue',
      'Total Collateral': 'totalCollateralValue',
    };

    const sortByKey = sortByMap[sortBy];

    // Ascending, sort "a to z", descending sort "z to a"
    marketSummaries.sort((a, z) => {
      const aVal = a[sortByKey as keyof MarketSummary] as bigint;
      const zVal = z[sortByKey as keyof MarketSummary] as bigint;

      if (sortOrder === 'Ascending') {
        return Number(aVal - zVal);
      } else {
        return Number(zVal - aVal);
      }
    });
  });

  const sortByStyle = sortByDropdownActive ? 'market-overview-panels__sort-button--active' : '';
  const sortOrderStyle = sortOrderDropdownActive ? 'market-overview-panels__sort-button--active' : '';

  return (
    <div>
      <div className="market-overview-panels__dropdowns">
        <div
          className="dropdown"
          onClick={() => setSortByDropdownActive(!sortByDropdownActive)}
          ref={sortByDropdownRef}
        >
          <button className={`button market-overview-panels__sort-button L2 ${sortByStyle}`}>
            <label className="label text-color--2">Sort by</label>
            <label className="label text-color--1">{sortBy}</label>
            <CaretDown />
          </button>

          <Dropdown
            options={SORT_BY_OPTIONS}
            currentOption={sortBy}
            setOption={setSortBy}
            active={sortByDropdownActive}
            setActive={setSortByDropdownActive}
          />
        </div>

        <div
          className="dropdown"
          onClick={() => setSortOrderDropdownActive(!sortOrderDropdownActive)}
          ref={sortOrderDropdownRef}
        >
          <button className={`button market-overview-panels__sort-button L2 ${sortOrderStyle}`}>
            <label className="label text-color--2">Order</label>
            <label className="label text-color--1">{sortOrder}</label>
            <CaretDown />
          </button>

          <Dropdown
            options={SORT_ORDER_OPTIONS}
            currentOption={sortOrder}
            setOption={setSortOrder}
            active={sortOrderDropdownActive}
            setActive={setSortOrderDropdownActive}
          />
        </div>
      </div>

      {Object.keys(marketSummariesByChain).map((chainId) => {
        return <Panel key={chainId} chainId={Number(chainId)} marketSummaries={marketSummariesByChain[chainId]} />;
      })}

      <div className="market-overview-panels__tables-container">
        <PanelWithNoHeader>
          <label className="label L2 text-color--1">Looking for V2? </label>
          <label className="label L2 text-color--2">Compound V2 market data has moved to </label>
          <Link className="label L2 text-color--2" to="/markets/v2" onClick={() => scrollTo(0, 0)}>
            app.compound.finance/markets/v2
          </Link>
        </PanelWithNoHeader>
      </div>
    </div>
  );
};

type DropdownProps<T> = {
  options: readonly T[];
  currentOption: string;
  setOption: (option: T) => void;
  active: boolean;
  setActive: (active: boolean) => void;
};
function Dropdown<T extends string>({ options, currentOption, active, setOption, setActive }: DropdownProps<T>) {
  const content = options.map((option) => {
    const isActive = option === currentOption;

    return (
      <button
        key={option}
        className="market-overview-panels__dropdown-button"
        onClick={(e) => {
          setOption(option);
          setActive(false);
          e.stopPropagation();
        }}
      >
        <label className="label L2 text-color--1">{option}</label>
        {isActive ? <CheckMark className="svg--supply" /> : null}
      </button>
    );
  });

  return (
    <>
      {/* Desktop */}
      <div className="mobile-hide">{active ? <div className={`dropdown__content`}>{content}</div> : null}</div>
      {/* Mobile */}
      <DetailSheet active={active}>{content}</DetailSheet>
    </>
  );
}

type PanelProps = {
  chainId: number;
  marketSummaries: LatestMarketSummaries;
};
const Panel = ({ chainId, marketSummaries }: PanelProps) => {
  const chainName = CHAINS[chainId].name;

  const headerWithLogo = (
    <div className="market-overview-panels__header-with-logo">
      <span className={`asset asset--${iconNameForChainId(chainId)}`}></span>
      <label className="label L1 text-color--1">{chainName}</label>
    </div>
  );

  return (
    <div className="market-overview-panels__tables-container">
      <PanelWithHeader header={headerWithLogo} className="assets-table-panel grid-column--12">
        <div className="panel panel--markets-assets L3">
          <div className="panel--markets-assets__content">
            <table className="assets-table">
              <TableHead />
              <tbody>
                {marketSummaries.map((marketSummary) => {
                  return <PanelRow key={marketSummary.comet.address} marketSummary={marketSummary} />;
                })}
              </tbody>
            </table>
          </div>
        </div>
      </PanelWithHeader>
    </div>
  );
};

type PanelRowProps = {
  marketSummary: MarketSummary;
};
const PanelRow = ({ marketSummary }: PanelRowProps) => {
  const [assetSymbol, chainName, assetName] = getMarketDescriptors(marketSummary.comet.address, marketSummary.chainId);

  const getPercentage = (val: bigint) => {
    const percentage = Number((val * 10_000n) / BASE_FACTOR) / 100;
    return percentage.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const utilization = getPercentage(marketSummary.utilization);
  const netEarnAPR = getPercentage(marketSummary.supplyAPR);
  const netBorrowAPR = getPercentage(marketSummary.borrowAPR);

  const shortMarketName = () => {
    const name = assetSymbol === 'ETH' ? 'WETH' : assetSymbol;
    const chain = CHAINS[marketSummary.chainId].key;

    return `${name}-${chain}`.toLowerCase();
  };
  const marketPath = `/markets/${shortMarketName()}`;

  const navigate = useNavigate();
  const handleRowClick = () => {
    navigate(marketPath);

    // Scroll to the top of the page after navigation
    scrollTo(0, 0);
  };

  return (
    // The Link component doesn't work here because tr must be
    // a direct child of tbody and td must be a direct child of tr
    <tr className="market-overview-panels__table-row" onClick={handleRowClick}>
      <td>
        <div className="market-overview-panels__market-container">
          <IconPair
            className="icon-pair--reverse-draw"
            icon1={assetIconForAssetSymbol(assetSymbol)}
            icon2={iconNameForChainId(marketSummary.chainId)}
          />
          <div className="market-overview-panels__asset-description-container">
            <AssetName assetName={assetName} />
            <div className="label text-color--2 L2">
              {assetSymbol} ∙ {chainName}
            </div>
          </div>
        </div>
      </td>
      <td>
        <div className="market-overview-panels__utilization-container">
          <CircleMeter percentageFill={utilization.toString()} />
          <div className="body text-color--1 L3">{utilization}%</div>
        </div>
      </td>
      <td>
        <div className="body text-color--1 L3">{netEarnAPR}%</div>
      </td>
      <td>
        <div className="body text-color--1 L3">{netBorrowAPR}%</div>
      </td>
      <td>
        <div className="body text-color--1 L3">
          {formatValueInDollars(PRICE_PRECISION, marketSummary.totalSupplyValue)}
        </div>
      </td>
      <td>
        <div className="body text-color--1 L3">
          {formatValueInDollars(PRICE_PRECISION, marketSummary.totalBorrowValue)}
        </div>
      </td>
      <td>
        <div className="body text-color--1 L3">
          {formatValueInDollars(PRICE_PRECISION, marketSummary.totalCollateralValue)}
        </div>
      </td>
      <td>
        <CollateralAssets collateralAssets={marketSummary.collateralAssetSymbols} />
      </td>
    </tr>
  );
};

type CollateralAssetsProps = {
  collateralAssets: string[];
};
const CollateralAssets = ({ collateralAssets }: CollateralAssetsProps) => {
  // divide the icons into two rows of equal lengths (5 & 5 for 10 icons, 8 & 7 for 15 icons, etc.)
  // we're using 9 and more as the cut-off to divide into two rows
  const shouldUseEqualRows = collateralAssets.length > 8;
  const iconsPerRow = shouldUseEqualRows ? Math.ceil(collateralAssets.length / 2) : collateralAssets.length;

  return (
    <div className="market-overview-panels__collateral-asset-container">
      <label className="body text-color--1 L3">{collateralAssets.length}</label>
      <div
        className={`market-overview-panels__collateral-asset-icons-container ${
          shouldUseEqualRows ? 'market-overview-panels__collateral-asset-icons-container--equal-rows' : ''
        }`}
        style={shouldUseEqualRows ? { gridTemplateColumns: `repeat(${iconsPerRow}, calc(1rem - 0.25rem))` } : undefined}
      >
        {collateralAssets.map((collateralAsset) => {
          return (
            <div
              key={collateralAsset}
              className={`asset asset--${assetIconForAssetSymbol(
                collateralAsset
              )} market-overview-panels__collateral-asset-icon`}
            />
          );
        })}
      </div>
    </div>
  );
};

const TableHead = () => {
  return (
    <thead>
      <tr className="assets-table__row assets-table__row--header market-overview-panels__table-header L2">
        <th className="label">Market</th>
        <th className="label">Utilization</th>
        <th className="label">Net Earn APR</th>
        <th className="label">Net Borrow APR</th>
        <th className="label">Total Earning</th>
        <th className="label">Total Borrowing</th>
        <th className="label">Total Collateral</th>
        <th className="label">Collateral Assets</th>
      </tr>
    </thead>
  );
};

type AssetNameProps = {
  assetName: string;
};
/**
 * If a part of the asset name is in (parentheses), we grey
 * out that part https://discord.com/channels/402910780124561410/796452739030319135/1154428517614899352
 * @param param0
 */
const AssetName = ({ assetName }: AssetNameProps) => {
  const [first, second] = assetName.split('(');
  return (
    <div>
      <span className="body--emphasized text-color--1 L3">{first}</span>
      {second !== undefined ? (
        <span className="body--emphasized text-color--2 L3">
          {'('}
          {second}
        </span>
      ) : null}
    </div>
  );
};

export const MarketOverviewPanelsLoading = () => {
  const numPanels = 4;
  const numPanelRows = 1;

  const panelHeader = (
    <div className="market-overview-panels__header-with-logo">
      <span
        className="placeholder-content placeholder-content--circle"
        style={{ width: '1rem', height: '1rem' }}
      ></span>
      <span className="placeholder-content" style={{ width: '8rem', height: '1rem' }}></span>
    </div>
  );

  const panelRow = (
    <>
      <td>
        <div className="market-overview-panels__market-container">
          <svg
            width="72"
            height="40"
            viewBox="0 0 72 40"
            fill="none"
            className="market-overview-panels__icon-pair-loading"
          >
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M37.1885 30.2313C38.9741 27.2379 40 23.7387 40 20C40 16.2613 38.9741 12.7621 37.1885 9.76875C40.4371 5.07481 45.8594 2 52 2C61.9411 2 70 10.0589 70 20C70 29.9411 61.9411 38 52 38C45.8594 38 40.4371 34.9252 37.1885 30.2313Z"
            />
            <circle cx="20" cy="20" r="19" strokeWidth="2" />
          </svg>
          <div className="market-overview-panels__asset-description-container">
            <div className="placeholder-content" style={{ width: '4rem', height: '1.5rem' }}></div>
            <div className="placeholder-content" style={{ width: '8rem', height: '1rem' }}></div>
          </div>
        </div>
      </td>
      <td>
        <div className="market-overview-panels__utilization-container">
          <div className="placeholder-content" style={{ width: '7rem', height: '1.25rem' }}></div>
        </div>
      </td>
      <td>
        <div className="placeholder-content" style={{ width: '6rem', height: '1.25rem' }}></div>
      </td>
      <td>
        <div className="placeholder-content" style={{ width: '6rem', height: '1.25rem' }}></div>
      </td>
      <td>
        <div className="placeholder-content" style={{ width: '6rem', height: '1.25rem' }}></div>
      </td>
      <td>
        <div className="placeholder-content" style={{ width: '6rem', height: '1.25rem' }}></div>
      </td>
      <td>
        <div className="placeholder-content" style={{ width: '6rem', height: '1.25rem' }}></div>
      </td>
      <td>
        <div className="placeholder-content" style={{ width: '6rem', height: '1.25rem' }}></div>
      </td>
    </>
  );

  return (
    <>
      <div className="market-overview-panels__dropdowns">
        <h1 className="placeholder-content" style={{ width: '8rem', height: '2rem' }}></h1>
        <h1 className="placeholder-content" style={{ width: '8rem', height: '2rem' }}></h1>
      </div>

      {Array.from(Array(numPanels).keys()).map((i) => (
        <div className="market-overview-panels__tables-container" key={i}>
          <PanelWithHeader header={panelHeader} className="assets-table-panel grid-column--12">
            <div className="panel panel--markets-assets L3">
              <div className="panel--markets-assets__content">
                <table className="assets-table">
                  <TableHead />
                  <tbody>
                    {Array.from(Array(numPanelRows).keys()).map((j) => {
                      return (
                        <tr
                          key={j}
                          className="market-overview-panels__table-row market-overview-panels__table-row--loading"
                        >
                          {panelRow}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </PanelWithHeader>
        </div>
      ))}
    </>
  );
};

export default MarketOverviewPanels;

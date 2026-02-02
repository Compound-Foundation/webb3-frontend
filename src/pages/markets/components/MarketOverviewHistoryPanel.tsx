import { parse, format } from 'date-fns';
import { useEffect, useRef, useState } from 'react';

import { PRICE_PRECISION, formatValueInDollars } from '@helpers/numbers';
import { HistoricalMarketSummaries } from '@types';

type MarketOverviewHistoryPanelProps = {
  historicalMarketSummaries: HistoricalMarketSummaries;
};

const MarketOverviewHistoryPanel = ({ historicalMarketSummaries }: MarketOverviewHistoryPanelProps) => {
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(undefined);

  // This should never happen, but if it ever does,
  // we don't want to have a runtime crash
  if (historicalMarketSummaries.length === 0) {
    return null;
  }

  const {
    totalBorrowValue,
    totalCollateralValue,
    totalSupplyValue: totalEarnValue,
  } = historicalMarketSummaries[selectedIndex ?? historicalMarketSummaries.length - 1];

  const totalSupply = totalEarnValue + totalCollateralValue;

  return (
    <div className="market-overview-history-panel hero-panel">
      <div className="market-overview-history-panel__overview L1">
        <div>
          <label className="label text-color--2">Total Supply</label>
          <h1 className="heading heading--emphasized L0">{formatValueInDollars(PRICE_PRECISION, totalSupply)}</h1>
        </div>

        <div className="market-overview-history-panel__overview__breakdown L2">
          <div>
            <label className="label text-color--supply">
              <div className="market-overview-history-panel__dot" />
              Earning
            </label>
            <h2 className="heading heading--emphasized">{formatValueInDollars(PRICE_PRECISION, totalEarnValue)}</h2>
          </div>
          <div>
            <label className="label text-color--borrow">
              <div className="market-overview-history-panel__dot" />
              Borrowing
            </label>
            <h2 className="heading heading--emphasized">{formatValueInDollars(PRICE_PRECISION, totalBorrowValue)}</h2>
          </div>
          <div>
            <label className="label text-color--2">
              <div className="market-overview-history-panel__dot" />
              Collateral
            </label>
            <h2 className="heading heading--emphasized">
              {formatValueInDollars(PRICE_PRECISION, totalCollateralValue)}
            </h2>
          </div>
        </div>
      </div>

      <Graph
        historicalMarketSummaries={historicalMarketSummaries}
        selectedIndex={selectedIndex}
        setSelectedIndex={setSelectedIndex}
      />
    </div>
  );
};

type GraphProps = {
  historicalMarketSummaries: HistoricalMarketSummaries;
  selectedIndex?: number;
  setSelectedIndex: (index?: number) => void;
};
const Graph = ({ historicalMarketSummaries, selectedIndex, setSelectedIndex }: GraphProps) => {
  // The biggest collateral is used as 100% height
  const max = historicalMarketSummaries.reduce((max, { totalCollateralValue }) => {
    return max > totalCollateralValue ? max : totalCollateralValue;
  }, 0n);

  const shouldShowDate = (index: number) => {
    const isLastIndex = index === historicalMarketSummaries.length - 1;
    const isKeyIndex = index % 5 === 0;
    const isLastOrKeyIndex = isLastIndex || isKeyIndex;

    if (selectedIndex === undefined) {
      return isLastOrKeyIndex;
    }

    const isNotNextToSelectedIndex = index !== selectedIndex - 1 && index !== selectedIndex + 1;
    const isSelectedIndex = index === selectedIndex;

    return (isLastOrKeyIndex && isNotNextToSelectedIndex) || isSelectedIndex;
  };

  const bars = historicalMarketSummaries.map(
    ({ totalCollateralValue, totalBorrowValue, totalSupplyValue, date }, index) => ({
      totalCollateralPercentage: Number((totalCollateralValue * 100n) / max),
      totalBorrowPercentage: Number((totalBorrowValue * 100n) / max),
      totalEarningPercentage: Number((totalSupplyValue * 100n) / max),
      date,
      showDate: shouldShowDate(index),
    })
  );

  const graphRef = useRef<HTMLDivElement>(null);

  // On mobile, scroll graph to the right on load
  useEffect(() => {
    graphRef.current?.scrollTo({ left: graphRef.current.scrollWidth });
  }, []);

  return (
    <div
      className="market-overview-history-panel__graph"
      // Snap to the latest bar on mouse leave
      onMouseLeave={() => setSelectedIndex(undefined)}
      ref={graphRef}
    >
      {bars.map((bar, index) => (
        <Bar
          key={bar.date}
          {...bar}
          selected={selectedIndex === index}
          setSelected={() => {
            setSelectedIndex(index);
          }}
          resetSelected={() => {
            setSelectedIndex(undefined);
          }}
        />
      ))}
    </div>
  );
};

type BarProps = {
  totalEarningPercentage: number;
  totalBorrowPercentage: number;
  totalCollateralPercentage: number;
  date: string;
  showDate: boolean;
  selected: boolean;
  setSelected: () => void;
  resetSelected: () => void;
};
const Bar = ({
  totalEarningPercentage,
  totalBorrowPercentage,
  totalCollateralPercentage,
  date,
  showDate,
  selected,
  setSelected,
  resetSelected,
}: BarProps) => {
  const formattedDate = format(parse(date, 'yyyy-MM-dd', new Date()), 'MMM d');

  const selectedBarStyle = selected ? 'market-overview-history-panel__parent-bar--selected' : '';
  const selectedDateStyle = selected ? 'text-color--1' : 'text-color-2';

  return (
    <div
      className={`market-overview-history-panel__parent-bar ${selectedBarStyle}`}
      style={{ height: `${totalCollateralPercentage}%` }}
      onPointerEnter={setSelected}
      onTouchStart={setSelected}
      onTouchEnd={resetSelected}
    >
      <div
        className="market-overview-history-panel__child-bar market-overview-history-panel__child-bar--earn"
        style={{ height: `${totalEarningPercentage}%` }}
      />
      <div
        className="market-overview-history-panel__child-bar market-overview-history-panel__child-bar--borrow"
        style={{ height: `${totalBorrowPercentage}%` }}
      />
      {showDate ? (
        <label className={`label L2 market-overview-history-panel__graph-date ${selectedDateStyle}`}>
          {formattedDate}
        </label>
      ) : null}
    </div>
  );
};

export const MarketOverviewHistoryPanelLoading = () => {
  const daysInAMonth = 30;
  const numDateLabels = 7;

  const graphRef = useRef<HTMLDivElement>(null);

  // On mobile, scroll graph to the right on load
  useEffect(() => {
    graphRef.current?.scrollTo({ left: graphRef.current.scrollWidth });
  }, []);

  return (
    <div className="hero-panel">
      <div className="market-overview-history-panel__overview L1">
        <h1 className="placeholder-content" style={{ width: '7rem', height: '4.5rem' }}></h1>

        <div className="market-overview-history-panel__overview__breakdown L2">
          <div className="placeholder-content" style={{ height: '3rem' }}></div>
          <div className="placeholder-content" style={{ height: '3rem' }}></div>
          <div className="placeholder-content" style={{ height: '3rem' }}></div>
        </div>
      </div>

      <div className="market-overview-history-panel__graph" ref={graphRef}>
        {Array.from(Array(daysInAMonth).keys()).map((i) => (
          <div key={i} className="placeholder-content" style={{ height: '100%' }}></div>
        ))}
      </div>
      <div className="mobile-hide">
        <div className="market-overview-history-panel__loading-date-labels">
          {Array.from(Array(numDateLabels).keys()).map((i) => (
            <div key={i} className="placeholder-content" style={{ width: '3rem', height: '1rem' }}></div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default MarketOverviewHistoryPanel;

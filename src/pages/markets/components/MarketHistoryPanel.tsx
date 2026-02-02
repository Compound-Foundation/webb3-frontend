import { useState } from 'react';

import IconTextPair, { IconTextPairSize } from '@components/IconTextPair';
import { isNonStablecoinMarket } from '@helpers/baseAssetPrice';
import { formatRate, formatUnits, PRICE_PRECISION } from '@helpers/numbers';
import { BaseAssetConfig, BaseAssetWithState, Currency, MarketHistoricalBucket } from '@types';

const FULL_GRAPH_WIDTH = 600;
const FULL_GRAPH_HEIGHT = 150;
const LINE_GRAPH_HEIGHT = 30;
const BAR_GRAPH_HEIGHT = 70;
const BAR_PADDING = 4;

//Calculate the scaled height give the max data point and graph y-range.

// Domain = [minDataValue, maxDataValue]
// Range = [graphHeight, 0]

// y = mx + b
// m = (y2 - y1) / (x2 - x1) = (0 - graphHeight / maxDataValue - minDataValue)
// m = -graphHeight / (maxDataValue - minDataValue)

// 0 = -[graphHeight / (maxDataValue - minDataValue)](maxDataValue) + b
// b = graphHeight * maxDataValue / (maxDataValue - minDataValue)

// y = -[graphHeight/(maxDataValue - minDataValue)](x) + (graphHeight * maxDataValue) / (maxTotalValue - minTotalValue)
function calculateScaledHeight(
  graphHeight: number,
  maxTotalValue: number,
  minTotalValue: number,
  totalValue: number
): number {
  const minDomain = minTotalValue * 0.9;
  let scaledHeight;
  if (maxTotalValue > 0) {
    scaledHeight =
      (-graphHeight / (maxTotalValue - minDomain)) * totalValue +
      (graphHeight * maxTotalValue) / (maxTotalValue - minDomain);
  } else {
    scaledHeight = graphHeight;
  }
  return scaledHeight;
}

// Calculate the xpoint for a given data value index.
// This assumes the data has been sorted and barWidth is dynamically
// calculated depending on bow many data buckets we actually have.
function calculateXPoint(dataIndex: number, barWidth: number, barPadding: number) {
  const xPoint = dataIndex * barWidth + dataIndex * barPadding + barWidth / 2;
  return xPoint;
}

type BarGroupProps = {
  isBorrow: boolean;
  isActive: boolean;
  barValue: number;
  barTimestamp: number;
  barWidth: number;
  barMaxDataValue: number;
  barMinDataValue: number;
};

// Bar groups handle both the inactive bar state as well as showing the hovered active state as well
// as the timestamp value below the bar. We don't show the bar hovered label on a bar group due to the draw
// order of each bar and we want to ensure the bar labels are drawn last.
const BarGroup = ({
  isBorrow,
  isActive,
  barValue,
  barTimestamp,
  barWidth,
  barMaxDataValue,
  barMinDataValue,
}: BarGroupProps) => {
  let scaledHeight = calculateScaledHeight(BAR_GRAPH_HEIGHT, barMaxDataValue, barMinDataValue, barValue);
  if (scaledHeight == BAR_GRAPH_HEIGHT) {
    scaledHeight = scaledHeight - 1; // For the zero case show a teeny bar
  }

  const barModifierClass = isBorrow ? ' bar-group--borrow' : ' bar-group--earn';
  const barActiveClass = isActive ? ' bar-group--active' : '';

  const date = new Date(barTimestamp);
  const formattedDate = date.toLocaleString('en-us', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <g className={`bar-group${barModifierClass}${barActiveClass}`}>
      <rect
        x={0}
        y={scaledHeight + (FULL_GRAPH_HEIGHT - BAR_GRAPH_HEIGHT)}
        width={barWidth}
        height={FULL_GRAPH_HEIGHT - (FULL_GRAPH_HEIGHT - BAR_GRAPH_HEIGHT) - scaledHeight}
      />
      <text className="bar-group__label" x={barWidth / 2} y={FULL_GRAPH_HEIGHT + 20}>
        {formattedDate}
      </text>
    </g>
  );
};

type HoverableBarGroupProps = {
  barWidth: number;
  barTimestamp: number;
  onBarMouseEnter: (timestamp: number) => void;
  onBarMouseLeave: () => void;
};

// The hoverable bar is a transparent bar that is overlaid on the top of all the drawn elements
// and takes up the full bar space (no padding). The hoverable bars are solely responsible for
// triggering mouse enter/exit events and this strategy ensures the full height of a bar is
// hoverable and we don't have flickering.
const HoverableBarGroup = ({ barWidth, barTimestamp, onBarMouseEnter, onBarMouseLeave }: HoverableBarGroupProps) => {
  const width = barWidth + BAR_PADDING;
  return (
    <g
      className={`hover-bar-group`}
      onMouseEnter={() => onBarMouseEnter(barTimestamp)}
      onMouseLeave={() => onBarMouseLeave()}
    >
      <rect x={0} y={0} width={width} height={FULL_GRAPH_HEIGHT} />
    </g>
  );
};

type MarketHistoryProps = {
  isBorrow: boolean;
  totalValue: string;
  marketHistory: MarketHistoricalBucket[];
  currency: Currency;
  baseAsset: BaseAssetWithState | BaseAssetConfig;
};

type BarBucketPoints = {
  timestamp: number;
  value: number;
};

type LineBucketPoints = {
  timestamp: number;
  rate: number;
};

type HistoryMapItem = {
  rate: number;
  total: number;
  index: number;
};

const MarketHistoryPanel = ({ isBorrow, totalValue, marketHistory, currency, baseAsset }: MarketHistoryProps) => {
  const [hoveredTime, setHoveredTime] = useState(0);
  let barBucketPoints: BarBucketPoints[];
  if (marketHistory.length > 0) {
    barBucketPoints = marketHistory.map(({ blockTimestamp, supplyTotal, borrowTotal }) => {
      const valueToShow = isBorrow ? borrowTotal : supplyTotal;
      return {
        timestamp: blockTimestamp,
        value: getAdjustedValue(baseAsset as BaseAssetWithState, valueToShow),
      };
    });
  } else {
    barBucketPoints = [];
  }

  const maxBarDataValue = Math.max(...barBucketPoints.map((y) => y.value));
  const minBarDataValue = Math.min(...barBucketPoints.map((y) => y.value));
  const barPaddingTotalWidth = BAR_PADDING * barBucketPoints.length;
  const barWidth = (FULL_GRAPH_WIDTH - barPaddingTotalWidth) / barBucketPoints.length;

  const barGroups = barBucketPoints.map(({ timestamp, value }, i) => {
    const padding = i == 0 ? 0 : i * BAR_PADDING;
    const isActive = hoveredTime === timestamp;

    return (
      <g transform={`translate(${i * barWidth + padding}, 0)`} key={timestamp}>
        <BarGroup
          isBorrow={isBorrow}
          isActive={isActive}
          barValue={value}
          barTimestamp={timestamp}
          barWidth={barWidth}
          barMaxDataValue={maxBarDataValue}
          barMinDataValue={minBarDataValue}
        />
      </g>
    );
  });

  function mouseEnterBar(timestamp: number) {
    setHoveredTime(timestamp);
  }

  function mouseLeaveBar() {
    setHoveredTime(0);
  }

  const hoverBarGroups = barBucketPoints.map(({ timestamp }, i) => {
    return (
      <g transform={`translate(${i * (barWidth + BAR_PADDING)}, 0)`} key={timestamp}>
        <HoverableBarGroup
          barWidth={barWidth}
          barTimestamp={timestamp}
          onBarMouseEnter={mouseEnterBar}
          onBarMouseLeave={mouseLeaveBar}
        />
      </g>
    );
  });

  let lineBucketPoints: LineBucketPoints[];
  let historyMap: Map<number, HistoryMapItem>; // Calculate a map to allow us to quickly lookup data by timestamp
  if (marketHistory.length > 0) {
    lineBucketPoints = marketHistory.map(({ blockTimestamp, supplyRate, borrowRate }) => {
      return { timestamp: blockTimestamp, rate: isBorrow ? borrowRate : supplyRate };
    });

    historyMap = new Map(
      marketHistory.map(({ blockTimestamp, supplyTotal, borrowTotal, supplyRate, borrowRate }, index) => {
        const valueToShow: number = isBorrow ? borrowTotal : supplyTotal;
        return [
          blockTimestamp,
          {
            rate: isBorrow ? borrowRate : supplyRate,
            total: getAdjustedValue(baseAsset as BaseAssetWithState, valueToShow),
            index: index,
          },
        ];
      })
    );
  } else {
    lineBucketPoints = [];
    historyMap = new Map();
  }

  const maxRate = Math.max(...lineBucketPoints.map((y) => y.rate));
  const minRate = Math.min(...lineBucketPoints.map((y) => y.rate));
  const pathPoints = lineBucketPoints.map((ratePoint, i) => {
    const padding = i == 0 ? 0 : i * BAR_PADDING;

    const xPoint: number = i * barWidth + padding + barWidth / 2;

    const yPoint = calculateScaledHeight(LINE_GRAPH_HEIGHT, maxRate, minRate, ratePoint.rate);

    let pointString;
    if (i == 0) {
      pointString = `M${xPoint},${yPoint}`;
    } else {
      pointString = `S${xPoint - barWidth / 2},${yPoint} ${xPoint},${yPoint}`;
    }

    return pointString;
  });

  const panelModifier = isBorrow ? ' market-history-panel__overview--borrow' : ' market-history-panel__overview--earn';
  const panelTitle = isBorrow ? 'Total Borrowing' : 'Total Collateral';

  const lineGraphStroke = isBorrow ? 'rgba(58.82%,41.18%,92.94%,1)' : 'rgba(0%,82.75%,58.43%,1)';

  const hoveredLabels = getHoveredLabels(
    hoveredTime,
    isBorrow,
    historyMap,
    maxRate,
    minRate,
    barWidth,
    maxBarDataValue,
    minBarDataValue,
    currency
  );

  return (
    <div className="market-history-panel">
      <div className={`market-history-panel__overview${panelModifier}`}>
        <label className="market-history-panel__overview__label">{panelTitle}</label>
        <div className="market-history-panel__overview__value">
          <IconTextPair
            value={totalValue}
            currency={currency}
            assetSymbol={baseAsset.symbol}
            size={IconTextPairSize.Large}
          />
        </div>
      </div>
      {barGroups.length > 0 && (
        <svg viewBox={`0 0 ${FULL_GRAPH_WIDTH} ${FULL_GRAPH_HEIGHT}`}>
          <g className="market-history-panel__line-graph">
            <path d={pathPoints.join(' ')} stroke={lineGraphStroke} strokeWidth="4px" fill="none" />
          </g>
          <g className="market-history-panel__graph">{barGroups}</g>
          <g>{hoveredLabels}</g>
          <g className="market-history-panel__hover-bars">{hoverBarGroups}</g>
        </svg>
      )}
    </div>
  );
};

function getHoveredLabels(
  hoveredTime: number,
  isBorrow: boolean,
  historyMap: Map<number, HistoryMapItem>,
  maxRate: number,
  minRate: number,
  barWidth: number,
  maxBarDataValue: number,
  minBarDataValue: number,
  currency: Currency
) {
  const hoveredData = historyMap.get(hoveredTime);
  if (hoveredTime == 0 || hoveredData === undefined) {
    return <></>;
  } else {
    const rateLabel = isBorrow ? 'Borrow APR' : 'Earn APR';
    const rateHoverImage = isBorrow
      ? '/images/line-graph-hover-icn-borrow.svg'
      : '/images/line-graph-hover-icn-supply.svg';
    const { rate, total, index } = hoveredData;

    const xPoint = calculateXPoint(index, barWidth, BAR_PADDING);

    const yLinePoint = calculateScaledHeight(LINE_GRAPH_HEIGHT, maxRate, minRate, rate);
    const formattedTotal = formatUnits(total, currency);
    const barScaledHeight = calculateScaledHeight(BAR_GRAPH_HEIGHT, maxBarDataValue, minBarDataValue, total);

    return (
      <>
        <text className="market-history-panel__hover__value" x={xPoint} y={yLinePoint - 35}>
          {formatRate(rate)}
        </text>
        <text className="market-history-panel__hover__label" x={xPoint} y={yLinePoint - 15}>
          {rateLabel}
        </text>
        <line
          x1={xPoint}
          y1={yLinePoint + 12}
          x2={xPoint}
          y2={barScaledHeight + (FULL_GRAPH_HEIGHT - BAR_GRAPH_HEIGHT) - 40}
          stroke="#6d7e8f"
          strokeDasharray="3 3"
        />
        <image href={rateHoverImage} x={xPoint - 37 / 2} y={yLinePoint - 37 / 2} height="37px" width="37px" />
        <text
          className="market-history-panel__hover__value"
          x={xPoint}
          y={barScaledHeight + (FULL_GRAPH_HEIGHT - BAR_GRAPH_HEIGHT) - 20}
        >
          {formattedTotal}
        </text>
      </>
    );
  }
}

/* The market history values are in terms of the base asset so we need to convert them
   to the correct currency value when rendering. (now only USD)
 */
function getAdjustedValue(baseAsset: BaseAssetWithState, value: number) {
  if (isNonStablecoinMarket(baseAsset.symbol)) {
    const tokenScale = 10 ** baseAsset.decimals;
    const valueWei = value * tokenScale;
    const valueInUsd =
      (valueWei * (Number(baseAsset.baseAssetPriceInDollars) / Number(10 ** PRICE_PRECISION))) / tokenScale;
    return valueInUsd;
  } else {
    return value;
  }
}

export default MarketHistoryPanel;

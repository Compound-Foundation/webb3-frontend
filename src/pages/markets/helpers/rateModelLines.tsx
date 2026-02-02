export type PolyLinePoints = [bigint, number, number, number][];
export type LineGraphAreaConfig = {
  height: number;
  width: number;
  graphMinX: number; //TODO: Rename to signafy this the line part
  graphMaxX: number;
  graphMinY: number;
  graphMaxY: number;
  isV2Graph: boolean;
};

type GenLinePointsArgs = {
  rates: [bigint, number][];
  maxRate: number; // Since client needs to calculate allDataMax, pass in max for this rates[] also.
  allDataMaxRate: number; //This is max rate of both supply AND borrow.
  graphConfig: LineGraphAreaConfig;
};

export const generateLinePoints = ({
  rates,
  maxRate,
  allDataMaxRate,
  graphConfig,
}: GenLinePointsArgs): PolyLinePoints => {
  const { graphMinX, graphMaxX, graphMinY, graphMaxY } = graphConfig;

  return rates.map((borrowRate, idx) => {
    const incrementWidth = (graphMaxX - graphMinX) / (rates.length - 1); // potential division by zero
    const [utilization, rate] = borrowRate;
    return [
      utilization,
      rate,
      graphMinX + idx * incrementWidth,
      maxRate == 0 ? graphMaxY : graphMaxY - (rate / allDataMaxRate) * (graphMaxY - graphMinY),
    ];
  });
};

type LoadingLinePoints = {
  utilizationPoints?: PolyLinePoints;
  borrowPoints: PolyLinePoints;
  supplyPoints: PolyLinePoints;
};

export const generateLoadingLinePoints = (graphConfig: LineGraphAreaConfig): LoadingLinePoints => {
  const { graphMinX, graphMaxX, isV2Graph: showSvgLeftLabels } = graphConfig;

  const visualKink = 0.8;

  const lineWidths = graphMaxX - graphMinX;

  const kinkX = Math.round(lineWidths * visualKink + graphMinX);
  const diffKinkAndMax = graphMaxX - kinkX;

  const supplyLineMinY = 150;
  const supplyLineMaxY = supplyLineMinY - diffKinkAndMax + 20;

  const borrowLineMinY = 111;
  const borrowLineMaxY = borrowLineMinY - diffKinkAndMax + 20;

  const utilizationLineY = graphMinX + 24;

  return {
    utilizationPoints: showSvgLeftLabels
      ? [
          [0n, 0, graphMinX, utilizationLineY],
          [0n, 0, graphMaxX, utilizationLineY],
        ]
      : undefined,
    borrowPoints: [
      [0n, 0, graphMinX, borrowLineMinY],
      [0n, 0, kinkX, borrowLineMinY],
      [0n, 0, graphMaxX, borrowLineMaxY],
    ],
    supplyPoints: [
      [0n, 0, graphMinX, supplyLineMinY],
      [0n, 0, kinkX, supplyLineMinY],
      [0n, 0, graphMaxX, supplyLineMaxY],
    ],
  };
};

/**
 * Used to show the 5 background horizontal lines in the v3 rate model graph
 */
export const getHorizontalLineMarkers = ({ graphMinX, graphMaxX, graphMinY, graphMaxY }: LineGraphAreaConfig) => {
  const quarterY = Math.floor((graphMaxY - graphMinY) * 0.25 + graphMinY);
  const halfY = Math.floor((graphMaxY - graphMinY) * 0.5 + graphMinY);
  const threeQuartersY = Math.floor((graphMaxY - graphMinY) * 0.75 + graphMinY);

  return (
    <>
      <polyline
        className="interest-rate-model__chart__bg-horizontal-line"
        points={formatPoints([
          [0n, 0, graphMinX, graphMinY],
          [0n, 0, graphMaxX, graphMinY],
        ])}
      />
      <polyline
        className="interest-rate-model__chart__bg-horizontal-line"
        points={formatPoints([
          [0n, 0, graphMinX, quarterY],
          [0n, 0, graphMaxX, quarterY],
        ])}
      />
      <polyline
        className="interest-rate-model__chart__bg-horizontal-line"
        points={formatPoints([
          [0n, 0, graphMinX, halfY],
          [0n, 0, graphMaxX, halfY],
        ])}
      />
      <polyline
        className="interest-rate-model__chart__bg-horizontal-line"
        points={formatPoints([
          [0n, 0, graphMinX, threeQuartersY],
          [0n, 0, graphMaxX, threeQuartersY],
        ])}
      />
      <polyline
        className="interest-rate-model__chart__bg-horizontal-line"
        points={formatPoints([
          [0n, 0, graphMinX, graphMaxY],
          [0n, 0, graphMaxX, graphMaxY],
        ])}
      />
    </>
  );
};

/**
 * Used to show the 5 background horizontal lines in the v3 rate model graph
 */
export const getVerticalLineMarker = ({ graphMinY, graphMaxY }: LineGraphAreaConfig, xHoverPoint: number) => {
  return (
    <>
      <polyline
        className="interest-rate-model__chart__vertical-line-marker"
        points={formatPoints([
          [0n, 0, xHoverPoint, graphMinY],
          [0n, 0, xHoverPoint, graphMaxY],
        ])}
      />
    </>
  );
};

export enum ActiveLineType {
  BorrowLine = 'BorrowLine',
  SupplyLine = 'SupplyLine',
}

type ActiveLineProps = {
  points: PolyLinePoints;
  pointsLeftOfUtil: PolyLinePoints;
  circleHoverPointX: number;
  circleHoverPointY: number;
  lineType: ActiveLineType;
  isV3Line: boolean;
};

export const getActiveLineAndCircle = ({
  points,
  pointsLeftOfUtil,
  circleHoverPointX,
  circleHoverPointY,
  lineType,
  isV3Line,
}: ActiveLineProps) => {
  const getColorClasses = (lineType: ActiveLineType) => {
    if (lineType === ActiveLineType.BorrowLine) {
      return {
        v2BgLineClass: 'interest-rate-model__chart__line--borrow-light',
        activeLineClass: 'interest-rate-model__chart__line--borrow',
        circleClass: 'interest-rate-model__chart__circle--borrow',
      };
    } else {
      return {
        v2BgLineClass: 'interest-rate-model__chart__line--supply-light',
        activeLineClass: 'interest-rate-model__chart__line--supply',
        circleClass: 'interest-rate-model__chart__circle--supply',
      };
    }
  };

  const { v2BgLineClass, activeLineClass, circleClass } = getColorClasses(lineType);
  const bgLineColorClass = isV3Line ? 'interest-rate-model__chart__line--v3-background' : v2BgLineClass;

  return (
    <>
      {/* borrow bg line */}
      <polyline className={`interest-rate-model__chart__line ${bgLineColorClass}`} points={formatPoints(points)} />
      {/* borrow fg line, with circle */}
      <polyline
        className={`interest-rate-model__chart__line ${activeLineClass}`}
        points={formatPoints(pointsLeftOfUtil)}
      />
      <circle
        className={`interest-rate-model__chart__circle ${circleClass}${
          isV3Line ? ' interest-rate-model__chart__circle--v3' : ''
        }`}
        cx={circleHoverPointX}
        cy={circleHoverPointY}
        r="5"
      ></circle>
    </>
  );
};

export const getBottomLabels = (
  { graphMinX, graphMaxX, height, width }: LineGraphAreaConfig,
  circleHoverPointX: number,
  utilization: number
) => {
  const utilString = formatPercentage(utilization); // a Percentage string with decimals requires longer text background...
  const activeHoverLabelBgWidth = utilString.length > 4 ? 124 : 104; // Background width to hover label

  // We don't want the bottom util hover label scrolling off either the right or left side of the chart
  // are, so we need to make an adjustmnet if it does go off either end.
  const adjustedHoverLabelPointCenterX =
    circleHoverPointX - activeHoverLabelBgWidth / 2 < 6
      ? activeHoverLabelBgWidth / 2 + 6
      : circleHoverPointX + activeHoverLabelBgWidth / 2 > width
      ? circleHoverPointX - (circleHoverPointX + activeHoverLabelBgWidth / 2 - width)
      : circleHoverPointX;

  return (
    <>
      <text
        className="interest-rate-model__chart__bottom-label interest-rate-model__chart__bottom-label--left"
        x={graphMinX}
        y={height}
      >
        0%
      </text>
      <text
        className="interest-rate-model__chart__bottom-label interest-rate-model__chart__bottom-label--right"
        x={graphMaxX}
        y={height}
      >
        100%
      </text>

      {/* The total utilization text plus percent width is ~100px */}
      <rect
        x={circleHoverPointX - activeHoverLabelBgWidth / 2 - 6}
        y={height - 12}
        width={activeHoverLabelBgWidth}
        height="12"
        fill="var(--ui--foreground--1)"
      />
      <text
        className="interest-rate-model__chart__bottom-label interest-rate-model__chart__bottom-label--left"
        x={adjustedHoverLabelPointCenterX - activeHoverLabelBgWidth / 2}
        y={height}
      >
        Utilization
        <tspan className="interest-rate-model__chart__bottom-label__active" dx={6}>
          {formatPercentage(utilization)}
        </tspan>
      </text>
    </>
  );
};

export const formatPercentage = (num: number) => {
  return `${(Math.round(num * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
};

export const formatPoints = (points: PolyLinePoints) => {
  return points.map(([, , x, y]) => `${x},${y}`).join(' ');
};

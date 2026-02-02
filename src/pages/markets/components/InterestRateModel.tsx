import { MouseEventHandler, MouseEvent, useState, useEffect } from 'react';

import { formatRateFactor } from '@helpers/numbers';
import { StateType } from '@types';

import {
  ActiveLineType,
  formatPercentage,
  generateLinePoints,
  generateLoadingLinePoints,
  getActiveLineAndCircle,
  getBottomLabels,
  getHorizontalLineMarkers,
  getVerticalLineMarker,
  LineGraphAreaConfig,
} from '../helpers/rateModelLines';

import { RateModelLoadingView } from './InterestRateModelLoading';

type InterestRateModelLoading = [StateType.Loading, { graphConfig: LineGraphAreaConfig }];

type InterestRateModelHydrated = [
  StateType.Hydrated,
  {
    borrowRates: [bigint, number][];
    supplyRates: [bigint, number][];
    borrowAPR: bigint | string;
    supplyAPR: bigint | string;
    utilization: bigint;
    graphConfig: LineGraphAreaConfig;
    onRateHover?: (hoveredRate: HoveredRate | undefined) => void;
  }
];

export type HoveredRate = {
  utilizationPercentage: number;
  borrowRate: number;
  supplyRate: number;
};

export type InterestRateModelState = InterestRateModelLoading | InterestRateModelHydrated;

type InterestRateModelProps = {
  state: InterestRateModelState;
};

const InterestRateModel = ({ state }: InterestRateModelProps) => {
  const defaultUtilizationPercentage = 0.9;
  const [utilizationPercentage, setUtilizationPercentage] = useState<number>(defaultUtilizationPercentage);
  const [isMouseOnChart, setIsMouseOnChart] = useState<boolean>(false);

  const graphConfig = state[1].graphConfig;

  const height = graphConfig.height;
  const width = graphConfig.width;

  const minX = graphConfig.graphMinX;
  const maxX = graphConfig.graphMaxX;

  const isLoading = state[0] === StateType.Loading;

  const factorScale = 1e18;
  const utilization = state[0] === StateType.Hydrated ? state[1].utilization : undefined;
  const utilizationDescale = factorScale / 1e2;

  function getUtilizationPercentage(utilizationFactor: bigint | undefined) {
    if (utilizationFactor === undefined) {
      return defaultUtilizationPercentage;
    } else {
      return Number(utilizationFactor) / factorScale;
    }
  }

  useEffect(() => {
    if (isLoading === false) {
      setUtilizationPercentage(getUtilizationPercentage(utilization));
    }
  }, [isLoading, utilization]);

  if (isLoading) {
    const { utilizationPoints, borrowPoints, supplyPoints } = generateLoadingLinePoints(graphConfig);

    return (
      <RateModelLoadingView
        utilizationPoints={utilizationPoints}
        borrowPoints={borrowPoints}
        supplyPoints={supplyPoints}
        graphConfig={graphConfig}
      />
    );
  } else {
    const actualUtilizationPercentage = getUtilizationPercentage(state[1].utilization);
    // loaded state
    const mouseMove: MouseEventHandler<SVGRectElement> = (e: MouseEvent<SVGRectElement>) => {
      const targetElement = e.target as HTMLElement;
      setUtilizationPercentage(e.nativeEvent.offsetX / targetElement.getBoundingClientRect().width);
      setIsMouseOnChart(true);
      if (state[1].onRateHover !== undefined) {
        const [borrowUtilization, hypotheticalBorrowAPR, ,] =
          currentUtilizationBorrowPoints[currentUtilizationBorrowPoints.length - 1];

        const currentUtilizationSupplyPoints = supplyPoints.filter((sp) => {
          return Number(sp[0]) / factorScale <= utilizationPercentage;
        });
        const [, hypotheticalSupplyAPR, ,] = currentUtilizationSupplyPoints[currentUtilizationSupplyPoints.length - 1];

        state[1].onRateHover({
          utilizationPercentage: Number(borrowUtilization) / utilizationDescale,
          borrowRate: hypotheticalBorrowAPR,
          supplyRate: hypotheticalSupplyAPR,
        });
      }
    };

    const mouseLeave = () => {
      setUtilizationPercentage(actualUtilizationPercentage);
      setIsMouseOnChart(false);
      if (state[1].onRateHover !== undefined) {
        state[1].onRateHover(undefined);
      }
    };

    const borrowRates = state[1].borrowRates || [];
    const supplyRates = state[1].supplyRates || [];

    const maxSupplyRate = Math.max(...supplyRates.map((sr) => sr[1]));
    const maxBorrowRate = Math.max(...borrowRates.map((br) => br[1]));
    const maxYScale = Math.max(maxSupplyRate, maxBorrowRate);

    // Borrow
    const borrowPoints = generateLinePoints({
      rates: borrowRates,
      maxRate: maxBorrowRate,
      allDataMaxRate: maxYScale,
      graphConfig: graphConfig,
    });

    const currentUtilizationBorrowPoints = borrowPoints.filter((bp) => {
      return Number(bp[0]) / factorScale <= utilizationPercentage;
    });
    const [borrowUtilization, hypotheticalBorrowAPR, borrowCircleX, borrowCircleY] =
      currentUtilizationBorrowPoints[currentUtilizationBorrowPoints.length - 1];
    let borrowAPR;

    if (isMouseOnChart) {
      borrowAPR = formatPercentage(hypotheticalBorrowAPR);
    } else {
      if (typeof state[1].borrowAPR === 'string') {
        borrowAPR = state[1].borrowAPR;
      } else {
        borrowAPR = formatRateFactor(state[1].borrowAPR);
      }
    }

    // Supply
    const supplyPoints = generateLinePoints({
      rates: supplyRates,
      maxRate: maxSupplyRate,
      allDataMaxRate: maxYScale,
      graphConfig: graphConfig,
    });

    //TODO: Should try binary search on this for better speed
    const currentUtilizationSupplyPoints = supplyPoints.filter((sp) => {
      return Number(sp[0]) / factorScale <= utilizationPercentage;
    });
    const [, hypotheticalSupplyAPR, supplyCircleX, supplyCircleY] =
      currentUtilizationSupplyPoints[currentUtilizationSupplyPoints.length - 1];
    let supplyAPR;
    if (isMouseOnChart) {
      supplyAPR = formatPercentage(hypotheticalSupplyAPR);
    } else {
      if (typeof state[1].supplyAPR === 'string') {
        supplyAPR = state[1].supplyAPR;
      } else {
        supplyAPR = formatRateFactor(state[1].supplyAPR);
      }
    }

    const utilizationY = minX + 24;
    const utilizationX = borrowCircleX; // make the utilization circle move in sync with borrow and supply rates

    // If the user isn't currently hovering on chart then show the util as a percentage.
    let utilizationToDisplay;
    if (!isMouseOnChart) {
      utilizationToDisplay = actualUtilizationPercentage * 100;
    } else {
      utilizationToDisplay = Number(borrowUtilization) / utilizationDescale;
    }
    return (
      <div className="interest-rate-model">
        {state[1].graphConfig.isV2Graph ? (
          <>
            <div className="interest-rate-model__keys">
              <label className="interest-rate-model__keys__item interest-rate-model__keys__item--utilization">
                Utilization
              </label>
              <label className="interest-rate-model__keys__item interest-rate-model__keys__item--borrow">
                Borrow APR
              </label>
              <label className="interest-rate-model__keys__item interest-rate-model__keys__item--supply">
                Earn APR
              </label>
            </div>

            <div className="interest-rate-model__keys interest-rate-model__keys--percentages">
              <label className="interest-rate-model__keys__item interest-rate-model__keys__item--utilization">
                {formatPercentage(utilizationToDisplay)}
              </label>
              <label className="interest-rate-model__keys__item interest-rate-model__keys__item--borrow">
                {borrowAPR}
              </label>
              <label className="interest-rate-model__keys__item interest-rate-model__keys__item--supply">
                {supplyAPR}
              </label>
            </div>
          </>
        ) : (
          <></>
        )}
        <div className="interest-rate-model__chart">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${width} ${height}`}>
            {state[1].graphConfig.isV2Graph ? (
              <>
                {/* utilization bg line */}
                <polyline
                  className="interest-rate-model__chart__line interest-rate-model__chart__line--utilization interest-rate-model__chart__line--utilization--lite"
                  points={`${minX},${utilizationY} ${maxX},${utilizationY}`}
                />
                {/* utilization fg line, with circle */}
                <circle
                  className="interest-rate-model__chart__circle"
                  cx={utilizationX}
                  cy={utilizationY}
                  r="5"
                ></circle>
                <polyline
                  className="interest-rate-model__chart__line"
                  points={`${minX},${utilizationY} ${utilizationX},${utilizationY}`}
                />
              </>
            ) : (
              <></>
            )}

            {/* Horizontal Lines and Vertical Line Marker for v3 only */}
            {!state[1].graphConfig.isV2Graph ? (
              <>
                {getHorizontalLineMarkers(graphConfig)}
                {getVerticalLineMarker(graphConfig, borrowCircleX)}
              </>
            ) : (
              <></>
            )}

            {getActiveLineAndCircle({
              points: borrowPoints,
              pointsLeftOfUtil: currentUtilizationBorrowPoints,
              circleHoverPointX: borrowCircleX,
              circleHoverPointY: borrowCircleY,
              lineType: ActiveLineType.BorrowLine,
              isV3Line: !state[1].graphConfig.isV2Graph,
            })}

            {getActiveLineAndCircle({
              points: supplyPoints,
              pointsLeftOfUtil: currentUtilizationSupplyPoints,
              circleHoverPointX: supplyCircleX,
              circleHoverPointY: supplyCircleY,
              lineType: ActiveLineType.SupplyLine,
              isV3Line: !state[1].graphConfig.isV2Graph,
            })}

            {!state[1].graphConfig.isV2Graph ? (
              <>{getBottomLabels(graphConfig, borrowCircleX, utilizationToDisplay)}</>
            ) : (
              <></>
            )}

            <rect
              x={minX - 1}
              y={0}
              width={maxX}
              height={height}
              fill="transparent"
              onMouseMove={mouseMove}
              onMouseLeave={mouseLeave}
            />
          </svg>
        </div>
      </div>
    );
  }
};

export default InterestRateModel;

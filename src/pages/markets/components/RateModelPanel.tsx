import { useState } from 'react';

import PanelWithHeader from '@components/PanelWithHeader';
import { formatRateFactor } from '@helpers/numbers';
import { StateType } from '@types';

import { formatPercentage } from '../helpers/rateModelLines';

import InterestRateModel, { HoveredRate } from './InterestRateModel';

type RateModelPanelLoading = [StateType.Loading];

type RateModelHydratedData = {
  borrowRates: [bigint, number][];
  supplyRates: [bigint, number][];
  borrowAPR: bigint;
  supplyAPR: bigint;
  utilization: bigint;
};

type RateModelPanelHydrated = [StateType.Hydrated, RateModelHydratedData];

export type RateModelPanelState = RateModelPanelLoading | RateModelPanelHydrated;

const RateModelPanel = ({ state }: { state: RateModelPanelState }) => {
  if (state[0] == StateType.Loading) {
    return <LoadingView />;
  } else {
    return <RateModelPanelView {...state[1]} />;
  }
};

const LoadingView = () => {
  const rateModelGraphLoading = (
    <InterestRateModel
      state={[
        StateType.Loading,
        {
          graphConfig: {
            height: 132,
            width: 400,
            graphMinX: 6,
            graphMaxX: 394,
            graphMinY: 6,
            graphMaxY: 104,
            isV2Graph: false,
          },
        },
      ]}
    />
  );
  return (
    <>
      <PanelWithHeader header="Interest Rate Model" className="grid-column--6">
        <div className="market-rate-model L2">
          <div className="market-rate-model__rates-section">
            <div className="market-rate-model__rates-section__labels-holder market-rate-model__rates-section__labels-holder--loading">
              <label className="label text-color--2">Borrow APR</label>
              <h4>
                <span className="placeholder-content" style={{ width: '4rem' }}></span>
              </h4>
            </div>
            <div className="market-rate-model__rates-section__labels-holder market-rate-model__rates-section__labels-holder--loading">
              <label className="label text-color--2">Earn APR</label>
              <h4>
                <span className="placeholder-content" style={{ width: '4rem' }}></span>
              </h4>
            </div>
          </div>
          <div className="market-rate-model__graph-section">{rateModelGraphLoading}</div>
        </div>
      </PanelWithHeader>
    </>
  );
};

const RateModelPanelView = ({ borrowRates, supplyRates, borrowAPR, supplyAPR, utilization }: RateModelHydratedData) => {
  const [hoveredRate, sethoveredRate] = useState<HoveredRate | undefined>(undefined);

  const rateModelGraph = (
    <InterestRateModel
      state={[
        StateType.Hydrated,
        {
          borrowRates,
          supplyRates,
          borrowAPR,
          supplyAPR,
          utilization,
          graphConfig: {
            height: 132,
            width: 400,
            graphMinX: 6,
            graphMaxX: 394,
            graphMinY: 6,
            graphMaxY: 104,
            isV2Graph: false,
          },
          onRateHover: (maybeHoveredRate) => {
            sethoveredRate(maybeHoveredRate);
          },
        },
      ]}
    />
  );

  const shownBorrowAPR = hoveredRate ? formatPercentage(hoveredRate.borrowRate) : formatRateFactor(borrowAPR);
  const shownSupplyAPR = hoveredRate ? formatPercentage(hoveredRate.supplyRate) : formatRateFactor(supplyAPR);

  return (
    <PanelWithHeader header="Interest Rate Model" className="grid-column--6">
      <div className="market-rate-model L2">
        <div className="market-rate-model__rates-section">
          <div className="market-rate-model__rates-section__labels-holder">
            <label className="label text-color--2">Borrow APR</label>
            <h4 className="text-color--1 heading heading--emphasized L4">{shownBorrowAPR}</h4>
          </div>
          <div className="market-rate-model__rates-section__labels-holder">
            <label className="label text-color--2">Earn APR</label>
            <h4 className="text-color--1 heading heading--emphasized L4">{shownSupplyAPR}</h4>
          </div>
        </div>
        <div className="market-rate-model__graph-section">{rateModelGraph}</div>
      </div>
    </PanelWithHeader>
  );
};

export default RateModelPanel;

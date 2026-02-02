import NetRatesGraph, { NetRatesGraphType } from '@components/NetRatesGraph';
import PanelWithHeader from '@components/PanelWithHeader';
import { formatRateFactor } from '@helpers/numbers';
import { Token, StateType } from '@types';

type MarketRatesPanelLoading = [StateType.Loading];

type MarketRatesPanelHydrated = [
  StateType.Hydrated,
  {
    borrowAPR: bigint;
    borrowRewardsAPR?: bigint;
    earnAPR: bigint;
    earnRewardsAPR?: bigint;
    rewardsAsset?: Token;
  }
];

export type MarketRatesPanelState = MarketRatesPanelLoading | MarketRatesPanelHydrated;

type PanelContent = {
  borrowAPR: bigint;
  borrowRewardsAPR?: bigint;
  earnAPR: bigint;
  earnRewardsAPR?: bigint;
  rewardsAsset?: Token;
};

const defaultPanelContent = {
  borrowAPR: 0n,
  borrowRewardsAPR: undefined,
  earnAPR: 0n,
  earnRewardsAPR: undefined,
  rewardsAsset: undefined,
};

function getMarketRatesPanelContent(state: MarketRatesPanelState): PanelContent {
  const panelState = state[0];
  if (panelState === StateType.Loading) {
    return defaultPanelContent;
  } else {
    return state[1];
  }
}

const MarketRatesPanel = ({ state }: { state: MarketRatesPanelState }) => {
  if (state[0] == StateType.Loading) {
    return <LoadingView />;
  } else {
    const panelContent = getMarketRatesPanelContent(state);
    return <MarketRatesPanelView {...panelContent} />;
  }
};

const LoadingView = () => {
  return (
    <>
      <PanelWithHeader header="Market Rates" className="grid-column--6">
        <div className="market-rates L2">
          <div className="market-rates__section grid-container grid-container--6">
            <div className="market-rates__section__labels-holder grid-column--2">
              <label className="label text-color--2">Net Borrow APR</label>
              <h4>
                <span className="placeholder-content" style={{ width: '4rem' }}></span>
              </h4>
            </div>
            <div className="grid-column--4">
              <h2>
                <span className="placeholder-content"></span>
              </h2>
            </div>
          </div>
          <div className="market-rates__section grid-container grid-container--6">
            <div className="market-rates__section__labels-holder grid-column--2">
              <label className="label text-color--2">Net Earn APR</label>
              <h4>
                <span className="placeholder-content" style={{ width: '4rem' }}></span>
              </h4>
            </div>
            <div className="grid-column--4">
              <h2>
                <span className="placeholder-content"></span>
              </h2>
            </div>
          </div>
        </div>
      </PanelWithHeader>
    </>
  );
};

const MarketRatesPanelView = ({ borrowAPR, borrowRewardsAPR, earnAPR, earnRewardsAPR, rewardsAsset }: PanelContent) => {
  const netBorrowAPR = borrowRewardsAPR ? borrowAPR - borrowRewardsAPR : borrowAPR;
  const netSupplyAPR = earnRewardsAPR ? earnRewardsAPR + earnAPR : earnAPR;

  const netBorrowRateGraph = (
    <NetRatesGraph
      state={NetRatesGraphType.Borrow}
      borrowAPR={borrowAPR}
      borrowRewardsAPR={borrowRewardsAPR}
      rewardsAsset={rewardsAsset}
    />
  );

  const netEarnRateGraph = (
    <NetRatesGraph
      state={NetRatesGraphType.Earn}
      earnAPR={earnAPR}
      earnRewardsAPR={earnRewardsAPR}
      rewardsAsset={rewardsAsset}
    />
  );

  return (
    <PanelWithHeader header="Market Rates" secondaryHeader="Net of Rewards" className="grid-column--6">
      <div className="market-rates L2">
        <div className="market-rates__section grid-container grid-container--6">
          <div className="market-rates__section__labels-holder grid-column--2">
            <label className="label text-color--2">Net Borrow APR</label>
            <h4 className="text-color--1 heading heading--emphasized L4">{formatRateFactor(netBorrowAPR)}</h4>
          </div>
          <div className="grid-column--4">{netBorrowRateGraph}</div>
        </div>
        <div className="market-rates__section grid-container grid-container--6">
          <div className="market-rates__section__labels-holder grid-column--2">
            <label className="label text-color--2">Net Earn APR</label>
            <h4 className="text-color--1 heading heading--emphasized L4">{formatRateFactor(netSupplyAPR)}</h4>
          </div>
          <div className="grid-column--4">{netEarnRateGraph}</div>
        </div>
      </div>
    </PanelWithHeader>
  );
};

export default MarketRatesPanel;

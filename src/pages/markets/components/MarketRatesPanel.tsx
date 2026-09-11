import BoostedSupplyRates from '@components/BoostedSupplyRates';
import NetRatesGraph, { NetRatesGraphType } from '@components/NetRatesGraph';
import PanelWithHeader from '@components/PanelWithHeader';
import { formatRateFactor } from '@helpers/numbers';
import { StateType } from '@types';

type MarketRatesPanelLoading = [StateType.Loading];

type MarketRatesPanelHydrated = [
  StateType.Hydrated,
  {
    chainId: number;
    marketAddress: string;
    borrowAPR: bigint;
    borrowRewardsAPR?: bigint;
    earnAPR: bigint;
    earnRewardsAPR?: bigint;
    rewardsAssetSymbol?: string;
    isInstitutional?: boolean;
  }
];

export type MarketRatesPanelState = MarketRatesPanelLoading | MarketRatesPanelHydrated;

type PanelContent = {
  borrowAPR: bigint;
  borrowRewardsAPR?: bigint;
  earnAPR: bigint;
  earnRewardsAPR?: bigint;
  rewardsAssetSymbol?: string;
  isInstitutional?: boolean;
};

const defaultPanelContent: PanelContent = {
  borrowAPR: 0n,
  borrowRewardsAPR: undefined,
  earnAPR: 0n,
  earnRewardsAPR: undefined,
  rewardsAssetSymbol: undefined,
  isInstitutional: false,
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

const MarketRatesPanelView = ({
  borrowAPR,
  borrowRewardsAPR = 0n,
  earnAPR,
  earnRewardsAPR = 0n,
  rewardsAssetSymbol,
  isInstitutional,
}: PanelContent) => {
  const netBorrowAPR = borrowAPR - borrowRewardsAPR;
  const netSupplyAPR = earnAPR + earnRewardsAPR;

  const netBorrowRateGraph = (
    <NetRatesGraph
      state={NetRatesGraphType.Borrow}
      borrowAPR={borrowAPR}
      borrowRewardsAPR={borrowRewardsAPR}
      rewardsAssetSymbol={rewardsAssetSymbol}
    />
  );

  // Institutional markets show the base/boost breakdown bar; the whitelist
  // status renders as a standalone banner on the page instead of a card here
  const netEarnRateGraph =
    isInstitutional && earnRewardsAPR > 0n ? (
      <BoostedSupplyRates earnAPR={earnAPR} boostAPR={earnRewardsAPR} showWhitelistCard={false} />
    ) : (
      <NetRatesGraph
        state={NetRatesGraphType.Earn}
        earnAPR={earnAPR}
        earnRewardsAPR={earnRewardsAPR}
        rewardsAssetSymbol={rewardsAssetSymbol}
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

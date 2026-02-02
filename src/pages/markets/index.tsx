import { StateType } from '@types';

import MarketOverviewHistoryPanel, { MarketOverviewHistoryPanelLoading } from './components/MarketOverviewHistoryPanel';
import MarketOverviewPanels, { MarketOverviewPanelsLoading } from './components/MarketOverviewPanels';
import { useMarketsOverviewState } from './hooks/useMarketsOverviewState';

const MarketOverview = () => {
  const [stateType, state] = useMarketsOverviewState();

  if (stateType === StateType.Loading || state === undefined) {
    return (
      <div className="page">
        <MarketOverviewHistoryPanelLoading />
        <MarketOverviewPanelsLoading />
      </div>
    );
  }

  return (
    <div className="page">
      <MarketOverviewHistoryPanel historicalMarketSummaries={state.historicalMarketSummaries} />
      <MarketOverviewPanels latestMarketSummaries={state.latestMarketSummaries} />
    </div>
  );
};

export default MarketOverview;

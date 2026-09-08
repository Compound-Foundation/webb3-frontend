import { useWeb3Context } from '@contexts/Web3Context';
import { institutionalWhitelistStatus } from '@helpers/institutionalWhitelist';
import { StateType } from '@types';

import MarketOverviewHistoryPanel, { MarketOverviewHistoryPanelLoading } from './components/MarketOverviewHistoryPanel';
import MarketOverviewPanels, { MarketOverviewPanelsLoading } from './components/MarketOverviewPanels';
import { useMarketsOverviewState } from './hooks/useMarketsOverviewState';

const MarketOverview = () => {
  const [stateType, state] = useMarketsOverviewState();
  const web3 = useWeb3Context();
  const whitelistStatus = institutionalWhitelistStatus(web3.read.account);

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
      <MarketOverviewPanels
        latestMarketSummaries={state.latestMarketSummaries}
        institutionalWhitelistStatus={whitelistStatus}
      />
    </div>
  );
};

export default MarketOverview;

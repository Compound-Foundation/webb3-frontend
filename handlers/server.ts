import { rest } from 'msw';
import { setupServer } from 'msw/node';

import { historicalMarketSummaryHandler } from './mock-historical-market-summary';
import { latestMarketSummaryHandlers } from './mock-latest-market-summary';
import { transactionsHandlers } from './transactions-handler';
import { voteHandlers } from './vote-handlers';

const server = setupServer(
  ...voteHandlers,
  ...transactionsHandlers,
  ...latestMarketSummaryHandlers,
  ...historicalMarketSummaryHandler
);
export { server, rest };

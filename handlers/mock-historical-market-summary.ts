import { rest } from 'msw';

import { getHistoricalMarketSummaryEndpoint } from '@helpers/urls';

import mockHistoricalMarketSummaryResponse from '../__tests__/mocks/mockHistoricalMarketSummaryResponse.json';

export const historicalMarketSummaryHandler = [
  rest.get(`${getHistoricalMarketSummaryEndpoint()}`, (_req, res, ctx) => {
    return res(ctx.status(200), ctx.json(mockHistoricalMarketSummaryResponse));
  }),
];

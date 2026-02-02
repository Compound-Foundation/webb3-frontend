import { rest } from 'msw';

import { getLatestMarketSummaryEndpoint } from '@helpers/urls';

import mockLatestMarketSummaryResponse from '../__tests__/mocks/mockLatestMarketSummaryResponse.json';

export const latestMarketSummaryHandlers = [
  rest.get(`${getLatestMarketSummaryEndpoint()}`, (_req, res, ctx) => {
    return res(ctx.status(200), ctx.json(mockLatestMarketSummaryResponse));
  }),
];

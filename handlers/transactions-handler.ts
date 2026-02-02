// src/handlers.js
import { rest } from 'msw';

import { getTransactionHistoryEndpoint } from '@helpers/urls';

import { mockUnitTransactionBorrow } from '../__tests__/mocks/mockTransactions';
const account = '0x124';
const cursor = '';
const limit = 30;

export const transactionsHandlers = [
  rest.get(`${getTransactionHistoryEndpoint(account, cursor, limit)}`, (req, res, ctx) => {
    return res(
      ctx.status(200),
      ctx.json({
        items: [mockUnitTransactionBorrow],
      })
    );
  }),
];

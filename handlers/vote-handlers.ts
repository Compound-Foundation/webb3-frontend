// src/handlers.js
import { rest } from 'msw';

import { getGovernanceUrlForChain } from '@helpers/urls';

export const voteHandlers = [
  rest.get(`${getGovernanceUrlForChain('mainnet')}/comp/accounts`, (req, res, ctx) => {
    return res(
      ctx.status(200),
      ctx.json({
        accounts: [
          {
            image_url:
              'https://profile.compound.finance/1LFz91R1wl7kkYjjVFQ9uvB2h0jWPqb00/GtDl1nWWOiGk4SNbZ1+eEpNPU+8v6Nz/uVEVPWTMRhc=',
            account_url: '',
            display_name: 'Example Delegate',
            address: '0x0000000000000000000000000000000000000001',
            votes: '330974.973284924368128094',
            vote_weight: '0.033097497328492436',
            proposals_created: 0,
            delegate: {
              image_url: null,
              account_url: null,
              display_name: null,
              address: '0x0000000000000000000000000000000000000000',
            },
            rank: 1,
            proposals_voted: 38,
            total_delegates: 153,
            balance: null,
            transactions: null,
          },
        ],
      })
    );
  }),
];

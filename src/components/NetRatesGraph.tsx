import Tooltip from '@components/Tooltip';
import { formatRateFactor } from '@helpers/numbers';

import { LineTexture } from './Icons/LineTexture';

export enum NetRatesGraphType {
  Borrow = 'borrow',
  Earn = 'earn',
}

type NetRatesBorrowGraphState = {
  state: NetRatesGraphType.Borrow;
  borrowAPR: bigint;
  borrowRewardsAPR?: bigint;
  rewardsAssetSymbol?: string;
};

type NetRatesEarnGraphState = {
  state: NetRatesGraphType.Earn;
  earnAPR: bigint;
  earnRewardsAPR?: bigint;
  rewardsAssetSymbol?: string;
};

type NetRatesGraphState = NetRatesBorrowGraphState | NetRatesEarnGraphState;

const NetRatesGraph = (state: NetRatesGraphState) => {
  const { rewardsAssetSymbol } = state;
  switch (state.state) {
    case NetRatesGraphType.Borrow: {
      const { borrowAPR, borrowRewardsAPR = 0n } = state;
      const netBorrowAPR = borrowAPR - borrowRewardsAPR;

      return (
        <>
          {netBorrowAPR >= 0n || borrowRewardsAPR === undefined ? (
            <div className='net-rates-graph__graph'>
              <div className='net-rates-graph__graph__row net-rates-graph__bar net-rates-graph__bar--borrow'>
                {borrowRewardsAPR > 0 && (
                  <div
                    className='net-rates-graph__reward net-rates-graph__reward--borrow'
                    style={{ width: (Number(borrowRewardsAPR) / Number(borrowAPR)) * 100 + '%' }}
                  >
                    <LineTexture className='line-texture' fillColor='var(--data--borrow)' />
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <p className='L3 meta text-color--1'>
                  {formatRateFactor(borrowAPR)} <span className='L4 meta text-color--2'> Interest</span>
                </p>
                {borrowRewardsAPR > 0 && (
                  <div className='net-rates-graph__reward__asset'>
                    <span className='L3 meta text-color--1'>{formatRateFactor(borrowRewardsAPR)}</span>
                      <Tooltip
                        width={226}
                        yOffset={12}
                        content={
                          <p className='net-rates-graph__tooltip-text'>
                            Boosted by Compound: Net Borrow APR equals the base interest rate
                            ({formatRateFactor(borrowAPR)}) minus the COMP reward est. rate
                            ({formatRateFactor(borrowRewardsAPR)}).
                          </p>
                        }
                      >
                        <span className={`asset asset--${rewardsAssetSymbol} net-rates-graph__tooltip-icon`}></span>
                      </Tooltip>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className='net-rates-graph__graph'>
              <div className='net-rates-graph__graph__row net-rates-graph__bar net-rates-graph__bar--rewards'>
                <div
                  className='net-rates-graph__reward net-rates-graph__reward--interest'
                  style={{ width: (Number(borrowAPR) / Number(borrowRewardsAPR)) * 100 + '%' }}
                >
                  <LineTexture className='line-texture' fillColor='var(--data--warning)' />
                  <div className='net-rates-graph__reward__asset net-rates-graph__reward__asset--nested'>
                    <span className='L3 meta text-color--1'>
                      {formatRateFactor(borrowAPR)} <span className='L4 meta text-color--warning'> Interest</span>
                    </span>
                  </div>
                </div>
              </div>
              <div className='net-rates-graph__reward__asset'>
                <span className='L3 meta text-color--1'>{formatRateFactor(borrowRewardsAPR)}</span>
                  <Tooltip
                    width={226}
                    yOffset={12}
                    content={
                      <p className='net-rates-graph__tooltip-text'>
                        Boosted by Compound: Net Borrow APR equals the base interest rate
                        ({formatRateFactor(borrowAPR)}) minus the COMP reward est. rate
                        ({formatRateFactor(borrowRewardsAPR)}).
                      </p>
                    }
                  >
                    <span className={`asset asset--${rewardsAssetSymbol} net-rates-graph__tooltip-icon`}></span>
                  </Tooltip>
              </div>
            </div>
          )}
        </>
      );
    }
    case NetRatesGraphType.Earn: {
      const { earnAPR, earnRewardsAPR = 0n } = state;
      const netSupplyAPR = earnAPR + earnRewardsAPR;

      //TODO: Here the net-rates-graph__graph has 2 top level divs :(
      return (
        <>
          <div className='net-rates-graph__earn-group'>
            <div
              className='net-rates-graph__graph net-rates-graph--earn-group'
              style={{ width: (Number(earnAPR) / Number(netSupplyAPR)) * 100 + '%' }}
            >
              <div className='net-rates-graph__bar net-rates-graph__bar--supply'></div>
              <p className='L3 meta text-color--1'>
                {formatRateFactor(earnAPR)} <span className='L4 meta text-color--2'>Interest</span>
              </p>
            </div>

            {earnRewardsAPR > 0n && (
              <div
                className='net-rates-graph__graph'
                style={{ width: (Number(earnRewardsAPR) / Number(netSupplyAPR)) * 100 + '%' }}
              >
                <div className='net-rates-graph__bar net-rates-graph__bar--rewards'></div>
                <div className='net-rates-graph__reward__asset'>
                  <span className='L3 meta text-color--1'>{formatRateFactor(earnRewardsAPR)}</span>
                    <Tooltip
                      width={226}
                      yOffset={12}
                      content={
                        <p className='net-rates-graph__tooltip-text'>
                          Boosted by Compound: Net Earn APR equals the base interest rate ({formatRateFactor(earnAPR)})
                          plus the COMP reward est. rate ({formatRateFactor(earnRewardsAPR)}).
                        </p>
                      }
                    >
                      <span className={`asset asset--${rewardsAssetSymbol} net-rates-graph__tooltip-icon`}></span>
                    </Tooltip>
                </div>
              </div>
            )}
          </div>
        </>
      );
    }
  }
};

export default NetRatesGraph;

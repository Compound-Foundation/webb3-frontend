import { formatRateFactor } from '@helpers/numbers';
import { Token } from '@types';

import { LineTexture } from './Icons/LineTexture';

export enum NetRatesGraphType {
  Borrow = 'borrow',
  Earn = 'earn',
}

type NetRatesBorrowGraphState = {
  state: NetRatesGraphType.Borrow;
  borrowAPR: bigint;
  borrowRewardsAPR: bigint | undefined;
  rewardsAsset: Token | undefined;
};

type NetRatesEarnGraphState = {
  state: NetRatesGraphType.Earn;
  earnAPR: bigint;
  earnRewardsAPR: bigint | undefined;
  rewardsAsset: Token | undefined;
};

type NetRatesGraphState = NetRatesBorrowGraphState | NetRatesEarnGraphState;

const NetRatesGraph = (state: NetRatesGraphState) => {
  const { rewardsAsset } = state;
  switch (state.state) {
    case NetRatesGraphType.Borrow: {
      const { borrowAPR, borrowRewardsAPR } = state;
      const netBorrowAPR = borrowRewardsAPR ? borrowAPR - borrowRewardsAPR : borrowAPR;

      return (
        <>
          {netBorrowAPR >= 0n || borrowRewardsAPR === undefined ? (
            <div className="net-rates-graph__graph">
              <div className="net-rates-graph__graph__row net-rates-graph__bar net-rates-graph__bar--borrow">
                {borrowRewardsAPR !== undefined && formatRateFactor(borrowRewardsAPR) !== '0.00%' && (
                  <div
                    className="net-rates-graph__reward net-rates-graph__reward--borrow"
                    style={{ width: (Number(borrowRewardsAPR) / Number(borrowAPR)) * 100 + '%' }}
                  >
                    <LineTexture className="line-texture" fillColor="var(--data--borrow)" />
                    <div className="net-rates-graph__reward__asset net-rates-graph__reward__asset--nested">
                      <span className={`asset asset--${rewardsAsset?.symbol}`}></span>
                      <span className="L3 meta text-color--1">{formatRateFactor(borrowRewardsAPR)}</span>
                    </div>
                  </div>
                )}
              </div>
              <p className="L3 meta text-color--1">
                {formatRateFactor(borrowAPR)} <span className="L4 meta text-color--2"> Interest</span>
              </p>
            </div>
          ) : (
            <div className="net-rates-graph__graph">
              <div className="net-rates-graph__graph__row net-rates-graph__bar net-rates-graph__bar--rewards">
                <div
                  className="net-rates-graph__reward net-rates-graph__reward--interest"
                  style={{ width: (Number(borrowAPR) / Number(borrowRewardsAPR)) * 100 + '%' }}
                >
                  <LineTexture className="line-texture" fillColor="var(--data--warning)" />
                  <div className="net-rates-graph__reward__asset net-rates-graph__reward__asset--nested">
                    <span className="L3 meta text-color--1">
                      {formatRateFactor(borrowAPR)} <span className="L4 meta text-color--warning"> Interest</span>
                    </span>
                  </div>
                </div>
              </div>
              <div className="net-rates-graph__reward__asset">
                <span className={`asset asset--${rewardsAsset?.symbol}`}></span>
                <p className="L3 meta text-color--1">{formatRateFactor(borrowRewardsAPR)}</p>
              </div>
            </div>
          )}
        </>
      );
    }
    case NetRatesGraphType.Earn: {
      const { earnAPR, earnRewardsAPR } = state;
      const netSupplyAPR = earnRewardsAPR ? earnRewardsAPR + earnAPR : earnAPR;

      //TODO: Here the net-rates-graph__graph has 2 top level divs :(
      return (
        <>
          <div className="net-rates-graph__earn-group">
            <div
              className="net-rates-graph__graph net-rates-graph--earn-group"
              style={{ width: (Number(earnAPR) / Number(netSupplyAPR)) * 100 + '%' }}
            >
              <div className="net-rates-graph__bar net-rates-graph__bar--supply"></div>
              <p className="L3 meta text-color--1">
                {formatRateFactor(earnAPR)} <span className="L4 meta text-color--2">Interest</span>
              </p>
            </div>

            {earnRewardsAPR !== undefined && formatRateFactor(earnRewardsAPR) !== '0.00%' && (
              <div
                className="net-rates-graph__graph"
                style={{ width: (Number(earnRewardsAPR) / Number(netSupplyAPR)) * 100 + '%' }}
              >
                <div className="net-rates-graph__bar net-rates-graph__bar--rewards"></div>
                <div className="net-rates-graph__reward__asset">
                  <span className={`asset asset--${rewardsAsset?.symbol}`}></span>
                  <p className="L3 meta text-color--1">{formatRateFactor(earnRewardsAPR)}</p>
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

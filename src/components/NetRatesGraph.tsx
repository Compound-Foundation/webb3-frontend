import { formatRateFactor } from '@helpers/numbers';

export enum NetRatesGraphType {
  Borrow = 'borrow',
  Earn = 'earn',
}

type NetRatesBorrowGraphState = {
  state: NetRatesGraphType.Borrow;
  borrowAPR: bigint;
};

type NetRatesEarnGraphState = {
  state: NetRatesGraphType.Earn;
  earnAPR: bigint;
};

type NetRatesGraphState = NetRatesBorrowGraphState | NetRatesEarnGraphState;

const NetRatesGraph = (state: NetRatesGraphState) => {
  switch (state.state) {
    case NetRatesGraphType.Borrow: {
      const { borrowAPR } = state;

      return (
        <div className="net-rates-graph__graph">
          <div className="net-rates-graph__graph__row net-rates-graph__bar net-rates-graph__bar--borrow"></div>
          <p className="L3 meta text-color--1">
            {formatRateFactor(borrowAPR)} <span className="L4 meta text-color--2"> Interest</span>
          </p>
        </div>
      );
    }
    case NetRatesGraphType.Earn: {
      const { earnAPR } = state;

      return (
        <div className="net-rates-graph__earn-group">
          <div className="net-rates-graph__graph net-rates-graph--earn-group">
            <div className="net-rates-graph__bar net-rates-graph__bar--supply"></div>
            <p className="L3 meta text-color--1">
              {formatRateFactor(earnAPR)} <span className="L4 meta text-color--2">Interest</span>
            </p>
          </div>
        </div>
      );
    }
  }
};

export default NetRatesGraph;
import NetRatesGraph, { NetRatesGraphType } from '@components/NetRatesGraph';
import { formatRateFactor } from '@helpers/numbers';

export enum NetRatesTooltipView {
  Borrow = 'borrow',
  Supply = 'supply',
  All = 'all',
}

export interface NetRatesTooltipProps {
  borrowAPR: bigint;
  earnAPR: bigint;
  view: NetRatesTooltipView;
}

const NetRatesTooltip = ({
  borrowAPR,
  earnAPR,
  view,
}: NetRatesTooltipProps) => {
  const netBorrowAPR = borrowAPR;
  const netSupplyAPR = earnAPR;

  const netBorrowRateGraph = (
    <NetRatesGraph
      state={NetRatesGraphType.Borrow}
      borrowAPR={borrowAPR}
    />
  );

  const netEarnRateGraph = (
    <NetRatesGraph
      state={NetRatesGraphType.Earn}
      earnAPR={earnAPR}
    />
  );

  const borrowGraph = (
    <div className="net-rates-tooltip__section">
      <label className="L2 label text-color--2">Net Borrow APR</label>
      <p className="L2 body body--emphasized text-color--1">{formatRateFactor(netBorrowAPR)}</p>
      {netBorrowRateGraph}
    </div>
  );

  const supplyGraph = (
    <div className="net-rates-tooltip__section">
      <label className="L2 label text-color--2">Net Supply APR</label>
      <p className="L2 body body--emphasized text-color--1">{formatRateFactor(netSupplyAPR)}</p>
      {netEarnRateGraph}
    </div>
  );

  const content =
    view === NetRatesTooltipView.Borrow ? (
      borrowGraph
    ) : view === NetRatesTooltipView.Supply ? (
      supplyGraph
    ) : (
      <>
        {borrowGraph}
        <div className="divider"></div>
        {supplyGraph}
      </>
    );

  return <div className="net-rates-tooltip">{content}</div>;
};

export default NetRatesTooltip;

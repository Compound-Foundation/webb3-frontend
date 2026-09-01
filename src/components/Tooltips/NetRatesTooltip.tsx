import BoostedSupplyRates from '@components/BoostedSupplyRates';
import NetRatesGraph, { NetRatesGraphType } from '@components/NetRatesGraph';
import { InstitutionalWhitelistStatus } from '@helpers/institutionalWhitelist';
import { formatRateFactor } from '@helpers/numbers';
import { Token } from '@types';

export enum NetRatesTooltipView {
  Borrow = 'borrow',
  Supply = 'supply',
  All = 'all',
}

export interface NetRatesTooltipProps {
  borrowAPR: bigint;
  borrowRewardsAPR?: bigint;
  earnAPR: bigint;
  earnRewardsAPR?: bigint;
  // Set on institutional markets: the supply section shows the boosted rate
  // breakdown and whitelist card instead of the standard earn graph
  institutionalBoostAPR?: bigint;
  institutionalWhitelistStatus?: InstitutionalWhitelistStatus;
  // Whether the connected account is currently supplying to the market
  institutionalSupplying?: boolean;
  // Label override for the boosted portion of the rate
  institutionalBoostLabel?: string;
  rewardsAsset?: Token;
  view: NetRatesTooltipView;
}

const NetRatesTooltip = ({
   borrowAPR,
   borrowRewardsAPR = 0n,
   earnAPR,
   earnRewardsAPR = 0n,
   institutionalBoostAPR,
   institutionalWhitelistStatus,
   institutionalSupplying = false,
   institutionalBoostLabel,
   rewardsAsset,
   view,
 }: NetRatesTooltipProps) => {
  const netBorrowAPR = borrowRewardsAPR ? borrowAPR - borrowRewardsAPR : borrowAPR;
  const netSupplyAPR = earnRewardsAPR ? earnRewardsAPR + earnAPR : earnAPR;

  const netBorrowRateGraph = (
    <NetRatesGraph
      state={NetRatesGraphType.Borrow}
      borrowAPR={borrowAPR}
      borrowRewardsAPR={borrowRewardsAPR}
      rewardsAsset={rewardsAsset}
    />
  );

  const netEarnRateGraph = (
    <NetRatesGraph
      state={NetRatesGraphType.Earn}
      earnAPR={earnAPR}
      earnRewardsAPR={earnRewardsAPR}
      rewardsAsset={rewardsAsset}
    />
  );

  const borrowGraph = (
    <div className="net-rates-tooltip__section">
      <label className="L2 label text-color--2">Net Borrow APR</label>
      <p className="L2 body body--emphasized text-color--1">{formatRateFactor(netBorrowAPR)}</p>
      {netBorrowRateGraph}
    </div>
  );

  const boostAPR = institutionalBoostAPR !== undefined && institutionalBoostAPR > 0n ? institutionalBoostAPR : undefined;
  const boostedBreakdown =
    boostAPR !== undefined ? (
      <BoostedSupplyRates
        earnAPR={earnAPR}
        boostAPR={boostAPR}
        whitelistStatus={institutionalWhitelistStatus ?? InstitutionalWhitelistStatus.NoWallet}
        hasSupplyPosition={institutionalSupplying}
        boostLabel={institutionalBoostLabel}
      />
    ) : null;

  const supplyGraph = (
    <div className="net-rates-tooltip__section">
      <label className="L2 label text-color--2">Net Supply APR</label>
      <p className="L2 body body--emphasized text-color--1">
        {formatRateFactor(boostAPR !== undefined ? earnAPR + boostAPR : netSupplyAPR)}
      </p>
      {boostedBreakdown ?? netEarnRateGraph}
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

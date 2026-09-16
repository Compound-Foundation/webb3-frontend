import BoostedSupplyRates from '@components/BoostedSupplyRates';
import NetRatesGraph, { NetRatesGraphType } from '@components/NetRatesGraph';
import { InstitutionalWhitelistStatus } from '@helpers/institutionalWhitelist';
import { formatRateFactor } from '@helpers/numbers';

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
  institutionalWhitelistStatus?: InstitutionalWhitelistStatus;
  // Label override for the boosted portion of the rate
  institutionalBoostLabel?: string;
  rewardsAssetSymbol?: string;
  view: NetRatesTooltipView;
  isInstitutional?: boolean;
}

const NetRatesTooltip = ({
  borrowAPR,
  borrowRewardsAPR = 0n,
  earnAPR,
  earnRewardsAPR = 0n,
  rewardsAssetSymbol,
  institutionalWhitelistStatus,
  institutionalBoostLabel,
  isInstitutional,
  view,
}: NetRatesTooltipProps) => {
  const netBorrowAPR = borrowAPR - borrowRewardsAPR;
  const netSupplyAPR = earnAPR + earnRewardsAPR;

  const netBorrowRateGraph = (
    <NetRatesGraph
      state={NetRatesGraphType.Borrow}
      borrowAPR={borrowAPR}
      borrowRewardsAPR={borrowRewardsAPR}
      rewardsAssetSymbol={rewardsAssetSymbol}
    />
  );

  const netEarnRateGraph = (
    <NetRatesGraph
      state={NetRatesGraphType.Earn}
      earnAPR={earnAPR}
      earnRewardsAPR={earnRewardsAPR}
      rewardsAssetSymbol={rewardsAssetSymbol}
    />
  );

  const borrowGraph = (
    <div className="net-rates-tooltip__section">
      <label className="L2 label text-color--2">Net Borrow APR</label>
      <p className="L2 body body--emphasized text-color--1">{formatRateFactor(netBorrowAPR)}</p>
      {netBorrowRateGraph}
    </div>
  );

  const boostedBreakdown =
    isInstitutional ? (
      <BoostedSupplyRates
        earnAPR={earnAPR}
        boostAPR={earnRewardsAPR}
        whitelistStatus={institutionalWhitelistStatus ?? InstitutionalWhitelistStatus.NoWallet}
        boostLabel={institutionalBoostLabel}
      />
    ) : null;

  const supplyGraph = (
    <div className="net-rates-tooltip__section">
      <label className="L2 label text-color--2">Net Supply APR</label>
      <p className="L2 body body--emphasized text-color--1">
        {formatRateFactor(netSupplyAPR)}
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

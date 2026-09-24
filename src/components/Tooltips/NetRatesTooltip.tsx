import BoostedSupplyRates from '@components/BoostedSupplyRates';
import NetRatesGraph, { NetRatesGraphType } from '@components/NetRatesGraph';
import { InstitutionalWhitelistStatus } from '@helpers/institutionalWhitelist';
import { formatRateFactor } from '@helpers/numbers';

export enum NetRatesTooltipView {
  Borrow = 'borrow',
  Supply = 'supply',
  All = 'all',
}

export enum RewardsType {
  Standard = 'standard',
  Institutional = 'institutional',
  Merkl = 'merkl',
}

interface BaseRewards {
  supplyAPR: bigint;
  borrowAPR: bigint;
  assetSymbol?: string;
}

export type MarketRewards =
  | (BaseRewards & { type: RewardsType.Standard })
  | (BaseRewards & { type: RewardsType.Merkl })
  | (BaseRewards & {
  type: RewardsType.Institutional;
  whitelistStatus?: InstitutionalWhitelistStatus;
  boostLabel?: string;
});

export interface NetRatesTooltipProps {
  borrowAPR: bigint;
  earnAPR: bigint;
  rewards?: MarketRewards;
  view: NetRatesTooltipView;
}

const NetRatesTooltip = ({ borrowAPR, earnAPR, rewards, view }: NetRatesTooltipProps) => {
  const borrowRewardsAPR = rewards?.borrowAPR ?? 0n;
  const earnRewardsAPR = rewards?.supplyAPR ?? 0n;
  const rewardsAssetSymbol = rewards?.assetSymbol;

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
    rewards?.type === RewardsType.Institutional ? (
      <BoostedSupplyRates
        earnAPR={earnAPR}
        boostAPR={rewards.supplyAPR}
        whitelistStatus={rewards.whitelistStatus ?? InstitutionalWhitelistStatus.NoWallet}
        boostLabel={rewards.boostLabel}
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
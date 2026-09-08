import { Bolt } from '@components/Icons';
import Tooltip from '@components/Tooltip';
import NetRatesTooltip, { NetRatesTooltipView } from '@components/Tooltips/NetRatesTooltip';
import { InstitutionalWhitelistStatus } from '@helpers/institutionalWhitelist';

import { MarketSummary } from '../../../types';

type InstitutionalRateInfoProps = {
  marketSummary: MarketSummary;
  whitelistStatus?: InstitutionalWhitelistStatus;
};

/**
 * Info icon on an institutional market's Net Earn APR that opens the boosted
 * supply rate breakdown: base interest vs the whitelisted extra yield, plus the
 * whitelist card for the connected account.
 */
const InstitutionalRateInfo = ({
  marketSummary,
  whitelistStatus = InstitutionalWhitelistStatus.NoWallet,
}: InstitutionalRateInfoProps) => {
  const boostAPR = marketSummary.institutionalSupplyRewardsAPR ?? 0n;

  return (
    <Tooltip
      width={400}
      hideArrow={true}
      interactive={true}
      // Lifts the tooltip 0.75rem; combined with the hide-arrow 20px downshift
      // it still overlaps the icon slightly, keeping the hover chain intact
      yOffset={12}
      content={
        <NetRatesTooltip
          borrowAPR={0n}
          earnAPR={marketSummary.supplyAPR - boostAPR}
          institutionalBoostAPR={boostAPR}
          institutionalWhitelistStatus={whitelistStatus}
          institutionalBoostLabel="Whitelisted Extra APY"
          view={NetRatesTooltipView.Supply}
        />
      }
    >
      <span className="info-icon" onClick={(e) => e.stopPropagation()}>
        <Bolt />
      </span>
    </Tooltip>
  );
};

export default InstitutionalRateInfo;

import { INSTITUTIONAL_MARKET_URL } from '@helpers/urls';

import { InfoSolid } from './Icons';
import { SimpleLink } from './SimpleLink';
import Tooltip from './Tooltip';

// Info icon annotating rates that include an institutional market's USDC rewards
const InstitutionalRewardsTooltip = () => (
  <Tooltip
    width={220}
    interactive
    under
    content={
      <div className="tooltip__content L4">
        <p className="body">
          Rewards subject to availability.{' '}
          <SimpleLink to={INSTITUTIONAL_MARKET_URL} className="tooltip__link">
            Learn more
          </SimpleLink>
        </p>
      </div>
    }
  >
    <span className="info-icon" onClick={(e) => e.stopPropagation()}>
      <InfoSolid />
    </span>
  </Tooltip>
);

export default InstitutionalRewardsTooltip;

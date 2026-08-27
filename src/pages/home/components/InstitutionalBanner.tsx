import { MarketData, MarketDataLoaded } from '@types';

const TITLE = 'Compound Institutional Market';
const NEW = 'New';

type InstitutionalBannerProps = {
  market: MarketData | MarketDataLoaded | undefined;
};

// Hero banner shown only when an institutional market is selected
const InstitutionalBanner = ({ market }: InstitutionalBannerProps) => {
  if (!market?.institutional) {
    return null;
  }

  return (
    <div className="institutional-banner L1">
      <h1 className="institutional-banner__title heading heading--emphasized">
        {TITLE}
        <span className="institutional-banner__new-badge label">{NEW}</span>
      </h1>
    </div>
  );
};

export default InstitutionalBanner;

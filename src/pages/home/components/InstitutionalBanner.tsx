import { INSTITUTIONAL_MARKET_URL } from '@helpers/urls';
import { MarketData, MarketDataLoaded } from '@types';

const TITLE = 'Compound Institutional Market';
const USDG_TITLE = 'Compound USDG Institutional Market';
const NEW = 'New';

type InstitutionalBannerProps = {
  market: MarketData | MarketDataLoaded | undefined;
};

// Hero banner shown only when an institutional market is selected. The USDG
// market has its own treatment (coin artwork, Learn More button, asymmetric
// border); other institutional markets keep the original banner.
const InstitutionalBanner = ({ market }: InstitutionalBannerProps) => {
  if (!market?.institutional) {
    return null;
  }

  if (market.slug === 'usdg-institutional') {
    return (
      <div className="institutional-banner institutional-banner--usdg L1">
        <div className="institutional-banner__lead">
          <div className="institutional-banner__coins" aria-hidden="true">
            <img
              className="institutional-banner__coins__secondary"
              src="/images/institutional-usdg-coin-secondary.png"
              alt=""
            />
            <img className="institutional-banner__coins__main" src="/images/institutional-usdg-coin.png" alt="" />
          </div>
          <h1 className="institutional-banner__title heading heading--emphasized">
            {USDG_TITLE}
            {market.isNew && <span className="new-badge new-badge--large label mobile-hide">{NEW}</span>}
          </h1>
        </div>
        {/* On mobile the badge moves down next to the button, keeping the banner short */}
        <div className="institutional-banner__actions">
          {market.isNew && <span className="new-badge new-badge--large label mobile-only">{NEW}</span>}
          <a
            className="button button--large institutional-banner__learn-more"
            href={INSTITUTIONAL_MARKET_URL}
            target="_blank"
            rel="noreferrer"
          >
            Learn More
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="institutional-banner L1">
      <h1 className="institutional-banner__title heading heading--emphasized">
        {TITLE}
        {market.isNew && <span className="new-badge new-badge--large label">{NEW}</span>}
      </h1>
    </div>
  );
};

export default InstitutionalBanner;

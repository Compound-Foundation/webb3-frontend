import { INSTITUTIONAL_BOOST_END_DATE_LABEL } from '@helpers/institutionalRates';
import { InstitutionalWhitelistStatus } from '@helpers/institutionalWhitelist';
import { INSTITUTIONAL_REGISTER_URL } from '@helpers/urls';

type WhitelistStatusBannerProps = {
  whitelistStatus: InstitutionalWhitelistStatus;
};

/**
 * Slim banner on the institutional market detail page describing the connected
 * account's access to the boosted supply rate. Shown only while the boost is
 * paying.
 */
const WhitelistStatusBanner = ({ whitelistStatus }: WhitelistStatusBannerProps) => {
  if (whitelistStatus === InstitutionalWhitelistStatus.Whitelisted) {
    return (
      <div className="whitelist-status-banner grid-column--12">
        <div className="whitelist-status-banner__lead whitelist-status-banner__lead--badged">
          <img className="whitelist-status-banner__icon" src="/images/whitelist-badge.png" alt="" />
          <span className="new-badge label label--secondary">Approved</span>
          <p className="whitelist-status-banner__title L3 body body--emphasized">You are earning boosted yield</p>
        </div>
        <p className="whitelist-status-banner__detail L4 body">Boosted yield applies until {INSTITUTIONAL_BOOST_END_DATE_LABEL}.</p>
      </div>
    );
  }

  if (whitelistStatus === InstitutionalWhitelistStatus.NotWhitelisted) {
    return (
      <div className="whitelist-status-banner grid-column--12">
        <div className="whitelist-status-banner__lead">
          <img className="whitelist-status-banner__icon" src="/images/whitelist-coins.png" alt="" />
          <p className="whitelist-status-banner__title L3 body body--emphasized">Earn boosted yield</p>
        </div>
        <p className="whitelist-status-banner__detail L4 body">
          Boosted yield is exclusive to approved users.{' '}
          <a
            className="whitelist-status-banner__link"
            href={INSTITUTIONAL_REGISTER_URL}
            target="_blank"
            rel="noreferrer"
          >
            Register Now
          </a>
        </p>
      </div>
    );
  }

  // Pre-login: no connected wallet
  return (
    <div className="whitelist-status-banner grid-column--12">
      <div className="whitelist-status-banner__lead">
        <img className="whitelist-status-banner__icon" src="/images/whitelist-coins.png" alt="" />
        <div>
          <p className="whitelist-status-banner__title L3 body body--emphasized">Earn boosted yield</p>
          <p className="whitelist-status-banner__detail L4 body">
            Submit your application and our team will contact you with further details
          </p>
        </div>
      </div>
      <a
        className="button button--large whitelist-status-banner__register"
        href={INSTITUTIONAL_REGISTER_URL}
        target="_blank"
        rel="noreferrer"
      >
        Register Now
      </a>
    </div>
  );
};

export default WhitelistStatusBanner;

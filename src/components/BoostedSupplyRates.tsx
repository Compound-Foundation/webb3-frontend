import { Bolt } from '@components/Icons';
import { INSTITUTIONAL_BOOST_END_DATE_LABEL } from '@helpers/institutionalRates';
import { InstitutionalWhitelistStatus } from '@helpers/institutionalWhitelist';
import { formatRateFactor } from '@helpers/numbers';
import { INSTITUTIONAL_MARKET_URL, INSTITUTIONAL_REGISTER_URL } from '@helpers/urls';

type BoostedSupplyRatesProps = {
  // The market's regular floating supply rate, at FACTOR_PRECISION
  earnAPR: bigint;
  // The institutional program's boost on top of the floating rate, at FACTOR_PRECISION
  boostAPR: bigint;
  whitelistStatus?: InstitutionalWhitelistStatus;
  // Label for the boosted portion of the rate (e.g. "Whitelisted Extra APY" on
  // the markets page)
  boostLabel?: string;
  // The market detail page shows the bar and labels alone; its whitelist
  // status renders as a standalone banner instead
  showWhitelistCard?: boolean;
};

/**
 * The boosted supply rate breakdown shown on institutional markets inside the
 * net rates overlay: a segmented bar splitting the net supply rate into base
 * interest and the boosted portion, and a whitelist card that either confirms
 * the connected address is whitelisted or invites it to get whitelisted.
 */
const BoostedSupplyRates = ({
  earnAPR,
  boostAPR,
  whitelistStatus = InstitutionalWhitelistStatus.NoWallet,
  boostLabel = 'Boosted APR',
  showWhitelistCard = true,
}: BoostedSupplyRatesProps) => {
  const totalAPR = earnAPR + boostAPR;
  // Segment widths are proportional to each component's share of the total,
  // floored so a small base rate still reads as a visible segment
  const boostShare = totalAPR > 0n ? Number((boostAPR * 100n) / totalAPR) : 0;
  const baseShare = 100 - boostShare;

  let whitelistCard: JSX.Element;
  if (whitelistStatus === InstitutionalWhitelistStatus.Whitelisted) {
    whitelistCard = (
      <div className="boosted-supply-rates__whitelist-card">
        <img className="boosted-supply-rates__whitelist-card__badge" src="/images/whitelist-badge.png" alt="" />
        <div>
          <p className="boosted-supply-rates__whitelist-card__title L3 body body--emphasized">
            You are earning boosted yield
          </p>
          <p className="boosted-supply-rates__whitelist-card__subtitle L4 meta">
            Boosted yield applies until {INSTITUTIONAL_BOOST_END_DATE_LABEL}.
          </p>
        </div>
      </div>
    );
  } else if (whitelistStatus === InstitutionalWhitelistStatus.NotWhitelisted) {
    whitelistCard = (
      <div className="boosted-supply-rates__whitelist-card">
        <img className="boosted-supply-rates__whitelist-card__badge" src="/images/whitelist-coins.png" alt="" />
        <div>
          <p className="boosted-supply-rates__whitelist-card__title L3 body body--emphasized">Earn boosted yield</p>
          <p className="boosted-supply-rates__whitelist-card__subtitle L4 meta">
            Boosted yield is exclusive to approved users.
          </p>
          <a
            className="boosted-supply-rates__whitelist-card__link L4"
            href={INSTITUTIONAL_REGISTER_URL}
            target="_blank"
            rel="noreferrer"
          >
            Register now
          </a>
        </div>
      </div>
    );
  } else {
    whitelistCard = (
      <div className="boosted-supply-rates__whitelist-card">
        <div>
          <p className="boosted-supply-rates__whitelist-card__title L3 body body--emphasized">
            Get approved to access the boosted yield
          </p>
          <a
            className="boosted-supply-rates__whitelist-card__link L4"
            href={INSTITUTIONAL_MARKET_URL}
            target="_blank"
            rel="noreferrer"
          >
            Learn more
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="boosted-supply-rates">
      <div className="boosted-supply-rates__bar">
        <div
          className="boosted-supply-rates__bar__segment boosted-supply-rates__bar__segment--base"
          style={{ flexGrow: baseShare }}
        ></div>
        <div
          className="boosted-supply-rates__bar__segment boosted-supply-rates__bar__segment--boost"
          style={{ flexGrow: boostShare }}
        ></div>
      </div>
      <div className="boosted-supply-rates__labels">
        <span className="L4 meta">
          <span className="boosted-supply-rates__labels__value">{formatRateFactor(earnAPR)}</span>
          <span className="text-color--2"> Base Interest</span>
        </span>
        <span className="L4 meta">
          <Bolt className="boosted-supply-rates__labels__bolt" />
          <span className="boosted-supply-rates__labels__value">{formatRateFactor(boostAPR)}</span>
          <span className="text-color--2"> {boostLabel}</span>
        </span>
      </div>
      {showWhitelistCard && whitelistCard}
    </div>
  );
};

export default BoostedSupplyRates;

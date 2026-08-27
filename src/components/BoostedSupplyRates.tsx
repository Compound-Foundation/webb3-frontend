import { Bolt } from '@components/Icons';
import { INSTITUTIONAL_BOOST_END_DATE } from '@helpers/institutionalRates';
import { InstitutionalWhitelistStatus } from '@helpers/institutionalWhitelist';
import { formatRateFactor } from '@helpers/numbers';
import { INSTITUTIONAL_MARKET_URL } from '@helpers/urls';

type BoostedSupplyRatesProps = {
  // The market's regular floating supply rate, at FACTOR_PRECISION
  earnAPR: bigint;
  // The institutional program's boost on top of the floating rate, at FACTOR_PRECISION
  boostAPR: bigint;
  whitelistStatus: InstitutionalWhitelistStatus;
};

/**
 * The boosted supply rate breakdown shown on institutional markets inside the
 * net rates overlay: a segmented bar splitting the net supply rate into base
 * interest and the boosted portion, and a whitelist card that either confirms
 * the connected address is whitelisted or invites it to get whitelisted.
 */
const BoostedSupplyRates = ({ earnAPR, boostAPR, whitelistStatus }: BoostedSupplyRatesProps) => {
  const totalAPR = earnAPR + boostAPR;
  // Segment widths are proportional to each component's share of the total,
  // floored so a small base rate still reads as a visible segment
  const boostShare = totalAPR > 0n ? Number((boostAPR * 100n) / totalAPR) : 0;
  const baseShare = 100 - boostShare;

  const whitelistCard =
    whitelistStatus === InstitutionalWhitelistStatus.Whitelisted ? (
      <div className="boosted-supply-rates__whitelist-card">
        <img
          className="boosted-supply-rates__whitelist-card__badge"
          src="/images/whitelist-badge.png"
          alt=""
        />
        <div>
          <p className="L3 body body--emphasized">You are earning boosted yield</p>
          <p className="boosted-supply-rates__whitelist-card__subtitle L4">
            Boosted yield applies until{' '}
            {INSTITUTIONAL_BOOST_END_DATE.toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
            .
          </p>
        </div>
      </div>
    ) : (
      <div className="boosted-supply-rates__whitelist-card">
        <div>
          <p className="L3 body body--emphasized">Get whitelisted to access the Net Earn APR</p>
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
          <span className="text-color--2"> Boosted APR</span>
        </span>
      </div>
      {whitelistCard}
    </div>
  );
};

export default BoostedSupplyRates;

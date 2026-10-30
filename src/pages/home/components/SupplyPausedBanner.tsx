const FORUM_URL = 'https://www.comp.xyz/t/compound-v3-supply-paused-across-major-markets/8203';

// Notice shown on the dashboard of every market during the Ethereum mainnet security incident.
// Remove this component and its use in the home page once supplies resume.
const SupplyPausedBanner = () => (
  <div className="extension-banner L4 body text-color--3">
    <p>
      All Compound V3 markets on Ethereum except WBTC Comet are now unpaused and fully operational. Supply, borrowing,
      and repayments are working as normal. Follow updates on the{' '}
      <a className="text-color--supply" target="_blank" rel="noopener noreferrer" href={FORUM_URL}>
        Compound forum
      </a>
      .
    </p>
  </div>
);

export default SupplyPausedBanner;

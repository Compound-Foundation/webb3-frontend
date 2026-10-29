const FORUM_URL = 'https://www.comp.xyz/t/compound-v3-supply-paused-across-major-markets/8203';

// Notice shown on the dashboard of every market during the Binance security incident.
// Remove this component and its use in the home page once supplies resume.
const SupplyPausedBanner = () => (
  <div className="extension-banner L4 body text-color--3">
    <p>
      New supplies to affected Compound markets are temporarily paused as a precaution following the reported security
      incident at Binance. Follow updates on the{' '}
      <a className="text-color--supply" target="_blank" rel="noopener noreferrer" href={FORUM_URL}>
        Compound forum
      </a>
      .
    </p>
  </div>
);

export default SupplyPausedBanner;

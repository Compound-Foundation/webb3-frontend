import { InactiveMarket } from '@components/Icons';

const InactiveMarketBanner = () => (
  <div className="inactive-market-banner">
    <InactiveMarket className="inactive-market-banner__icon" />
    <p className="inactive-market-banner__text">This market is inactive. New loans or deposits are currently disabled.</p>
  </div>
);

export default InactiveMarketBanner;

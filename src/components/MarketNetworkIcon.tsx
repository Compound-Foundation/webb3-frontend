import { assetIconForAssetSymbol } from '@helpers/assets';

import { V2 } from './Icons';

const MarketNetworkIcon = ({ icon, fixed, className }: { icon: string; fixed?: boolean; className?: string }) => {
  return (
    <div className={`icon ${fixed ? '' : 'icon--centered'} ${className}`}>
      {icon === 'V2' ? <V2 className="asset" /> : <span className={`asset asset--${assetIconForAssetSymbol(icon)}`} />}
    </div>
  );
};

export default MarketNetworkIcon;

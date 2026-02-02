import { assetIconForAssetSymbol } from '@helpers/assets';

const IconPair = ({ className = '', icon1, icon2 }: { className?: string; icon1: string; icon2: string }) => {
  return (
    <div className={`icon-pair ${className}`}>
      <span className={`asset asset--${assetIconForAssetSymbol(icon1)} icon-pair__item`} />
      <span className={`asset asset--${assetIconForAssetSymbol(icon2)} icon-pair__item`} />
    </div>
  );
};

export default IconPair;

import { assetIconForAssetSymbol } from '@helpers/assets';
import { Currency } from '@types';

export enum IconTextPairSize {
  XSmall = 'xsmall',
  Small = 'small',
  Medium = 'medium',
  Large = 'large',
}

const getTextSizeClass = (size: IconTextPairSize) => {
  switch (size) {
    case IconTextPairSize.XSmall:
      return 'meta L3';
    case IconTextPairSize.Small:
      return 'body L3';
    case IconTextPairSize.Medium:
      return 'heading heading--emphasized L4';
    case IconTextPairSize.Large:
      return 'heading heading--emphasized L2';
    default:
      return '';
  }
};

const IconTextPair = ({
  value,
  size,
  assetSymbol,
  currency,
  useSecondaryValueColor,
}: {
  value: string;
  size: IconTextPairSize;
  assetSymbol?: string;
  currency?: Currency;
  useSecondaryValueColor?: boolean;
}) => {
  const valueColorClass = useSecondaryValueColor ? 'text-color--3' : 'text-color--1';

  return (
    <div className="icon-text-pair">
      {assetSymbol && currency && currency !== Currency.USD && (
        <div className={`asset--${size} asset asset--${assetIconForAssetSymbol(assetSymbol)}`}></div>
      )}
      <span className={`${valueColorClass} ${getTextSizeClass(size)}`}>{value.replace(assetSymbol || '', '')}</span>
    </div>
  );
};

export default IconTextPair;

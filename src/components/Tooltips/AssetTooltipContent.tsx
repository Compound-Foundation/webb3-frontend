import {
  formatTokenBalance,
  formatRateFactor,
  getCapacity,
  PRICE_PRECISION,
  getTokenValue,
  formatValue,
  displayValue,
} from '@helpers/numbers';
import { BaseAssetWithAccountState, Currency, TokenWithAccountState, TokenWithState } from '@types';

type AssetTooltipContentProps = {
  asset: TokenWithState | TokenWithAccountState;
  baseAsset?: BaseAssetWithAccountState;
  currency: Currency;
  isHydrated?: boolean;
};

const AssetTooltipContent = ({ asset, baseAsset, currency, isHydrated = false }: AssetTooltipContentProps) => {
  let price = displayValue(PRICE_PRECISION, asset.price);

  let getContent = (price: string) => (
    <>
      <div className="tooltip__definition-list__item">
        <dt>Oracle Price</dt>
        <dd>{price}</dd>
      </div>
      <div className="tooltip__definition-list__item">
        <dt>Collateral Factor</dt>
        <dd>{formatRateFactor(asset.collateralFactor, 0, 0)}</dd>
      </div>
      <div className="tooltip__definition-list__item">
        <dt>Liquidation Factor</dt>
        <dd>{formatRateFactor(asset.liquidateCollateralFactor, 0, 0)}</dd>
      </div>
    </>
  );

  if (baseAsset !== undefined && isHydrated) {
    const assetWithAccountState = asset as TokenWithAccountState;
    const { symbol, baseAssetPriceInDollars } = baseAsset;
    const oraclePriceInDollars = getTokenValue(asset.price, currency, baseAssetPriceInDollars, symbol);
    price = formatTokenBalance(PRICE_PRECISION, oraclePriceInDollars, false, currency);

    const balance = formatValue(assetWithAccountState.decimals, assetWithAccountState.balance);
    const rawBorrowCapacity = getCapacity('borrow', baseAsset.decimals, baseAsset.price, baseAsset.symbol, [
      assetWithAccountState,
    ]);
    const borrowCapacityValue = getTokenValue(rawBorrowCapacity, currency, baseAssetPriceInDollars, symbol);
    const borrowCapacity = formatTokenBalance(baseAsset.decimals, borrowCapacityValue, false, currency);
    const walletBalance = formatValue(assetWithAccountState.decimals, assetWithAccountState.walletBalance);

    const rawBorrowPotential = getCapacity('borrow', baseAsset.decimals, baseAsset.price, baseAsset.symbol, [
      { ...assetWithAccountState, balance: assetWithAccountState.walletBalance },
    ]);
    const borrowPotentialValue = getTokenValue(rawBorrowPotential, currency, baseAssetPriceInDollars, symbol);
    const borrowPotential = formatTokenBalance(baseAsset.decimals, borrowPotentialValue, false, currency);

    getContent = (price) => (
      <>
        <div className="tooltip__definition-list__item">
          <dt>Oracle Price</dt>
          <dd>{price}</dd>
        </div>
        <div className="tooltip__definition-list__item">
          <dt>Collateral Factor</dt>
          <dd>{formatRateFactor(asset.collateralFactor, 0, 0)}</dd>
        </div>
        <div className="tooltip__definition-list__item">
          <dt>Liquidation Factor</dt>
          <dd>{formatRateFactor(asset.liquidateCollateralFactor, 0, 0)}</dd>
        </div>
        <div className="divider"></div>
        <div className="tooltip__definition-list__item">
          <dt>Protocol Balance</dt>
          <dd>{balance}</dd>
        </div>
        <div className="tooltip__definition-list__item">
          <dt>Borrow Capacity</dt>
          <dd>{borrowCapacity}</dd>
        </div>
        <div className="divider"></div>
        <div className="tooltip__definition-list__item">
          <dt>Wallet Balance</dt>
          <dd>{walletBalance}</dd>
        </div>
        <div className="tooltip__definition-list__item">
          <dt>Borrow Potential</dt>
          <dd>{borrowPotential}</dd>
        </div>
      </>
    );
  }

  return (
    <div className="tooltip__content L4">
      <h4 className="tooltip__header body--emphasized text-color--1">{asset.name}</h4>
      <dl className="tooltip__definition-list body">{getContent(price)}</dl>
    </div>
  );
};

export default AssetTooltipContent;

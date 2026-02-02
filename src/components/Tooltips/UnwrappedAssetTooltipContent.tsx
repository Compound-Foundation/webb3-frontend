import {
  formatTokenBalance,
  formatRateFactor,
  getCapacity,
  PRICE_PRECISION,
  getTokenValue,
  formatValue,
  displayValue,
} from '@helpers/numbers';
import { BaseAssetWithAccountState, Currency, TokenWithAccountState } from '@types';

type UnwrappedAssetTooltipContentProps = {
  asset: TokenWithAccountState;
  baseAsset: BaseAssetWithAccountState;
  wrappedAsset: TokenWithAccountState;
  currency: Currency;
};

const UnwrappedAssetTooltipContent = ({
  asset,
  baseAsset,
  wrappedAsset,
  currency,
}: UnwrappedAssetTooltipContentProps) => {
  let price = displayValue(PRICE_PRECISION, asset.price);

  const assetWithAccountState = asset;
  const { symbol, baseAssetPriceInDollars } = baseAsset;
  const oraclePriceInDollars = getTokenValue(asset.price, currency, baseAssetPriceInDollars, symbol);
  price = formatTokenBalance(PRICE_PRECISION, oraclePriceInDollars, false, currency);

  const walletBalance = formatValue(assetWithAccountState.decimals, assetWithAccountState.walletBalance);

  const rawBorrowPotential = getCapacity('borrow', baseAsset.decimals, baseAsset.price, baseAsset.symbol, [
    { ...assetWithAccountState, balance: assetWithAccountState.walletBalance },
  ]);
  const borrowPotentialValue = getTokenValue(rawBorrowPotential, currency, baseAssetPriceInDollars, symbol);
  const borrowPotential = formatTokenBalance(baseAsset.decimals, borrowPotentialValue, false, currency);

  let wrappedAssetPrice = '';
  let [exchangeRatewholeNumber, exchangeRatefractionalNumber] = ['1', '0000'];
  if (wrappedAsset !== undefined) {
    const wrappedAssetPriceInDollars = getTokenValue(
      wrappedAsset.price,
      currency,
      baseAssetPriceInDollars,
      wrappedAsset.symbol
    );
    wrappedAssetPrice = formatTokenBalance(PRICE_PRECISION, wrappedAssetPriceInDollars, false, currency);

    const wstEthPerStEth = (asset.price * BigInt(10 ** wrappedAsset.decimals)) / wrappedAsset.price;
    [exchangeRatewholeNumber, exchangeRatefractionalNumber] = displayValue(wrappedAsset.decimals, wstEthPerStEth).split(
      '.'
    );
  }

  const getContent = () => (
    <>
      <div className="tooltip__definition-list__item">
        <dt>Oracle Price</dt>
        <dd>{price}</dd>
      </div>
      <div className="tooltip__definition-list__item tooltip__definition-list--short-description">
        <dt>Exchange Rate</dt>
        <dd>
          1&nbsp;
          <span className="text-color--3">{asset.symbol} =</span>
          &nbsp;{exchangeRatewholeNumber}
          <span className="text-color--3">
            .{exchangeRatefractionalNumber} {wrappedAsset?.symbol}
          </span>
        </dd>
      </div>
      <div className="tooltip__definition-list__item yield-bearing-asset-msg">
        {'Rebasing tokens are automatically wrapped when supplied to Compound to enable yield on protocol balances.'}
      </div>
      {wrappedAsset && (
        <>
          <div className="divider"></div>
          <div className="tooltip__definition-list__item">
            <dt>{wrappedAsset.symbol} Oracle Price</dt>
            <dd>{wrappedAssetPrice}</dd>
          </div>
          <div className="tooltip__definition-list__item">
            <dt>{wrappedAsset.symbol} Collateral Factor</dt>
            <dd>{formatRateFactor(asset.collateralFactor, 0, 0)}</dd>
          </div>
          <div className="tooltip__definition-list__item">
            <dt>{wrappedAsset.symbol} Liquidation Factor</dt>
            <dd>{formatRateFactor(wrappedAsset.liquidateCollateralFactor, 0, 0)}</dd>
          </div>
        </>
      )}
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

  return (
    <div className="tooltip__content L4">
      <h4 className="tooltip__header body--emphasized text-color--1">{asset.name}</h4>
      <dl className="tooltip__definition-list body">{getContent()}</dl>
    </div>
  );
};

export default UnwrappedAssetTooltipContent;

import CircleMeter from '@components/CircleMeter';
import IconTextPair, { IconTextPairSize } from '@components/IconTextPair';
import Tooltip from '@components/Tooltip';
import { assetIconForAssetSymbol } from '@helpers/assets';
import {
  formatTokenBalance,
  formatRateFactor,
  PRICE_PRECISION,
  getRiskLevelAndPercentage,
  getTokenValue,
} from '@helpers/numbers';
import { BaseAssetWithState, Currency, StateType, Token, TokenWithMarketState } from '@types';

type AssetRowLoading = [StateType.Loading];
type AssetRowHydrated = [StateType.Hydrated, TokenWithMarketState, BaseAssetWithState];

export type AssetRowState = AssetRowLoading | AssetRowHydrated;

const LoadingAssetRow = () => {
  return (
    <tr className="assets-table__row">
      <td className="assets-table__row__asset-icon">
        <span className="asset asset-icon">
          <span className="placeholder-content placeholder-content--circle"></span>
        </span>
      </td>
      <td className="assets-table__row__asset-identity">
        <span className="placeholder-content" style={{ width: '70%' }}></span>
      </td>
      <td className="assets-table__row__total-supply">
        <span className="placeholder-content" style={{ width: '70%' }}></span>
      </td>
      <td className="assets-table__row__oracle-price">
        <span className="placeholder-content" style={{ width: '70%' }}></span>
      </td>
      <td className="assets-table__row__reserves">
        <span className="placeholder-content" style={{ width: '70%' }}></span>
      </td>
      <td className="assets-table__row__collateral-factor">
        <span className="placeholder-content" style={{ width: '70%' }}></span>
      </td>
      <td className="assets-table__row__liquidation-factor">
        <span className="placeholder-content" style={{ width: '70%' }}></span>
      </td>
      <td className="assets-table__row__liquidation-penalty">
        <span className="placeholder-content" style={{ width: '70%' }}></span>
      </td>
    </tr>
  );
};

// could potentially re-used in other tooltip content and even reward wallet, ask design to standardize it.
const TooltipLabelTextRow = ({
  label,
  data,
  baseAssetSymbol,
  currency,
}: {
  label: string;
  data: string;
  baseAssetSymbol: string;
  currency: Currency;
}) => {
  return (
    <div className="label-text-row">
      <label className="meta L4 text-color--2">{label}</label>
      <div className="meta L3 text-color--1">
        <IconTextPair value={data} assetSymbol={baseAssetSymbol} currency={currency} size={IconTextPairSize.XSmall} />
      </div>
    </div>
  );
};

type FormattedState = {
  asset: Token;
  collateralFactor: string;
  liquidationFactor: string;
  liquidationPenalty: string;
  price: string;
  reserves: string;
  supplyCap: string;
  totalSupply: string;
  availableSupplyCap: string;
};

function getFormattedState(
  asset: TokenWithMarketState,
  currency: Currency,
  baseAsset: BaseAssetWithState
): FormattedState {
  const {
    collateralFactor,
    decimals,
    liquidateCollateralFactor,
    liquidationPenalty,
    price,
    reserves,
    totalSupply,
    supplyCap,
  } = asset;

  const formattedCollateralFactor = formatRateFactor(collateralFactor, 0, 0);
  const formattedLiquidationFactor = formatRateFactor(liquidateCollateralFactor, 0, 0);
  const formattedLiquidationPenalty = formatRateFactor(liquidationPenalty, 0, 0);

  const totalSupplyValue = getTokenValue(
    totalSupply * price,
    currency,
    baseAsset.baseAssetPriceInDollars,
    baseAsset.symbol
  );

  const supplyCapValue = getTokenValue(
    supplyCap * price,
    currency,
    baseAsset.baseAssetPriceInDollars,
    baseAsset.symbol
  );

  const availableSupplyCapValue = getTokenValue(
    (supplyCap - totalSupply) * price,
    currency,
    baseAsset.baseAssetPriceInDollars,
    baseAsset.symbol
  );

  const reserveValue = getTokenValue(reserves * price, currency, baseAsset.baseAssetPriceInDollars, baseAsset.symbol);
  const tokenPriceInDollars = getTokenValue(price, currency, baseAsset.baseAssetPriceInDollars, baseAsset.symbol);

  return {
    asset,
    collateralFactor: formattedCollateralFactor,
    liquidationFactor: formattedLiquidationFactor,
    liquidationPenalty: formattedLiquidationPenalty,
    price: formatTokenBalance(PRICE_PRECISION, tokenPriceInDollars, false, currency),
    reserves: formatTokenBalance(decimals + PRICE_PRECISION, reserveValue, true, currency),
    supplyCap: formatTokenBalance(decimals + PRICE_PRECISION, supplyCapValue, true, currency),
    totalSupply: formatTokenBalance(decimals + PRICE_PRECISION, totalSupplyValue, true, currency),
    availableSupplyCap: formatTokenBalance(decimals + PRICE_PRECISION, availableSupplyCapValue, true, currency),
  };
}

export type AssetRowProps = {
  state: AssetRowState;
};

enum SupplyCapData {
  Total = 'Total Capacity',
  Supplied = 'Total Supplied',
  Remain = 'Remaining Capacity',
}

const AssetsTableRow = ({ state }: AssetRowProps) => {
  const currency = Currency.USD;
  const [stateType] = state;
  if (stateType === StateType.Loading) {
    return <LoadingAssetRow />;
  }

  const tokenWithMarketState = state[1];
  const baseAsset = state[2];
  const {
    asset,
    collateralFactor,
    liquidationFactor,
    liquidationPenalty,
    price,
    reserves,
    supplyCap,
    totalSupply,
    availableSupplyCap,
  } = getFormattedState(tokenWithMarketState, currency, baseAsset);

  const [, , percentageFill] = getRiskLevelAndPercentage(
    tokenWithMarketState.totalSupply,
    tokenWithMarketState.supplyCap
  );

  const isZeroDollars = (currency: Currency, value: string) =>
    currency && currency === Currency.USD && value === '$0.00';

  return (
    <tr className="assets-table__row">
      <td className="assets-table__row__asset-icon">
        <span className={`asset asset--${assetIconForAssetSymbol(asset.symbol)}`}></span>
      </td>
      <td className="assets-table__row__asset-identity">
        <div className="body">{asset.name}</div>
        <div className="meta text-color--2">{asset.symbol}</div>
      </td>
      <td className="body assets-table__row__total-supply">
        <Tooltip
          content={
            <div className="tooltip__content L4">
              <div className="tooltip__header">
                <h4 className="body--emphasized">
                  {asset.symbol} Supply Cap
                  <span className="text-color--2 tooltip__header__main-value">{percentageFill}</span>
                </h4>
              </div>
              <p className="body meta L4 text-color--2 tooltip__content__warning-message">
                To mitigate risk, collateral assets are subject to supply caps set by the community.
              </p>

              <TooltipLabelTextRow
                label={SupplyCapData.Total}
                data={supplyCap}
                baseAssetSymbol={baseAsset.symbol}
                currency={currency}
              />
              <TooltipLabelTextRow
                label={SupplyCapData.Supplied}
                data={totalSupply}
                baseAssetSymbol={baseAsset.symbol}
                currency={currency}
              />
              <div className="divider"></div>
              <TooltipLabelTextRow
                label={SupplyCapData.Remain}
                data={availableSupplyCap}
                baseAssetSymbol={baseAsset.symbol}
                currency={currency}
              />
            </div>
          }
          width={320}
          hideArrow={true}
          yOffset={15}
        >
          <div className="tooltip__trigger">
            <IconTextPair
              value={totalSupply}
              assetSymbol={baseAsset.symbol}
              currency={currency}
              size={IconTextPairSize.Small}
              useSecondaryValueColor={isZeroDollars(currency, totalSupply)}
            />
            <CircleMeter percentageFill={percentageFill} />
          </div>
        </Tooltip>
      </td>
      <td className="body assets-table__row__reserves">
        <IconTextPair
          value={reserves}
          assetSymbol={baseAsset.symbol}
          currency={currency}
          size={IconTextPairSize.Small}
          useSecondaryValueColor={isZeroDollars(currency, reserves)}
        />
      </td>
      <td className="body assets-table__row__oracle-price">
        <IconTextPair
          value={price}
          assetSymbol={baseAsset.symbol}
          currency={currency}
          size={IconTextPairSize.Small}
          useSecondaryValueColor={isZeroDollars(currency, price)}
        />
      </td>
      <td className="body assets-table__row__collateral-factor">{collateralFactor}</td>
      <td className="body assets-table__row__liquidation-factor">{liquidationFactor}</td>
      <td className="body assets-table__row__liquidation-penalty">{liquidationPenalty}</td>
    </tr>
  );
};

export default AssetsTableRow;

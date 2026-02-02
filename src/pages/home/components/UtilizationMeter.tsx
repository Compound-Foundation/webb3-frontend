import Tooltip from '@components/Tooltip';
import { useCurrencyContext } from '@contexts/CurrencyContext';
import { adjustValueForAeroAsset } from '@helpers/baseAssetPrice';
import {
  formatTokenBalance,
  getLiquidationPoint,
  getRiskLevelAndPercentage,
  getTokenValue,
  PRICE_PRECISION,
} from '@helpers/numbers';
import { BaseAssetWithAccountState, StateType } from '@types';

type UtilizationMeterLoading = [StateType.Loading];

type UtilizationMeterNoWallet = [StateType.NoWallet];

type UtilizationMeterHydrated = [
  StateType.Hydrated,
  {
    baseAsset: BaseAssetWithAccountState;
    collateralValue: bigint;
    liquidationCapacity: bigint;
  }
];

export type UtilizationMeterState = UtilizationMeterLoading | UtilizationMeterNoWallet | UtilizationMeterHydrated;

type UtilizationMeterProps = {
  state: UtilizationMeterState;
};

const UtilizationMeter = ({ state }: UtilizationMeterProps) => {
  const [stateType] = state;
  const { currency } = useCurrencyContext();

  if (stateType === StateType.Loading || stateType === StateType.NoWallet) {
    return null;
  }
  const { baseAsset, collateralValue, liquidationCapacity } = state[1];

  if (baseAsset.borrowCapacity === 0n) {
    return null;
  }

  const valueInUsd = (capacity: bigint) => (capacity * baseAsset.price) / BigInt(10 ** baseAsset.decimals);

  const borrowBalance = baseAsset.balance < 0n ? -baseAsset.balance : 0n;
  const borrowValue = valueInUsd(borrowBalance);
  const borrowCapacityValue = getTokenValue(
    adjustValueForAeroAsset(baseAsset.borrowCapacity, baseAsset.symbol, baseAsset.price),
    currency,
    baseAsset.baseAssetPriceInDollars,
    baseAsset.symbol
  );
  const borrowCapacity = formatTokenBalance(baseAsset.decimals + PRICE_PRECISION, borrowCapacityValue, false, currency);

  const liquidationCapacityValue = valueInUsd(liquidationCapacity);
  const [riskLevel, percentage] = getRiskLevelAndPercentage(borrowValue, liquidationCapacityValue);
  const [, borrowCapacityPercentage] = getRiskLevelAndPercentage(
    valueInUsd(baseAsset.borrowCapacity),
    liquidationCapacityValue
  );

  const liquidationPoint = getLiquidationPoint(collateralValue, percentage);
  const formattedCollateralValue = formatTokenBalance(PRICE_PRECISION, collateralValue, true, currency);
  const formattedLiquidationPoint = formatTokenBalance(PRICE_PRECISION, liquidationPoint, true, currency);
  const formattedDifference = formatTokenBalance(PRICE_PRECISION, collateralValue - liquidationPoint, true, currency);

  const endOfMeter =
    percentage < borrowCapacityPercentage ? (
      <>
        <div
          className={`utilization-meter__segment utilization-meter__segment--${riskLevel}`}
          style={{ width: percentage + '%' }}
        ></div>
        <div className="utilization-meter__percent meta">{percentage + '%'}</div>
        <div
          className="utilization-meter__segment"
          style={{ width: borrowCapacityPercentage - percentage + '%' }}
        ></div>
        <Tooltip
          content={
            <div className="tooltip__content L4">
              <div className="tooltip__header">
                <h4 className="body--emphasized">
                  Borrow Capacity <span className="text-color--2 tooltip__header__main-value">{borrowCapacity}</span>
                </h4>
              </div>
              <p className="body">
                This is the initial limit for new borrowing, and is below the liquidation point (100%).
              </p>
            </div>
          }
          width={250}
        >
          <div className="utilization-meter__dot">
            <div className="utilization-meter__dot__label utilization-meter__dot__label--borrow-capacity meta">
              <span className="tooltip__text-trigger">Borrow Capacity</span>
            </div>
          </div>
        </Tooltip>
        <div className="utilization-meter__segment" style={{ width: 100 - borrowCapacityPercentage + '%' }}></div>
      </>
    ) : (
      <>
        <div
          className={`utilization-meter__segment utilization-meter__segment--${riskLevel}`}
          style={{ width: borrowCapacityPercentage + '%' }}
        ></div>
        <Tooltip
          content={
            <div className="tooltip__content L4">
              <div className="tooltip__header">
                <h4 className="body--emphasized">
                  Borrow Capacity <span className="text-color--2 tooltip__header__main-value">{borrowCapacity}</span>
                </h4>
              </div>
              <p className="body">
                This is the initial limit for new borrowing, and is below the liquidation point (100%)
              </p>
            </div>
          }
          width={270}
        >
          <div className="utilization-meter__dot">
            <div className="utilization-meter__dot__label utilization-meter__dot__label--borrow-capacity meta">
              <span className="tooltip__text-trigger">Borrow Capacity</span>
            </div>
          </div>
        </Tooltip>
        <div
          className={`utilization-meter__segment utilization-meter__segment--${riskLevel}`}
          style={{ width: percentage - borrowCapacityPercentage + '%' }}
        ></div>
        <div className="utilization-meter__percent meta">{percentage + '%'}</div>
        <div className="utilization-meter__segment" style={{ width: 100 - percentage + '%' }}></div>
      </>
    );

  return (
    <div className="utilization-meter L2">
      <div className="utilization-meter__text meta">
        <Tooltip
          content={
            <div className="tooltip__content L4">
              <div className="tooltip__header">
                <h4 className="body--emphasized">
                  Liquidation Risk <span className="text-color--2 tooltip__header__main-value">{`${percentage}%`}</span>
                </h4>
              </div>
              <p className="body">
                {`Liquidation occurs when your Collateral Value ${formattedCollateralValue} reaches the Liquidation Point
                ${formattedLiquidationPoint}. Your collateral can decrease in price by ${formattedDifference} before
                liquidation.`}
              </p>
            </div>
          }
          width={270}
        >
          <span className="tooltip__text-trigger">Liquidation Risk</span>
        </Tooltip>
      </div>
      {endOfMeter}
    </div>
  );
};

export default UtilizationMeter;

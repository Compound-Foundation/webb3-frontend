import { Currency, MeterRiskLevel, TokenWithAccountState, BaseAsset, BaseAssetWithAccountState } from '@types';

import { adjustValueForAeroAsset } from './baseAssetPrice';

export const FACTOR_PRECISION = 18;
export const PRICE_PRECISION = 8;
export const BASE_FACTOR = BigInt(10 ** FACTOR_PRECISION);
export const PRICE_SCALE = BigInt(10 ** PRICE_PRECISION);
export const BORROW_MAX_SCALE = 0.9999;
export const MAX_UINT256 = BigInt('115792089237316195423570985008687907853269984665640564039457584007913129639935');
export const REFRESH_INTERVAL = 40_000;
export const REWARDS_API_REFRESH_INTERVAL = 120_000;
export const TRX_REFRESH_INTERVAL = 20_000;

const BILLION = 1_000_000_000;
const MILLION = 1_000_000;
const HUNDRED_THOUSAND = 100_000;
const THOUSAND = 1_000;

// Number of decimals to show for a token balance of a particular currency.
const CURRENCY_DECIMALS_MAP: { [key: string]: number } = {
  USDC: 4,
  USD: 2,
  ETH: 4,
  WETH: 4,
  DEFAULT: 2,
};

const getCurrencySuffix = (currency: Currency | undefined) => {
  let currencySuffix = '';
  switch (currency) {
    case Currency.ETH:
      currencySuffix = ' ETH';
      break;
    case Currency.USDC:
      currencySuffix = ' USDC';
      break;
    case Currency.AERO:
      currencySuffix = ' AERO';
      break;
    case Currency.WBTC:
      currencySuffix = ' WBTC';
      break;
    case Currency.RON:
      currencySuffix = ' RON';
      break;
    case Currency.WETH:
      currencySuffix = ' WETH';
      break;
  }
  return currencySuffix;
};

export const shouldShowValueInBaseAsset = (baseAssetSymbol: Currency, currencyFlag: Currency) => {
  return baseAssetSymbol === currencyFlag;
};

export const getTokenDecimals = (currency: Currency, baseAssetToUse: BaseAsset) => {
  if (currency === 'USD') {
    return baseAssetToUse.decimals + PRICE_PRECISION;
  } else {
    return baseAssetToUse.decimals;
  }
};

// TODO: Refactor formatTokenBalance & getTokenValue
// This function considers currency toggle state and return the balance value either in baseAsset or usd value
export const getTokenValue = (
  value: bigint,
  currency: Currency,
  baseAssetPriceInDollarBitInt: bigint,
  baseAssetSymbol: string
) => {
  const baseAssetPriceInDollars = Number(baseAssetPriceInDollarBitInt) / 10 ** 8;
  let v = Number(value);
  if (currency === Currency.USD && baseAssetSymbol === 'RON') {
    return value;
  } else if (currency === Currency.USD && baseAssetSymbol !== 'USDC') {
    v *= baseAssetPriceInDollars;
    return BigInt(Math.round(v));
  } else if (currency === Currency.USDC && baseAssetSymbol === 'USDC') {
    v /= baseAssetPriceInDollars;
    return BigInt(Math.round(v));
  } else if (currency === Currency.RON && baseAssetSymbol === 'RON') {
    v *= baseAssetPriceInDollars;
    return BigInt(Math.round(v));
  }
  return value;
};

export const getValueInDollars = (value: bigint, baseAsset: BaseAssetWithAccountState) => {
  const { baseAssetPriceInDollars: baseAssetPriceInDollarBitInt, symbol } = baseAsset;
  const baseAssetPriceInDollars = Number(baseAssetPriceInDollarBitInt) / 10 ** 8;
  const v = Number(value);
  if (symbol === 'USDC') return value;
  if (symbol === 'AERO' || symbol === 'RON') return BigInt(Math.round(v));
  return BigInt(Math.round(v * baseAssetPriceInDollars));
};

export const getValueInBaseAsset = (value: bigint, baseAsset: BaseAssetWithAccountState) => {
  const { baseAssetPriceInDollars: baseAssetPriceInDollarBitInt, symbol } = baseAsset;
  const baseAssetPriceInDollars = Number(baseAssetPriceInDollarBitInt) / 10 ** 8;
  const v = Number(value);

  if (symbol === 'USDC') return BigInt(Math.round(v / baseAssetPriceInDollars));
  return value;
};

export const calculateRoundedUnit = (tokenDecimals: number, value: bigint, formatPrecision: number) => {
  const baseUnit = BigInt(10 ** tokenDecimals);
  const scale = 10 ** (formatPrecision + 1);

  const units = Number((value * BigInt(scale)) / baseUnit) / scale;
  const roundingScale = 10 ** formatPrecision;
  const roundedUnits = Math.round(units * roundingScale) / roundingScale;
  return roundedUnits;
};
// no format, just display token balance with 4 decimals for balance < 1B, and abbreviate with B when > 1B
// this function replace the scenarios when shorten is false and no currency is passed in
export const displayValue = (tokenDecimals: number, value: bigint): string => {
  const formatPrecision = 4;
  const roundedUnits = calculateRoundedUnit(tokenDecimals, value, formatPrecision);
  // but if the value is bigger than 1.000B then we still shorten it
  if (roundedUnits < BILLION) {
    return `${roundedUnits.toLocaleString('en-US', {
      minimumFractionDigits: formatPrecision,
      maximumFractionDigits: formatPrecision,
    })}`;
  } else {
    // format balance for >= 1B
    const shortenedUnits = roundedUnits / BILLION;
    const postfix = 'B';
    return `${shortenedUnits.toLocaleString('en-US', {
      minimumFractionDigits: formatPrecision,
      maximumFractionDigits: formatPrecision,
    })}${postfix}`;
  }
};

// this function replace the scenarios when shorten is not passed in hence defaulted to true in original formatTokenBalance and no currency is passed in, here is formatting due to space limit in the component
export const formatValue = (tokenDecimals: number, value: bigint): string => {
  const formatPrecision = 4;
  const roundedUnits = calculateRoundedUnit(tokenDecimals, value, formatPrecision);
  return formatUnits(roundedUnits);
};

// this function shorten the token display with currency suffix and is used in non-header elements which typically have limited UI space
export const formatValueInCurrency = (tokenDecimals: number, value: bigint, currency: Currency): string => {
  const formatPrecision = 4;
  const roundedUnits = calculateRoundedUnit(tokenDecimals, value, formatPrecision);
  return formatUnits(roundedUnits, currency);
};

// we know currencyFlag is USD and shorten is true
export const formatValueInDollars = (tokenDecimals: number, value: bigint): string => {
  const formatPrecision = 2;
  const roundedUnits = calculateRoundedUnit(tokenDecimals, value, formatPrecision);
  return formatUnits(roundedUnits, Currency.USD);
};

export const formatTokenBalance = (
  tokenDecimals: number,
  value: bigint,
  shortened = true,
  currency?: Currency
): string => {
  // if currency is usd, need to convert to dollar by multiple the baseAsset/USD price feed
  const baseUnit = BigInt(10 ** tokenDecimals);
  // When currency is not explicitly passed in, it's used in many places like
  // the action input UI, where we want to show more decimals.
  const formatPrecision: number =
    currency === undefined ? 4 : CURRENCY_DECIMALS_MAP[currency as string] ?? CURRENCY_DECIMALS_MAP['DEFAULT'];
  const scale = 10 ** (formatPrecision + 1);

  const units = Number((value * BigInt(scale)) / baseUnit) / scale;
  const roundingScale = 10 ** formatPrecision;
  const roundedUnits = Math.round(units * roundingScale) / roundingScale;
  const prefix = currency === Currency.USD ? '$' : '';
  const currencySuffix = getCurrencySuffix(currency);

  // but if the value is bigger than 1.000B then we still shorten it
  if (!shortened && roundedUnits < BILLION) {
    return `${prefix}${roundedUnits.toLocaleString('en-US', {
      minimumFractionDigits: formatPrecision,
      maximumFractionDigits: formatPrecision,
    })}${currencySuffix}`;
  }
  return formatUnits(roundedUnits, currency);
};

export const formatUnits = (units: number, currency?: Currency) => {
  const prefix = currency === Currency.USD ? '$' : '';
  const currencySuffix = getCurrencySuffix(currency);
  let shortenedUnits: number;
  let postfix: string;
  let minimumFractionDigits = currency ? 2 : 4;
  let formatPrecision: number = currency ? 2 : 4;

  if (units >= BILLION) {
    shortenedUnits = units / BILLION;
    postfix = 'B';
    minimumFractionDigits = currency !== 'USD' ? 4 : 2;
    formatPrecision = currency !== 'USD' ? 4 : 2;
  } else if (units >= MILLION) {
    shortenedUnits = units / MILLION;
    postfix = 'M';
  } else if (units >= HUNDRED_THOUSAND) {
    shortenedUnits = units / THOUSAND;
    postfix = 'K';
  } else {
    shortenedUnits = units;
    postfix = '';
    // for base asset when < 100K, use 4 decimals
    minimumFractionDigits = currency !== 'USD' ? 4 : 2;
    formatPrecision = currency !== 'USD' ? 4 : 2;
  }

  return `${prefix}${shortenedUnits.toLocaleString('en-US', {
    minimumFractionDigits,
    maximumFractionDigits: formatPrecision,
  })}${postfix}${currencySuffix}`;
};

export const formatUnitsWithTruncation = ({ amount }: { amount: string }) => {
  let digits = 4;
  // the amount is either an interger or have all 0 decimals, we format with no decimals, or else with 4 decimals
  if ((amount.split('.')[1] || '').match(/^[0]*$/) !== null) {
    digits = 0;
  }
  return `${Number(amount).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
};

export const formatRateFactor = (value: bigint, maximumFractionDigits = 2, minimumFractionDigits = 2): string => {
  const rate = Number((value * 10_000n) / BASE_FACTOR) / 100;

  return `${rate.toLocaleString('en-US', {
    maximumFractionDigits,
    minimumFractionDigits,
  })}%`;
};

export const formatRate = (value: number, maximumFractionDigits = 2, minimumFractionDigits = 2): string => {
  const rate = value * 100;

  return `${rate.toLocaleString('en-US', {
    maximumFractionDigits,
    minimumFractionDigits,
  })}%`;
};

export const normalizePrice = (value: bigint): number => Number((value * PRICE_SCALE) / PRICE_SCALE) / 1e8;

export const getCapacity = (
  capacity: 'borrow' | 'liquidation',
  baseAssetDecimals: number,
  baseAssetPrice: bigint,
  baseAssetSymbol: string,
  collateralAssets: TokenWithAccountState[]
): bigint => {
  const sum = collateralAssets.reduce(
    (acc, { balance, collateralFactor, decimals, liquidateCollateralFactor, price }) => {
      const dollarValue = (balance * price) / BigInt(10 ** decimals);
      const factor = capacity === 'borrow' ? collateralFactor : liquidateCollateralFactor;
      const borrowValue = (dollarValue * factor) / BASE_FACTOR;
      return acc + borrowValue;
    },
    BigInt(0)
  );
  return (sum * BigInt(10 ** baseAssetDecimals)) / adjustValueForAeroAsset(BigInt(1), baseAssetSymbol, baseAssetPrice);
};

export const getRewardsAPR = (
  rewardsAssetPrice: bigint,
  baseAssetPrice: bigint,
  baseAssetDecimals: number,
  totalBase: bigint,
  speed: bigint,
  trackingIndexScale: bigint
): bigint => {
  const totalBaseUSD = normalizePrice((baseAssetPrice * totalBase) / BigInt(10 ** baseAssetDecimals));
  const rewardsUSDPerDay = normalizePrice((rewardsAssetPrice * speed * 86400n) / trackingIndexScale);
  const rewardsAPR = (rewardsUSDPerDay / totalBaseUSD) * 365;
  return BigInt(rewardsAPR * Number(BASE_FACTOR));
};

export const getRewardsPerYear = (speed: bigint, trackingIndexScale: bigint, rewardDecimals: number): bigint => {
  return (speed * BigInt(10 ** rewardDecimals) * 86400n * 365n) / trackingIndexScale;
};

export const getCollateralValue = (collateralAssets: TokenWithAccountState[]): bigint => {
  return collateralAssets.reduce(
    (acc, { balance, decimals, price }) => acc + (balance * price) / BigInt(10 ** decimals),
    BigInt(0)
  );
};

export const getLiquidationPoint = (collateralValue: bigint, riskPercentage: number): bigint => {
  return (collateralValue * BigInt(Math.min(100, riskPercentage))) / 100n;
};

export const getRiskLevelAndPercentage = (numerator: bigint, denominator: bigint): [MeterRiskLevel, number, string] => {
  const percentage = denominator === 0n ? 0 : Math.round(Number((numerator * 10_000n) / denominator) / 100);
  let riskLevel: MeterRiskLevel;

  if (percentage > 80) {
    riskLevel = MeterRiskLevel.High;
  } else if (percentage > 60) {
    riskLevel = MeterRiskLevel.Medium;
  } else {
    riskLevel = MeterRiskLevel.Low;
  }

  const percentageFill = percentage > 100 ? '100%' : percentage < 0 ? '0%' : `${percentage}%`;
  return [riskLevel, percentage, percentageFill];
};

export function exp(i: number, d = 0, r = 6): bigint {
  return (BigInt(Math.floor(i * 10 ** Number(r))) * 10n ** BigInt(d)) / 10n ** BigInt(r);
}

export const takePercentage = (x: bigint, percentage: number): bigint => {
  const percentageFactor = exp(percentage, FACTOR_PRECISION);
  return (x * percentageFactor) / BASE_FACTOR;
};

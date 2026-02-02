import {
  formatTokenBalance,
  formatRateFactor,
  normalizePrice,
  getTokenValue,
  getValueInDollars,
  getValueInBaseAsset,
  displayValue,
  formatValue,
  formatValueInDollars,
  shouldShowValueInBaseAsset,
  formatValueInCurrency,
  formatUnitsWithTruncation,
} from '@helpers/numbers';
import { Currency } from '@types';

describe('formatTokenBalance', () => {
  it('should return the correct value for a token with decimals of 6', () => {
    const result = formatTokenBalance(6, BigInt(1e6));
    expect(result).toEqual('1.0000');
  });

  it('should return the correct value for a token with decimals of 6 and not shortened', () => {
    const result = formatTokenBalance(6, BigInt(44_500_000e6), false);
    expect(result).toEqual('44,500,000.0000');
  });

  it('should return the correct shortened value for values under 1000', () => {
    const result = formatTokenBalance(6, BigInt(104.56e6));
    expect(result).toEqual('104.5600');
  });

  it('should return the correct shortened value for values over 999 and under 100,000', () => {
    const result = formatTokenBalance(6, BigInt(3004.18e6));
    expect(result).toEqual('3,004.1800');
  });

  it('should return the correct shortened value for values over 99,999 and under 1,000,000', () => {
    const result = formatTokenBalance(6, BigInt(104_500e6));
    expect(result).toEqual('104.5000K');
  });

  it('should return the correct shortened value for values over 1,000,000', () => {
    const result = formatTokenBalance(6, BigInt(1_170_000e6));
    expect(result).toEqual('1.1700M');
  });

  it('should return the correct shortened value for values over 1,000,000,000', () => {
    const result = formatTokenBalance(6, BigInt(2_195_000_000e6));
    expect(result).toEqual('2.1950B');
  });
});

describe('getTokenValue', () => {
  it('should return the ETH balance value in USD when toggled currency is USD ', () => {
    const result = getTokenValue(2n, Currency.USD, 150000000000n, 'ETH');
    expect(result).toEqual(3000n);
  });

  it('should return the ETH balance value in ETH when toggled currency is ETH ', () => {
    const result = getTokenValue(2n, Currency.ETH, 150000000000n, 'ETH');
    expect(result).toEqual(2n);
  });

  it('should return the USDC balance value in USDC when toggled currency is USDC', () => {
    const result = getTokenValue(20000000000000n, Currency.USDC, 100000020n, 'USDC');
    expect(result).toEqual(19999996000001n);
  });

  it('should return the USDC balance value in USD when toggled currency is USD', () => {
    const result = getTokenValue(200000000n, Currency.USDC, 100000020n, 'USD');
    expect(result).toEqual(200000000n);
  });
});

describe('formatRateFactor', () => {
  it('should return the correct formatted rate based on the factor', () => {
    const result = formatRateFactor(BigInt(0.0654e18));
    expect(result).toEqual('6.54%');
  });

  it('should return the correct formatted rate based on the factor and minimumFractionDigits', () => {
    const result = formatRateFactor(BigInt(0.0654e18), 0, 0);
    expect(result).toEqual('7%');
  });
});

describe('normalizePrice', () => {
  it('should return the correct formatted price based on the price precision', () => {
    const result = normalizePrice(BigInt(1.2345e8));
    expect(result).toEqual(1.2345);
  });
});

describe('getValueInDollars', () => {
  const baseAssetInUSDC = {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    allowance: 0n,
    balance: 0n,
    balanceOfComet: 50157546183503n,
    baseAssetPriceInDollars: 100020042n,
    borrowCapacity: 0n,
    bulkerAllowance: 0n,
    decimals: 6,
    minBorrow: 100000000n,
    name: 'USD Coin',
    price: 100020042n,
    priceFeed: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    symbol: 'USDC',
    walletBalance: 0n,
  };

  const baseAssetInETH = {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    allowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    balance: 0n,
    balanceOfComet: 5474895387241805566984n,
    baseAssetPriceInDollars: 149356000000n,
    borrowCapacity: 0n,
    bulkerAllowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    decimals: 18,
    minBorrow: 100000000000000000n,
    name: 'Ether',
    price: 100020042n,
    priceFeed: '0xD72ac1bCE9177CFe7aEb5d0516a38c88a64cE0AB',
    symbol: 'ETH',
    walletBalance: 0n,
  };

  it('should return the value in dollars when base asset is USDC', () => {
    const result = getValueInDollars(BigInt(1.2345e8), baseAssetInUSDC);
    expect(result).toEqual(123450000n);
  });

  it('should return the value in dollars when base asset is ETH', () => {
    const result = getValueInDollars(BigInt(1.2345e8), baseAssetInETH);
    expect(result).toEqual(184379982000n);
  });
});

describe('getValueInBaseAsset', () => {
  const baseAssetInUSDC = {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    allowance: 0n,
    balance: 0n,
    balanceOfComet: 50157546183503n,
    baseAssetPriceInDollars: 100020042n,
    borrowCapacity: 0n,
    bulkerAllowance: 0n,
    decimals: 6,
    minBorrow: 100000000n,
    name: 'USD Coin',
    price: 100020042n,
    priceFeed: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6',
    symbol: 'USDC',
    walletBalance: 0n,
  };

  const baseAssetInETH = {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    allowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    balance: 0n,
    balanceOfComet: 5474895387241805566984n,
    baseAssetPriceInDollars: 149356000000n,
    borrowCapacity: 0n,
    bulkerAllowance: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    decimals: 18,
    minBorrow: 100000000000000000n,
    name: 'Ether',
    price: 100020042n,
    priceFeed: '0xD72ac1bCE9177CFe7aEb5d0516a38c88a64cE0AB',
    symbol: 'ETH',
    walletBalance: 0n,
  };

  it('should return the value in USDC when base asset is USDC', () => {
    const result = getValueInBaseAsset(BigInt(1.2345e8), baseAssetInUSDC);
    expect(result).toEqual(123425263n);
  });

  it('should return the value in ETH when base asset is ETH', () => {
    const result = getValueInBaseAsset(BigInt(1.2345e8), baseAssetInETH);
    expect(result).toEqual(123450000n);
  });
});

describe('displayValue', () => {
  it('should return the correct display value without formatting for token', () => {
    const result = displayValue(8, BigInt(99905588n));
    expect(result).toEqual('0.9991');
  });

  it('should return the correct display value without formatting for token', () => {
    const result = displayValue(8, BigInt(999000005588n));
    expect(result).toEqual('9,990.0001');
  });
});

describe('formatValue', () => {
  it('should return the correct display value with formatting for token', () => {
    const result = formatValue(8, BigInt(99905588n));
    expect(result).toEqual('0.9991');
  });

  it('should return the correct display value with formatting for token', () => {
    const result = formatValue(8, BigInt(99900000000005588n));
    expect(result).toEqual('999.0000M');
  });

  it('should return the correct display value with formatting for token', () => {
    const result = formatValue(8, BigInt(99900000005588n));
    expect(result).toEqual('999.0000K');
  });
});

describe('formatValueInCurrency', () => {
  it('should return the correct display value with formatting for token with currency suffix for collateral factors', () => {
    const result = formatValueInCurrency(8, BigInt(99905588n), Currency.USDC);
    expect(result).toEqual('0.9991 USDC');
  });

  it('should return the correct display value with formatting for token', () => {
    const result = formatValueInCurrency(8, BigInt(99900000000005588n), Currency.ETH);
    expect(result).toEqual('999.00M ETH');
  });

  it('should return the correct display value with formatting for token', () => {
    const result = formatValueInCurrency(8, BigInt(99900000005588n), Currency.USDC);
    expect(result).toEqual('999.00K USDC');
  });
});

describe('formatValueInDollars', () => {
  it('should return the correct display value with formatting for dollars', () => {
    const result = formatValueInDollars(8, BigInt(99905588n));
    expect(result).toEqual('$1.00');
  });

  it('should return the correct display value with formatting for dollars', () => {
    const result = formatValueInDollars(8, BigInt(99900000000005588n));
    expect(result).toEqual('$999.00M');
  });

  it('should return the correct display value with formatting for dollars', () => {
    const result = formatValueInDollars(8, BigInt(99900000005588n));
    expect(result).toEqual('$999.00K');
  });
});

describe('shouldShowValueInBaseAsset', () => {
  it('should return should display in base asset flag true', () => {
    const result = shouldShowValueInBaseAsset(Currency.ETH, Currency.ETH);
    expect(result).toEqual(true);
  });

  it('should return should display in base asset flag true', () => {
    const result = shouldShowValueInBaseAsset(Currency.USDC, Currency.USDC);
    expect(result).toEqual(true);
  });

  it('should return should display in base asset flag false', () => {
    const result = shouldShowValueInBaseAsset(Currency.USD, Currency.ETH);
    expect(result).toEqual(false);
  });

  it('should return should display in base asset flag false', () => {
    const result = shouldShowValueInBaseAsset(Currency.USD, Currency.USDC);
    expect(result).toEqual(false);
  });
});

describe('shouldDisplayBalance in string', () => {
  it('should return integer balance string without extra decimals', () => {
    const result = formatUnitsWithTruncation({ amount: '500.00' });
    expect(result).toEqual('500');
  });

  it('should return integer balance string without extra decimals', () => {
    const result = formatUnitsWithTruncation({ amount: '9900.000' });
    expect(result).toEqual('9,900');
  });

  it('should return integer balance string without extra decimals', () => {
    const result = formatUnitsWithTruncation({ amount: '9000900.000' });
    expect(result).toEqual('9,000,900');
  });

  it('should always return 4 decimal places for decimal values', () => {
    const result = formatUnitsWithTruncation({ amount: '500.455' });
    expect(result).toEqual('500.4550');
  });

  it('should return balance string without abbreviation', () => {
    const result = formatUnitsWithTruncation({ amount: '500000000' });
    expect(result).toEqual('500,000,000');
  });

  it('should return balance string without abbreviation', () => {
    const result = formatUnitsWithTruncation({ amount: '500000' });
    expect(result).toEqual('500,000');
  });
});

import { isLegacyCollateral, filterLegacyCollateralSymbols } from '@helpers/legacyCollateral';

describe('isLegacyCollateral', () => {
  test('returns true for configured (comet, symbol) pairs', () => {
    expect(isLegacyCollateral(1, 'USDT', 'mETH')).toBe(true);
    expect(isLegacyCollateral(1, 'USDT', 'USDe')).toBe(true);
    expect(isLegacyCollateral(1, 'USDC', 'rsETH')).toBe(true);
    expect(isLegacyCollateral(1, 'wstETH', 'ezETH')).toBe(true);
    expect(isLegacyCollateral(1, 'WBTC', 'LBTC')).toBe(true);
    expect(isLegacyCollateral(1, 'WBTC', 'pumpBTC')).toBe(true);
    expect(isLegacyCollateral(1, 'USDS', 'tBTC')).toBe(true);
  });

  test('is case-insensitive on both base and collateral symbol', () => {
    expect(isLegacyCollateral(1, 'usdt', 'wusdm')).toBe(true);
    expect(isLegacyCollateral(1, 'WBTC', 'pumpbtc')).toBe(true);
    expect(isLegacyCollateral(1, 'WstEth', 'WEETH')).toBe(true);
  });

  test('returns false for non-legacy symbols, other comets, and other chains', () => {
    expect(isLegacyCollateral(1, 'USDT', 'WBTC')).toBe(false);
    expect(isLegacyCollateral(1, 'WBTC', 'weETH')).toBe(false);
    expect(isLegacyCollateral(1, 'ETH', 'USDe')).toBe(false);
    expect(isLegacyCollateral(10, 'USDT', 'mETH')).toBe(false);
  });
});

describe('filterLegacyCollateralSymbols', () => {
  test('drops legacy symbols and preserves order of the rest', () => {
    const input = ['WBTC', 'mETH', 'COMP', 'USDe', 'LINK'];
    expect(filterLegacyCollateralSymbols(1, 'USDT', input)).toEqual(['WBTC', 'COMP', 'LINK']);
  });

  test('returns the list unchanged for unconfigured comets', () => {
    const input = ['WBTC', 'COMP'];
    expect(filterLegacyCollateralSymbols(1, 'ETH', input)).toEqual(['WBTC', 'COMP']);
    expect(filterLegacyCollateralSymbols(8453, 'USDC', input)).toEqual(['WBTC', 'COMP']);
  });
});

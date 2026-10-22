import { getMarketDescriptors } from '@helpers/markets';

import { LEGACY_ADDRESSES } from '../mocks/legacyMarketAddresses';
import { MOCK_MARKETS } from '../mocks/mockMarkets';

const cometOf = (market: keyof typeof LEGACY_ADDRESSES) => LEGACY_ADDRESSES[market].comet.toLowerCase();

describe('getMarketDescriptors', () => {
  test('returns the correct market descriptors for mainnet USDC', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('mainnetUSDC'), 1)).toEqual(['USDC', 'Ethereum', 'USD Coin']);
  });

  test('returns the correct market descriptors for mainnet WETH', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('mainnetWETH'), 1)).toEqual(['ETH', 'Ethereum', 'Ether']);
  });

  test('returns the correct market descriptors for mainnet USDT', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('mainnetUSDT'), 1)).toEqual(['USDT', 'Ethereum', 'Tether']);
  });

  test('returns the correct market descriptors for mainnet wstETH', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('mainnetWSTETH'), 1)).toEqual([
      'wstETH',
      'Ethereum',
      'Lido Wrapped Staked ETH',
    ]);
  });

  test('returns the correct market descriptors for polygon USDC', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('polygonUSDC'), 137)).toEqual([
      'USDC.e',
      'Polygon',
      'USD Coin (Bridged)',
    ]);
  });

  test('returns the correct market descriptors for polygon USDT', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('polygonUSDT'), 137)).toEqual(['USDT0', 'Polygon', 'Tether']);
  });

  test('returns the correct market descriptors for arbitrum bridged USDC', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('arbitrumBridgedUSDC'), 42161)).toEqual([
      'USDC.e',
      'Arbitrum',
      'USD Coin (Bridged)',
    ]);
  });

  test('returns the correct market descriptors for arbitrum native USDC', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('arbitrumNativeUSDC'), 42161)).toEqual([
      'USDC',
      'Arbitrum',
      'USD Coin',
    ]);
  });

  test('returns the correct market descriptors for arbitrum WETH', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('arbitrumWETH'), 42161)).toEqual(['ETH', 'Arbitrum', 'Ether']);
  });

  test('returns the correct market descriptors for arbitrum USDT', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('arbitrumUSDT'), 42161)).toEqual([
      'USD₮0',
      'Arbitrum',
      'Tether',
    ]);
  });

  test('returns the correct market descriptors for base mainnet USDC', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('baseMainnetUSDC'), 8453)).toEqual([
      'USDC',
      'Base',
      'USD Coin',
    ]);
  });

  test('returns the correct market descriptors for base mainnet USDbC', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('baseMainnetUSDbC'), 8453)).toEqual([
      'USDbC',
      'Base',
      'USD Coin (Bridged)',
    ]);
  });

  test('returns the correct market descriptors for base mainnet WETH', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('baseMainnetWETH'), 8453)).toEqual(['ETH', 'Base', 'Ether']);
  });

  test('returns the correct market descriptors for scroll mainnet USDC', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('scrollUSDC'), 534352)).toEqual([
      'USDC',
      'Scroll',
      'USD Coin',
    ]);
  });

  test('returns the correct market descriptors for mainnet institutional USDC', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('mainnetInstitutionalUSDC'), 1)).toEqual([
      'USDC',
      'Ethereum',
      'USDC Institutional',
    ]);
  });

  test('returns the correct market descriptors for mantle mainnet USDe', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('mantleUSDE'), 5000)).toEqual([
      'USDe',
      'Mantle',
      'Ethena USDe',
    ]);
  });

  test('returns the correct market descriptors for optimism mainnet WETH', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('optimismWETH'), 10)).toEqual(['ETH', 'Optimism', 'Ether']);
  });

  test('returns the correct market descriptors for optimism mainnet USDC', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('optimismUSDC'), 10)).toEqual([
      'USDC',
      'Optimism',
      'USD Coin',
    ]);
  });

  test('returns the correct market descriptors for optimism mainnet USDT', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('optimismUSDT'), 10)).toEqual(['USDT', 'Optimism', 'Tether']);
  });

  test('returns the correct market descriptors for unknown markets', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, '0xdeadbeef', 1)).toEqual(['UNKNOWN', 'Unknown', 'Unknown']);
  });

  test('returns the correct market descriptors for unknown chains', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, cometOf('mainnetUSDC'), 2)).toEqual(['UNKNOWN', 'Unknown', 'Unknown']);
  });

  test('returns the correct market descriptors for unknown markets on unknown chains', () => {
    expect(getMarketDescriptors(MOCK_MARKETS, '0xdeadbeef', 2)).toEqual(['UNKNOWN', 'Unknown', 'Unknown']);
  });
});

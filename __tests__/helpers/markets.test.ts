import arbitrumNativeUSDCRoots from 'comet/deployments/arbitrum/usdc/roots.json';
import arbitrumBridgedUSDCRoots from 'comet/deployments/arbitrum/usdc.e/roots.json';
import arbitrumUSDTRoots from 'comet/deployments/arbitrum/usdt/roots.json';
import arbitrumWETHRoots from 'comet/deployments/arbitrum/weth/roots.json';
import baseMainnetUSDbCRoots from 'comet/deployments/base/usdbc/roots.json';
import baseMainnetUSDCRoots from 'comet/deployments/base/usdc/roots.json';
import baseMainnetWETHRoots from 'comet/deployments/base/weth/roots.json';
import mainnetUSDCRoots from 'comet/deployments/mainnet/usdc/roots.json';
import mainnetUSDTRoots from 'comet/deployments/mainnet/usdt/roots.json';
import mainnetWETHRoots from 'comet/deployments/mainnet/weth/roots.json';
import mainnetWSTETHRoots from 'comet/deployments/mainnet/wsteth/roots.json';
import mantleUSDERoots from 'comet/deployments/mantle/usde/roots.json';
import optimismUSDCRoots from 'comet/deployments/optimism/usdc/roots.json';
import optimismUSDTRoots from 'comet/deployments/optimism/usdt/roots.json';
import optimismWETHRoots from 'comet/deployments/optimism/weth/roots.json';
import polygonUSDCRoots from 'comet/deployments/polygon/usdc/roots.json';
import polygonUSDTRoots from 'comet/deployments/polygon/usdt/roots.json';
import scrollUSDCRoots from 'comet/deployments/scroll/usdc/roots.json';
import sepoliaUSDCRoots from 'comet/deployments/sepolia/usdc/roots.json';
import sepoliaWETHRoots from 'comet/deployments/sepolia/weth/roots.json';

import { getMarketDescriptors } from '@helpers/markets';

describe('getMarketDescriptors', () => {
  test('returns the correct market descriptors for mainnet USDC', () => {
    expect(getMarketDescriptors(mainnetUSDCRoots['comet'].toLowerCase(), 1)).toEqual(['USDC', 'Ethereum', 'USD Coin']);
  });

  test('returns the correct market descriptors for mainnet WETH', () => {
    expect(getMarketDescriptors(mainnetWETHRoots['comet'].toLowerCase(), 1)).toEqual(['ETH', 'Ethereum', 'Ether']);
  });

  test('returns the correct market descriptors for mainnet USDT', () => {
    expect(getMarketDescriptors(mainnetUSDTRoots['comet'].toLowerCase(), 1)).toEqual(['USDT', 'Ethereum', 'Tether']);
  });

  test('returns the correct market descriptors for mainnet wstETH', () => {
    expect(getMarketDescriptors(mainnetWSTETHRoots['comet'].toLowerCase(), 1)).toEqual([
      'wstETH',
      'Ethereum',
      'Lido Wrapped Staked ETH',
    ]);
  });

  test('returns the correct market descriptors for polygon USDC', () => {
    expect(getMarketDescriptors(polygonUSDCRoots['comet'].toLowerCase(), 137)).toEqual([
      'USDC.e',
      'Polygon',
      'USD Coin (Bridged)',
    ]);
  });

  test('returns the correct market descriptors for polygon USDT', () => {
    expect(getMarketDescriptors(polygonUSDTRoots['comet'].toLowerCase(), 137)).toEqual(['USDT', 'Polygon', 'Tether']);
  });

  test('returns the correct market descriptors for arbitrum bridged USDC', () => {
    expect(getMarketDescriptors(arbitrumBridgedUSDCRoots['comet'].toLowerCase(), 42161)).toEqual([
      'USDC.e',
      'Arbitrum',
      'USD Coin (Bridged)',
    ]);
  });

  test('returns the correct market descriptors for arbitrum native USDC', () => {
    expect(getMarketDescriptors(arbitrumNativeUSDCRoots['comet'].toLowerCase(), 42161)).toEqual([
      'USDC',
      'Arbitrum',
      'USD Coin',
    ]);
  });

  test('returns the correct market descriptors for arbitrum WETH', () => {
    expect(getMarketDescriptors(arbitrumWETHRoots['comet'].toLowerCase(), 42161)).toEqual(['ETH', 'Arbitrum', 'Ether']);
  });

  test('returns the correct market descriptors for arbitrum USDT', () => {
    expect(getMarketDescriptors(arbitrumUSDTRoots['comet'].toLowerCase(), 42161)).toEqual([
      'USDT',
      'Arbitrum',
      'Tether',
    ]);
  });

  test('returns the correct market descriptors for base mainnet USDC', () => {
    expect(getMarketDescriptors(baseMainnetUSDCRoots['comet'].toLowerCase(), 8453)).toEqual([
      'USDC',
      'Base',
      'USD Coin',
    ]);
  });

  test('returns the correct market descriptors for base mainnet USDbC', () => {
    expect(getMarketDescriptors(baseMainnetUSDbCRoots['comet'].toLowerCase(), 8453)).toEqual([
      'USDbC',
      'Base',
      'USD Coin (Bridged)',
    ]);
  });

  test('returns the correct market descriptors for base mainnet WETH', () => {
    expect(getMarketDescriptors(baseMainnetWETHRoots['comet'].toLowerCase(), 8453)).toEqual(['ETH', 'Base', 'Ether']);
  });

  test('returns the correct market descriptors for scroll mainnet USDC', () => {
    expect(getMarketDescriptors(scrollUSDCRoots['comet'].toLowerCase(), 534352)).toEqual([
      'USDC',
      'Scroll',
      'USD Coin',
    ]);
  });
  test('returns the correct market descriptors for sepolia USDC', () => {
    expect(getMarketDescriptors(sepoliaUSDCRoots['comet'].toLowerCase(), 11155111)).toEqual([
      'USDC',
      'Sepolia',
      'USD Coin',
    ]);
  });
  test('returns the correct market descriptors for sepolia ETH', () => {
    expect(getMarketDescriptors(sepoliaWETHRoots['comet'].toLowerCase(), 11155111)).toEqual([
      'ETH',
      'Sepolia',
      'Ether',
    ]);
  });

  test('returns the correct market descriptors for mantle mainnet USDe', () => {
    expect(getMarketDescriptors(mantleUSDERoots['comet'].toLowerCase(), 5000)).toEqual([
      'USDe',
      'Mantle',
      'Ethena USDe',
    ]);
  });

  test('returns the correct market descriptors for optimism mainnet WETH', () => {
    expect(getMarketDescriptors(optimismWETHRoots['comet'].toLowerCase(), 10)).toEqual(['ETH', 'Optimism', 'Ether']);
  });

  test('returns the correct market descriptors for optimism mainnet USDC', () => {
    expect(getMarketDescriptors(optimismUSDCRoots['comet'].toLowerCase(), 10)).toEqual([
      'USDC',
      'Optimism',
      'USD Coin',
    ]);
  });

  test('returns the correct market descriptors for optimism mainnet USDT', () => {
    expect(getMarketDescriptors(optimismUSDTRoots['comet'].toLowerCase(), 10)).toEqual(['USDT', 'Optimism', 'Tether']);
  });

  test('returns the correct market descriptors for unknown markets', () => {
    expect(getMarketDescriptors('0xdeadbeef', 1)).toEqual(['UNKNOWN', 'Unknown', 'Unknown']);
  });

  test('returns the correct market descriptors for unknown chains', () => {
    expect(getMarketDescriptors(mainnetUSDCRoots['comet'].toLowerCase(), 2)).toEqual(['UNKNOWN', 'Unknown', 'Unknown']);
  });

  test('returns the correct market descriptors for unknown markets on unknown chains', () => {
    expect(getMarketDescriptors('0xdeadbeef', 2)).toEqual(['UNKNOWN', 'Unknown', 'Unknown']);
  });
});

import { BaseAssetConfig, ChainInformation } from '@types';

export function getIsDeprecatedwUSDMMarket(
  BaseAssetConfig: BaseAssetConfig,
  chainInformation: ChainInformation
): boolean {
  if (
    (chainInformation.chainId === 1 && BaseAssetConfig.symbol === 'USDT') ||
    // Not wUSDM: mainnet cWBTCv3's pumpBTC collateral feed was deprecated on
    // 2026-09-03, and its price is handled by the same deprecated-feed paths.
    (chainInformation.chainId === 1 && BaseAssetConfig.symbol === 'WBTC') ||
    (chainInformation.chainId === 42161 && BaseAssetConfig.symbol === 'USDC') ||
    (chainInformation.chainId === 10 && BaseAssetConfig.symbol === 'USDC') ||
    (chainInformation.chainId === 10 && BaseAssetConfig.symbol === 'USDT')
  ) {
    return true;
  }

  return false;
}

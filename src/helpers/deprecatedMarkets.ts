import { BaseAssetConfig, ChainInformation } from '@types';

export function getIsDeprecatedwUSDMMarket(
  BaseAssetConfig: BaseAssetConfig,
  chainInformation: ChainInformation
): boolean {
  if (
    (chainInformation.chainId === 1 && BaseAssetConfig.symbol === 'USDT') ||
    (chainInformation.chainId === 42161 && BaseAssetConfig.symbol === 'USDC') ||
    (chainInformation.chainId === 10 && BaseAssetConfig.symbol === 'USDC') ||
    (chainInformation.chainId === 10 && BaseAssetConfig.symbol === 'USDT')
  ) {
    return true;
  }

  return false;
}

export function getRemappedPriceFeed(priceFeedAddress: string): string {
  if (priceFeedAddress === '0xe3a409eD15CD53aFdEFdd191ad945cEC528A2496') {
    // ethereum
    return '0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5';
  } else if (priceFeedAddress === '0x13cDFB7db5e2F58e122B2e789b59dE13645349C4') {
    // arb
    return '0xb2a824043730fe05f3da2efafa1cbbe83fa548d6';
  } else if (
    priceFeedAddress === '0x66228d797eb83ecf3465297751f6b1D4d42b7627' ||
    priceFeedAddress === '0x7E86318Cc4bc539043F204B39Ce0ebeD9F0050Dc'
  ) {
    // optimism
    return '0x0D276FC14719f9292D5C1eA2198673d1f4269246';
  }

  return '';
}

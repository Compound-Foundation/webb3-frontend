import { MarketData } from '@types';

export const mockMarket = (overrides?: Partial<MarketData>): MarketData => ({
  type: 'MarketData',
  baseAsset: {
    symbol: 'USDC',
    name: 'USD Coin',
  },
  chainInformation: {
    chainId: 11155111,
    url: 'https://sepolia-ethereum.compound.finance',
    key: 'sepolia',
    name: 'Sepolia',
    blockExplorerUrls: ['https://sepolia.etherscan.io'],
    nativeToken: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    assetOverrides: {
      '0x42a71137C09AE83D8d05974960fd607d40033499': {
        symbol: 'ETH',
        name: 'Ether',
        address: '0x0000000000000000000000000000000000000000',
      },
      '0x4942BBAf745f235e525BAff49D31450810EDed5b': {
        symbol: 'wstETH',
        name: 'Lido Wrapped Staked ETH',
        address: '0x4942BBAf745f235e525BAff49D31450810EDed5b',
      },
    },
    unwrappedCollateralAssets: {
      '0x4942BBAf745f235e525BAff49D31450810EDed5b': {
        symbol: 'stETH',
        name: 'Lido Staked ETH',
        address: '0x2DD6530F136D2B56330792D46aF959D9EA62E276',
      },
    },
    extraPriceFeeds: {
      nativeTokenToUsd: '0xD4a33860578De61DBAbDc8BFdb98FD742fA7028e',
      rewards: { COMP: '0x54a06047087927D9B0fb21c1cf0ebd792764dDB8' },
      otherBaseTokensToUsd: {},
    },
    testnet: true,
    walletRpcUrls: ['https://sepolia.infura.io/v3/'],
  },
  iconPair: ['ETHEREUM', 'USDC'],
  marketAddress: '0x3EE77595A8459e93C2888b13aDB354017B198188',
  bulkerAddress: '0x69dD076105977c55dC2835951d287f82D54606b4',
  fauceteerAddress: '0x75442Ac771a7243433e033F3F8EaB2631e22938f',
  rewardsAddress: '0xef9e070044d62C38D2e316146dDe92AD02CF2c2c',
  ...overrides,
});

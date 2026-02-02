import { ethers } from 'ethers';

import {
  ARBITRUM_URL,
  AVALANCHE_URL,
  BASE_MAINNET_URL,
  FUJI_URL,
  SEPOLIA_URL,
  MAINNET_URL,
  OPTIMISM_URL,
  POLYGON_URL,
  SCROLL_URL,
  MANTLE_URL,
  LINEA_URL,
  UNICHAIN_URL,
  RONIN_URL,
} from '../../envVars';
import { ChainInformation } from '../types';

export const CHAINS: {
  [chainId: number]: ChainInformation;
} = {
  // XXX uncomment networks as they get supported.
  1: {
    chainId: 1,
    url: MAINNET_URL,
    key: 'mainnet',
    name: 'Ethereum',
    blockExplorerUrls: ['https://etherscan.io'],
    nativeToken: {
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
    },
    assetOverrides: {
      // WETH
      '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': {
        symbol: 'ETH',
        name: 'Ether',
        address: ethers.constants.AddressZero,
      },
      // wstETH name only override
      '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0': {
        symbol: 'wstETH',
        name: 'Lido Wrapped Staked ETH',
        address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
      },
      // rsETH name only override
      '0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7': {
        symbol: 'rsETH',
        name: 'KelpDao Restaked ETH',
        address: '0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7',
      },
      // osETH name only override
      '0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38': {
        symbol: 'osETH',
        name: 'StakeWise Staked ETH',
        address: '0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38',
      },
      // rswETH name only override
      '0xFAe103DC9cf190eD75350761e95403b7b8aFa6c0': {
        symbol: 'rswETH',
        name: 'Restaked Swell ETH',
        address: '0xFAe103DC9cf190eD75350761e95403b7b8aFa6c0',
      },
      // USDe name only override
      '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': {
        symbol: 'USDe',
        name: 'Ethena USDe',
        address: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
      },
    },
    unwrappedCollateralAssets: {
      //stETH
      '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0': {
        symbol: 'stETH',
        name: 'Lido Staked ETH',
        address: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
      },
    },
    extraPriceFeeds: {
      nativeTokenToUsd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
      rewards: { COMP: '0x619db7F74C0061E2917D1D57f834D9D24C5529dA' },
      otherBaseTokensToUsd: {
        wstETH: '0x164b276057258d81941e97B0a900D4C7B358bCe0',
        WBTC: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
      },
    },
    testnet: false,
    walletRpcUrls: ['https://mainnet.infura.io/v3/'],
  },
  11155111: {
    chainId: 11155111,
    url: SEPOLIA_URL,
    key: 'sepolia',
    name: 'Sepolia',
    blockExplorerUrls: ['https://sepolia.etherscan.io'],
    nativeToken: {
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
    },
    assetOverrides: {
      // WETH
      '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9': {
        symbol: 'ETH',
        name: 'Ether',
        address: ethers.constants.AddressZero,
      },
      // wstETH name only override
      '0xB82381A3fBD3FaFA77B3a7bE693342618240067b': {
        symbol: 'wstETH',
        name: 'Lido Wrapped Staked ETH',
        address: '0xB82381A3fBD3FaFA77B3a7bE693342618240067b',
      },
    },
    unwrappedCollateralAssets: {},
    extraPriceFeeds: {
      nativeTokenToUsd: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
      rewards: { COMP: '0x619db7F74C0061E2917D1D57f834D9D24C5529dA' },
      otherBaseTokensToUsd: {},
    },
    testnet: true,
    walletRpcUrls: ['https://sepolia.infura.io/v3/'],
  },
  10: {
    chainId: 10,
    url: OPTIMISM_URL,
    key: 'op',
    name: 'Optimism',
    blockExplorerUrls: ['https://explorer.optimism.io'],
    nativeToken: {
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
    },
    v3ApiNetworkKeyOverride: 'optimism-mainnet',
    assetOverrides: {
      // WETH
      '0x4200000000000000000000000000000000000006': {
        symbol: 'ETH',
        name: 'Ether',
        address: ethers.constants.AddressZero,
      },
      // wrsETH name only override
      '0x87eEE96D50Fb761AD85B1c982d28A042169d61b1': {
        symbol: 'wrsETH',
        name: 'Wrapped rsETH',
        address: '0x87eEE96D50Fb761AD85B1c982d28A042169d61b1',
      },
    },
    unwrappedCollateralAssets: {},
    extraPriceFeeds: {
      nativeTokenToUsd: '0x13e3Ee699D1909E989722E753853AE30b17e08c5',
      rewards: { COMP: '0xA6c8D1c55951e8AC44a0EaA959Be5Fd21cc07531' },
      otherBaseTokensToUsd: {},
    },
    testnet: false,
    walletRpcUrls: ['https://optimism-mainnet.infura.io'],
  },
  137: {
    chainId: 137,
    url: POLYGON_URL,
    key: 'polygon',
    name: 'Polygon',
    blockExplorerUrls: ['https://polygonscan.com/'],
    nativeToken: {
      decimals: 18,
      name: 'Polygon',
      symbol: 'POL',
    },
    v3ApiNetworkKeyOverride: 'polygon-mainnet',
    assetOverrides: {
      // POL
      '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270': {
        symbol: 'POL',
        name: 'Polygon',
        address: ethers.constants.AddressZero,
      },
      // WBTC
      '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6': {
        address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
        name: 'Wrapped Bitcoin',
        symbol: 'WBTC',
      },
      // MaticX
      '0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6': {
        address: '0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6',
        name: 'Stader MaticX',
        symbol: 'MaticX',
      },
      // USDC.e
      '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174': {
        address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        name: 'Bridged USDC',
        symbol: 'USDC.e',
      },
    },
    unwrappedCollateralAssets: {},
    testnet: false,
    walletRpcUrls: ['https://polygon-rpc.com/', 'https://polygon-mainnet.infura.io'],
    extraPriceFeeds: {
      nativeTokenToUsd: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0',
      rewards: { COMP: '0x2A8758b7257102461BC958279054e372C2b1bDE6' },
      otherBaseTokensToUsd: {},
    },
  },
  43113: {
    chainId: 43113,
    url: FUJI_URL,
    key: 'fuji',
    name: 'Avalanche Fuji',
    blockExplorerUrls: ['https://testnet.snowtrace.io'],
    nativeToken: {
      decimals: 18,
      name: 'Avax',
      symbol: 'AVAX',
    },
    assetOverrides: {},
    unwrappedCollateralAssets: {},
    extraPriceFeeds: { nativeTokenToUsd: '', rewards: {}, otherBaseTokensToUsd: {} },
    testnet: true,
    walletRpcUrls: ['https://api.avax-test.network/ext/bc/C/rpc'],
  },
  43114: {
    chainId: 43114,
    url: AVALANCHE_URL,
    key: 'Avax',
    name: 'Avalanche',
    blockExplorerUrls: ['https://snowtrace.io'],
    nativeToken: {
      decimals: 18,
      name: 'Avax',
      symbol: 'AVAX',
    },
    assetOverrides: {},
    unwrappedCollateralAssets: {},
    extraPriceFeeds: { nativeTokenToUsd: '', rewards: {}, otherBaseTokensToUsd: {} },
    testnet: true,
    walletRpcUrls: ['https://avalanche-mainnet.infura.io'],
  },
  42161: {
    chainId: 42161,
    url: ARBITRUM_URL,
    key: 'arb',
    v3ApiNetworkKeyOverride: 'arbitrum-mainnet',
    name: 'Arbitrum',
    blockExplorerUrls: ['https://arbiscan.io/'],
    nativeToken: {
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
    },
    assetOverrides: {
      // WETH
      '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1': {
        symbol: 'ETH',
        name: 'Ether',
        address: ethers.constants.AddressZero,
      },
      // WBTC
      '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f': {
        address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
        name: 'Wrapped Bitcoin',
        symbol: 'WBTC',
      },
      // USDC.e
      '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8': {
        address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
        name: 'Bridged USDC',
        symbol: 'USDC.e',
      },
      // wstETH
      '0x5979D7b546E38E414F7E9822514be443A4800529': {
        address: '0x5979D7b546E38E414F7E9822514be443A4800529',
        name: 'Lido Wrapped Staked ETH',
        symbol: 'wstETH',
      },
    },
    unwrappedCollateralAssets: {},
    extraPriceFeeds: {
      nativeTokenToUsd: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
      rewards: { COMP: '0xe7C53FFd03Eb6ceF7d208bC4C13446c76d1E5884' },
      otherBaseTokensToUsd: {},
    },
    testnet: false,
    walletRpcUrls: ['https://arb1.arbitrum.io/rpc'],
  },
  8453: {
    chainId: 8453,
    url: BASE_MAINNET_URL,
    key: 'basemainnet',
    v3ApiNetworkKeyOverride: 'base-mainnet',
    name: 'Base',
    blockExplorerUrls: ['https://basescan.org/'],
    nativeToken: {
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
    },
    assetOverrides: {
      // WETH
      '0x4200000000000000000000000000000000000006': {
        symbol: 'ETH',
        name: 'Ether',
        address: ethers.constants.AddressZero,
      },
      // USDbC
      '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA': {
        address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
        name: 'Bridged USDC',
        symbol: 'USDbC',
      },
      // wrsETH name only override
      '0xEDfa23602D0EC14714057867A78d01e94176BEA0': {
        symbol: 'wrsETH',
        name: 'Wrapped rsETH',
        address: '0xEDfa23602D0EC14714057867A78d01e94176BEA0',
      },
    },
    unwrappedCollateralAssets: {},
    extraPriceFeeds: {
      nativeTokenToUsd: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
      rewards: { COMP: '0x9DDa783DE64A9d1A60c49ca761EbE528C35BA428' },
      otherBaseTokensToUsd: {},
    },
    testnet: false,
    walletRpcUrls: ['https://mainnet.base.org'],
  },
  534352: {
    chainId: 534352,
    url: SCROLL_URL,
    key: 'scroll',
    v3ApiNetworkKeyOverride: 'scroll-mainnet',
    name: 'Scroll',
    blockExplorerUrls: ['https://scrollscan.com/'],
    nativeToken: {
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
    },
    assetOverrides: {
      // WETH
      '0x5300000000000000000000000000000000000004': {
        symbol: 'ETH',
        name: 'Ether',
        address: ethers.constants.AddressZero,
      },
      // wstETH
      '0xf610A9dfB7C89644979b4A0f27063E9e7d7Cda32': {
        address: '0xf610A9dfB7C89644979b4A0f27063E9e7d7Cda32',
        name: 'Lido Wrapped Staked ETH',
        symbol: 'wstETH',
      },
      // USDC
      '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4': {
        address: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',
        name: 'USDC',
        symbol: 'USDC',
      },
    },
    unwrappedCollateralAssets: {},
    extraPriceFeeds: {
      nativeTokenToUsd: '0x43d12fb3afcad5347fa764eeab105478337b7200',
      rewards: { COMP: '0x643e160a3C3E2B7eae198f0beB1BfD2441450e86' },
      otherBaseTokensToUsd: {},
    },
    testnet: false,
    walletRpcUrls: ['https://rpc.scroll.io'],
  },
  5000: {
    chainId: 5000,
    url: MANTLE_URL,
    key: 'mantle',
    v3ApiNetworkKeyOverride: 'mantle-mainnet',
    name: 'Mantle',
    blockExplorerUrls: ['https://mantlescan.xyz/'],
    nativeToken: {
      decimals: 18,
      name: 'Mantle',
      symbol: 'MNT',
    },
    assetOverrides: {
      // WETH
      '0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111': {
        symbol: 'ETH',
        name: 'Ether',
        address: ethers.constants.AddressZero,
      },
      // Fire BTC -> FunctionBTC
      '0xC96dE26018A54D51c097160568752c4E3BD6C364': {
        address: '0xC96dE26018A54D51c097160568752c4E3BD6C364',
        name: 'FunctionBTC',
        symbol: 'FBTC',
      }
    },
    unwrappedCollateralAssets: {},
    extraPriceFeeds: {
      nativeTokenToUsd: '0xc49E06B50FCA57751155DA78803DCa691AfcDB22',
      rewards: { COMP: '0x0cd478875450BcdC75E16FF6084aF3a4782610b9' },
      otherBaseTokensToUsd: {},
    },
    testnet: false,
    walletRpcUrls: ['https://rpc.mantle.xyz'],
  },
  59144: {
    chainId: 59144,
    url: LINEA_URL,
    key: 'linea',
    v3ApiNetworkKeyOverride: 'linea-mainnet',
    name: 'Linea',
    blockExplorerUrls: ['https://lineascan.build/'],
    nativeToken: {
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
    },
    assetOverrides: {
      // WETH
      '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f': {
        symbol: 'ETH',
        name: 'Ether',
        address: ethers.constants.AddressZero,
      },
    },
    unwrappedCollateralAssets: {},
    extraPriceFeeds: {
      nativeTokenToUsd: '0x3c6Cd9Cc7c7a4c2Cf5a82734CD249D7D593354dA',
      rewards: { COMP: '0x0ECE76334Fb560f2b1a49A60e38Cf726B02203f0' },
      otherBaseTokensToUsd: {},
    },
    testnet: false,
    walletRpcUrls: ['https://rpc.linea.build/'],
  },
  130: {
    chainId: 130,
    url: UNICHAIN_URL,
    key: 'unichain',
    v3ApiNetworkKeyOverride: 'unichain-mainnet',
    name: 'Unichain',
    blockExplorerUrls: ['https://uniscan.xyz/'],
    nativeToken: {
      decimals: 18,
      name: 'Ether',
      symbol: 'ETH',
    },
    assetOverrides: {
      // WETH
      '0x4200000000000000000000000000000000000006': {
        symbol: 'ETH',
        name: 'Ether',
        address: ethers.constants.AddressZero,
      },
    },
    unwrappedCollateralAssets: {},
    extraPriceFeeds: {
      nativeTokenToUsd: '0xe8D9FbC10e00ecc9f0694617075fDAF657a76FB2',
      rewards: { COMP: '0xdf78e4f0a8279942ca68046476919a90f2288656' },
      otherBaseTokensToUsd: {},
    },
    testnet: false,
    walletRpcUrls: ['https://mainnet.unichain.org'],
  },
  2020: {
    chainId: 2020,
    url: RONIN_URL,
    key: 'ronin',
    v3ApiNetworkKeyOverride: 'ronin-mainnet',
    name: 'Ronin',
    blockExplorerUrls: ['https://app.roninchain.com/'],
    nativeToken: {
      decimals: 18,
      name: 'Ronin',
      symbol: 'RON',
    },
    assetOverrides: {
      // WRON
      '0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4': {
        symbol: 'RON',
        name: 'Ronin',
        address: '0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4',
      },
    },
    unwrappedCollateralAssets: {},
    extraPriceFeeds: {
      nativeTokenToUsd: '0x0B6074F21488B95945989E513EFEA070096d931D',
      rewards: { COMP: '0x0B6074F21488B95945989E513EFEA070096d931D' }, //TODO: NEED COMP token address
      otherBaseTokensToUsd: { WETH: '0x662Fdb0E7D95d89CD3458E4A3506296E48BB1F44' },
    },
    testnet: false,
    walletRpcUrls: ['https://api.roninchain.com/rpc'],
  },
};

export const isTestnet = (chainId: number) => {
  return CHAINS[chainId].testnet;
};

export const getChainKey = (chainId: number) => {
  return CHAINS[chainId].key;
};

export const URLS: { [chainId: number]: string } = Object.keys(CHAINS).reduce<{
  [chainId: number]: string;
}>((accumulator, chainId) => {
  const validURL: string = CHAINS[Number(chainId)].url;

  if (validURL) {
    accumulator[Number(chainId)] = validURL;
  }

  return accumulator;
}, {});

export function isUnwrappedCollateralAsset(chainInformation: ChainInformation, assetAddress: string) {
  const unwrappedCollateralAddresses = Object.values(chainInformation.unwrappedCollateralAssets).map(
    (asset) => asset.address
  );
  return unwrappedCollateralAddresses.includes(assetAddress);
}

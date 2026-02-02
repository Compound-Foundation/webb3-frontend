import { Permissions } from '@compound-finance/comet-extension';
import mainnetUSDCRoots from 'comet/deployments/mainnet/usdc/roots.json';
import mainnetWETHRoots from 'comet/deployments/mainnet/weth/roots.json';
import polygonUSDCRoots from 'comet/deployments/polygon/usdc/roots.json';

export declare type ExtensionSource =
  | {
      url: string | null;
    }
  | {
      ipfs: string;
      domain?: string;
      path?: string;
    };
export declare type Links = {
  github: string;
  website: string;
};

// Special keyword to represent all supported markets.
export const AllMarkets = 'all';
export declare type SupportedMarkets = Record<string, string | null> | typeof AllMarkets;
export interface Extension {
  id: string;
  name: string;
  description: string;
  sub_description?: string;
  developer: string;
  links: Links;
  permissions: Permissions;
  source: ExtensionSource;
  supportedMarkets: SupportedMarkets;
}

export const extensions: Extension[] = [
  {
    id: 'bulker',
    name: 'Advanced Transactions',
    description:
      'Combine multiple protocol actions into a single transaction to save on gas costs, through the Compound III proxy contract.',
    sub_description:
      'This extension enables new functionality in the main protocol dashboard, and does not have its own custom interface.',
    developer: 'Compound Labs',
    links: {
      github: 'https://github.com/compound-finance/comet',
      website: 'https://twitter.com/compoundfinance',
    },
    permissions: {
      storage: '*',
      trx: [
        {
          contract: '*',
          abi: 'approve(address,uint256)',
          params: ['$operator', '*'],
        },
      ],
    },
    source: {
      url: null,
    },
    supportedMarkets: {
      '1_USDC_0xc3d688B66703497DAA19211EEdff47f25384cdc3': mainnetUSDCRoots['bulker'],
      '1_ETH_0xA17581A9E3356d9A858b789D68B4d866e593aE94': mainnetWETHRoots['bulker'],
      '137_USDC_0xF25212E676D1F7F89Cd72fFEe66158f541246445': polygonUSDCRoots['bulker'],
    },
  },
  {
    id: 'comet_migrator',
    name: 'Compound V3 Position Migrator',
    description:
      'Migrate stablecoin borrow balances and supported collateral assets from Compound V2 or Aave V2 to the Compound V3 USDC market on the Ethereum network.',
    developer: 'Compound Labs',
    links: {
      github: 'https://github.com/compound-finance/comet-migrator',
      website: 'https://twitter.com/compoundfinance',
    },
    permissions: {
      storage: '*',
      trx: [
        {
          contract: '$operator',
          abi: 'migrate(((address,uint256)[],(address,uint256)[],(bytes,uint256)[]),((address,uint256)[],(address,uint256)[],(bytes,uint256)[]),uint256)',
          params: '*',
        },
        {
          contract: '*',
          abi: 'approve(address,uint256)',
          params: ['$operator', '*'],
        },
      ],
    },
    source: {
      ipfs: 'QmbLCnpr74GPexVV1f1Ws5R6JtitztteHgSLbXnB8n7Xkv',
      domain: 'comet-v2-migrator.infura-ipfs.io',
      path: '/embedded.html',
    },
    supportedMarkets: {
      '1_USDC_0xc3d688B66703497DAA19211EEdff47f25384cdc3': '0x3b6f1FE07CDAB8A43f39C3b99Ba8FF26e28DB8b4',
    },
  },
  {
    id: 'comp_vote',
    name: 'Comp.Vote',
    description:
      'Participate in Compound Governance via signature to save on gas fees, without having to send your transaction on-chain. ',
    developer: 'arr00 and anish',
    links: {
      github: 'https://github.com/Comp-Vote/comp.vote',
      website: 'https://comp.vote/',
    },
    permissions: {
      sign: '*',
      popups: true,
      modals: true,
    },
    source: {
      url: 'https://comp.vote/?embedded',
    },
    supportedMarkets: 'all',
  },
  {
    id: 'defisaver',
    name: 'DeFi Saver',
    description:
      'Easily rebalance your Compound position in a single transaction and set up automated liquidation protection.',
    developer: 'DeFi Saver',
    links: {
      github: 'https://github.com/defisaver/defisaver-v3-contracts',
      website: 'https://defisaver.com/',
    },
    permissions: {
      sudo: true,
    },
    source: {
      url: 'https://app.defisaver.com/',
    },
    supportedMarkets: {
      '1_USDC_0xc3d688B66703497DAA19211EEdff47f25384cdc3': null,
      '1_USDT_0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840': null,
      '1_USDS_0x5D409e56D886231aDAf00c8775665AD0f9897b56': null,
      '1_ETH_0xA17581A9E3356d9A858b789D68B4d866e593aE94': null,
      '1_wstETH_0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3': null,
      '42161_USDC_0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf': null,
      '42161_USDCe_0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA': null,
      '42161_ETH_0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486': null,
      '10_USDC_0x2e44e174f7D53F0212823acC11C01A11d58c5bCB': null,
      '10_USDT_0x995E394b8B2437aC8Ce61Ee0bC610D617962B214': null,
      '10_WETH_0xE36A30D249f7761327fd973001A32010b521b6Fd': null,
      '8453_USDC_0xb125E6687d4313864e53df431d5425969c15Eb2F': null,
      '8453_USDbC_0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf': null,
      '8453_ETH_0x46e6b214b524310239732D51387075E0e70970bf': null,
    },
  },
  {
    id: 'collateral_swap',
    name: 'Collateral Swap',
    description:
      'Swap collateral assets directly in Compound without unwinding your borrow position, saving time and complexity.',
    sub_description: 'Note, a Wido service fee of 0.3% per swap is associated with this extension. ',
    developer: 'Wido Labs',
    links: {
      github: 'https://github.com/widolabs/compound-collateral-extension-ui',
      website: 'https://www.joinwido.com/',
    },
    permissions: {
      sign: '*',
    },
    source: {
      url: 'https://ipfs.fleek.co/ipfs/QmcEEQekV9Vz4oN519uBsPLqjXUs7YathsvGvjNtbC3Y88/embedded.html',
    },
    supportedMarkets: {
      '1_USDC_0xc3d688B66703497DAA19211EEdff47f25384cdc3': null,
      '1_WETH_0xA17581A9E3356d9A858b789D68B4d866e593aE94': null,
      '137_USDC_0xF25212E676D1F7F89Cd72fFEe66158f541246445': null,
      '42161_USDC_0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA': null,
    },
  },
  {
    id: 'sandbox',
    name: 'Sandbox Extension',
    description:
      "Sandbox environment to test your extension! Update the source below to your extension's embedded URL, and load this page to preview what it would look like on the official dapp.",
    developer: 'N/A',
    links: {
      github: 'https://github.com/',
      website: 'https://twitter.com/',
    },
    permissions: {
      sudo: true,
    },
    source: {
      url: null,
    },
    supportedMarkets: 'all',
  },
];

import { CHAINS } from '@constants/chains';
import {
  BaseAssetWithState,
  CometState,
  MarketState,
  ProtocolState,
  ProtocolAndAccountState,
  ProtocolAndMarketsState,
  RewardAccountStateInfo,
  RewardsState,
  StateType,
  TransactionActionType,
  HistoryItemType,
  TransactionEventType,
} from '@types';

import { MAX_UINT256, BASE_FACTOR, getCapacity, getCollateralValue } from './numbers';

// MOCK DATA
const USDC = {
  address: '0x5014657d8Af6B2763db479dEbf41a8fddf2bAa0B',
  symbol: 'USDC',
  decimals: 6,
  name: 'USD Coin',
  baseAssetPriceInDollars: 100000000n,
};
const ETH = {
  address: '',
  symbol: 'ETH',
  decimals: 18,
  name: 'Ether',
  priceFeed: '',
  price: BigInt(2_540.34e8),
  collateralFactor: BigInt(0.8e18),
  liquidateCollateralFactor: BigInt(0.9e18),
  liquidationFactor: BigInt(0.95e18),
  supplyCap: 0n, // XXX add better mock values
  totalSupply: 0n, // XXX add better mock values
};
const LINK = {
  address: '',
  symbol: 'LINK',
  priceFeed: '',
  decimals: 18,
  name: 'Chainlink',
  price: BigInt(12.9e8),
  collateralFactor: BigInt(0.8e18),
  liquidateCollateralFactor: BigInt(0.85e18),
  liquidationFactor: BigInt(0.93e18),
  supplyCap: 0n, // XXX add better mock values
  totalSupply: 0n, // XXX add better mock values
};
const COMP = {
  address: '',
  symbol: 'COMP',
  decimals: 18,
  name: 'Compound',
  priceFeed: '',
  price: BigInt(99.06e8),
  priceUsd: BigInt(99.06e8),
  collateralFactor: BigInt(0.8e18),
  liquidateCollateralFactor: BigInt(0.9e18),
  liquidationFactor: BigInt(0.93e18),
  supplyCap: 0n, // XXX add better mock values
  totalSupply: 0n, // XXX add better mock values
};
const DAI = {
  address: '',
  symbol: 'DAI',
  decimals: 18,
  name: 'Dai',
  priceFeed: '',
  price: BigInt(1.0e8),
  collateralFactor: BigInt(0.98e18),
  liquidateCollateralFactor: BigInt(0.99e18),
  liquidationFactor: BigInt(0.95e18),
  supplyCap: 0n, // XXX add better mock values
  totalSupply: 0n, // XXX add better mock values
};
const UNI = {
  address: '',
  symbol: 'UNI',
  decimals: 18,
  name: 'Uniswap',
  priceFeed: '',
  price: BigInt(8.28e8),
  collateralFactor: BigInt(0.8e18),
  liquidateCollateralFactor: BigInt(0.85e18),
  liquidationFactor: BigInt(0.93e18),
  supplyCap: 0n, // XXX add better mock values
  totalSupply: 0n, // XXX add better mock values
};
const WBTC = {
  address: '',
  symbol: 'WBTC',
  decimals: 18,
  name: 'Wrapped BTC',
  priceFeed: '',
  price: BigInt(38_738.12e8),
  collateralFactor: BigInt(0.8e18),
  liquidateCollateralFactor: BigInt(0.85e18),
  liquidationFactor: BigInt(0.93e18),
  supplyCap: 0n, // XXX add better mock values
  totalSupply: 0n, // XXX add better mock values
};
const earnAPR = BigInt(0.0475e18);
const borrowAPR = BigInt(0.0642e18);
const earnRewardsAPR = BigInt(0.0175e18);
const borrowRewardsAPR = BigInt(0.0242e18);
const minBorrow = BigInt(100e6);
const baseAsset = USDC;
const baseAssetPrice = BigInt(1.0e8);

export const getMockState = (borrow: boolean, maybeAccount?: string): CometState => {
  if (maybeAccount !== undefined) {
    return borrow
      ? [StateType.Hydrated, mockProtocolAndAccountStateBorrowing]
      : [StateType.Hydrated, mockProtocolAndAccountStateSupply];
  } else {
    return [StateType.NoWallet, mockProtocolState];
  }
};

export const getMockMarketState = (): MarketState => {
  return [StateType.Hydrated, mockProtocolMarketState];
};

export const getMockRewardsState = (maybeAccount?: string): RewardsState => {
  if (maybeAccount !== undefined) {
    return [StateType.Hydrated, [mockRewardsState]];
  } else {
    return [StateType.NoWallet, [mockRewardsState]];
  }
};

const baseAssetWithState: BaseAssetWithState = {
  ...baseAsset,
  balanceOfComet: 0n, // XXX add better mock value
  minBorrow,
  price: baseAssetPrice,
  priceFeed: '',
};

const mockProtocolState: ProtocolState = {
  borrowAPR,
  earnAPR,
  baseAsset: baseAssetWithState,
  collateralAssets: [LINK, COMP, DAI, ETH, UNI, WBTC],
};

const collateralAssetsForBorrow = [
  {
    ...LINK,
    balance: BigInt(0e18),
    walletBalance: BigInt(0.57e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
  {
    ...COMP,
    balance: BigInt(0e18),
    walletBalance: BigInt(456.9e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
  {
    ...DAI,
    balance: BigInt(25_000_000e18),
    walletBalance: BigInt(1_337.45e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
  {
    ...ETH,
    balance: BigInt(9_841.2e18),
    walletBalance: BigInt(14.99e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
  {
    ...UNI,
    balance: BigInt(0e18),
    walletBalance: BigInt(16_005.29e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
  {
    ...WBTC,
    balance: BigInt(0e18),
    walletBalance: BigInt(0e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
];

const mockProtocolAndAccountStateBorrowing: ProtocolAndAccountState = {
  borrowAPR,
  earnAPR,
  baseAsset: {
    ...baseAssetWithState,
    bulkerAllowance: MAX_UINT256,
    allowance: MAX_UINT256,
    balance: BigInt(-15_500_000.15e6),
    walletBalance: BigInt(1_133_095.14e6),
    borrowCapacity: getCapacity(
      'borrow',
      baseAsset.decimals,
      baseAssetPrice,
      baseAsset.symbol,
      collateralAssetsForBorrow
    ),
  },
  isBulkerAllowed: true,
  collateralAssets: collateralAssetsForBorrow,
  collateralValue: getCollateralValue(collateralAssetsForBorrow),
  liquidationCapacity: getCapacity(
    'liquidation',
    baseAsset.decimals,
    baseAssetPrice,
    baseAsset.symbol,
    collateralAssetsForBorrow
  ),
};

const collateralAssetsForSupply = [
  {
    ...LINK,
    balance: BigInt(0e18),
    walletBalance: BigInt(0.57e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
  {
    ...COMP,
    balance: BigInt(0e18),
    walletBalance: BigInt(456.9e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
  {
    ...DAI,
    balance: BigInt(0e18),
    walletBalance: BigInt(0e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
  {
    ...ETH,
    balance: BigInt(740.157e18),
    walletBalance: BigInt(14.99e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
  {
    ...UNI,
    balance: BigInt(0e18),
    walletBalance: BigInt(16_005.29e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
  {
    ...WBTC,
    balance: BigInt(0e18),
    walletBalance: BigInt(0e18),
    allowance: MAX_UINT256,
    bulkerAllowance: MAX_UINT256,
  },
];

const mockProtocolAndAccountStateSupply: ProtocolAndAccountState = {
  borrowAPR,
  earnAPR,
  baseAsset: {
    ...baseAssetWithState,
    bulkerAllowance: MAX_UINT256,
    allowance: MAX_UINT256,
    balance: BigInt(7_331_867.44e6),
    walletBalance: BigInt(33_095.14e6),
    borrowCapacity: getCapacity(
      'borrow',
      baseAsset.decimals,
      baseAssetPrice,
      baseAsset.symbol,
      collateralAssetsForSupply
    ),
  },
  isBulkerAllowed: true,
  collateralAssets: collateralAssetsForSupply,
  collateralValue: getCollateralValue(collateralAssetsForSupply),
  liquidationCapacity: getCapacity(
    'liquidation',
    baseAsset.decimals,
    baseAssetPrice,
    baseAsset.symbol,
    collateralAssetsForSupply
  ),
};

const collateralAssetsForMarkets = [
  {
    ...LINK,
    liquidationPenalty: BASE_FACTOR - LINK.liquidationFactor,
    reserves: BigInt(1947e18),
    supplyCap: BigInt(45_000_000e18),
    totalSupply: BigInt(7_265_179e18),
  },
  {
    ...COMP,
    liquidationPenalty: BASE_FACTOR - COMP.liquidationFactor,
    reserves: BigInt(1947e18),
    supplyCap: BigInt(5_000_000e18),
    totalSupply: BigInt(2_785_179e18),
  },
  {
    ...DAI,
    liquidationPenalty: BASE_FACTOR - DAI.liquidationFactor,
    reserves: BigInt(14_000_000e18),
    supplyCap: BigInt(5_000_000_000e18),
    totalSupply: BigInt(1_189_785_179e18),
  },
  {
    ...ETH,
    liquidationPenalty: BASE_FACTOR - ETH.liquidationFactor,
    reserves: BigInt(740.157e18),
    supplyCap: BigInt(10_000_000e18),
    totalSupply: BigInt(1_189_785e18),
  },
  {
    ...WBTC,
    liquidationPenalty: BASE_FACTOR - WBTC.liquidationFactor,
    reserves: BigInt(1240.157e18),
    supplyCap: BigInt(1_000_000e18),
    totalSupply: BigInt(96_785e18),
  },
];

const mockProtocolMarketState: ProtocolAndMarketsState = {
  borrowAPR,
  earnAPR,
  baseAsset: baseAssetWithState,
  collateralAssets: collateralAssetsForMarkets,
  cometAddress: '0xcC861650dc6f25cB5Ab4185d4657a70c923FDb27',
  reserves: BigInt(146_000_000e6),
  targetReserves: BigInt(200_000_000e6),
  totalBorrow: BigInt(1_478_000_000e6),
  totalSupply: BigInt(2_896_785_179e6),
  utilization: BigInt(0.5e18),
  factorScale: 1e18,
  borrowRates: [...Array(101).keys()].map((n) => [BigInt(n * 1e16), n * 0.05]),
  supplyRates: [...Array(101).keys()].map((n) => [BigInt(n * 1e16), n * 0.03]),
  marketHistory: [],
  type: 'ProtocolAndMarketState',
};

const mockRewardsState: RewardAccountStateInfo = [
  '1',
  {
    chainInformation: CHAINS[1],
    rewardsStates: [
      {
        chainId: 1,
        comet: '0xcC861650dc6f25cB5Ab4185d4657a70c923FDb27',
        cometRewards: '0x1B0e765F6224C21223AeA2af16c1C46E38885a40',
        baseAsset: baseAssetWithState,
        rewardAsset: COMP,
        amountOwed: BigInt(100e18),
        walletBalance: BigInt(100e18),
        earnRewardsAPR,
        borrowRewardsAPR,
        supplyBalance: BigInt(0),
        borrowBalance: BigInt(15_500_000.15e6),
      },
    ],
  },
];

//Alysia TODO call /account/0xuser/transaction_history?limit=30&market[]=1_0xc3d688B66703497DAA19211EEdff47f25384cdc3,1_0xc3d688B66703497DAA19211EEdff47f25384cdc3,137_0xc3d688B66703497DAA19211EEdff47f25384cdc3&action_type[]=borrow,repay,withdraw,supply,claim,seized,liquidate,transfer to get the raw data from API
export const mockTransactionHistoryResp = {
  cursor: '0dbbazy74fjk==',
  done: false,
  item_count: 10,
  item_limit: 10,
  items: [
    {
      item_type: 'unit' as HistoryItemType,
      transactionHash: '0xff2341dabb...',
      timestamp: 1677806611,
      network: {
        chainId: 1,
      },
      initiated_by: { address: '0xuser' }, // ie. self
      actions: [
        {
          action_type: 'claim' as TransactionActionType,
          event_type: 'claimRewards' as TransactionEventType,
          // Ethereum mainnet CometRewards that belongs to cUSDCv3/cWETHv3
          contract: {
            address: '0x1b0e765f6224c21223aea2af16c1c46e38885a40',
          },
          amount: '5.067',
          token: {
            symbol: 'COMP',
            address: '',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.UNIT,
      transactionHash: '0x7432ffeeee...',
      timestamp: 1677806611,
      network: {
        chainId: 1,
      },
      initiated_by: {
        // can populate profile if one exists for address
        address: '0xdefisaver',
        display_name: 'DeFi Saver',
        image_url: 'https://...',
        account_url: 'https://defisaver.com',
      },
      actions: [
        {
          action_type: TransactionActionType.TRANSFER,
          event_type: TransactionEventType.SUPPLY,
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '379.0006',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.BULK,
      transactionHash: '0xabefdea...',
      timestamp: 1678262400,
      network: {
        chainId: 1,
      },
      initiated_by: { address: '0xuser' }, // ie. self
      actions: [
        {
          action_type: TransactionActionType.SUPPLY,
          event_type: TransactionEventType.SUPPLY,
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '378.0006',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          action_type: TransactionActionType.BORROW,
          event_type: TransactionEventType.WITHDRAW,
          // market is cUSDCv3
          contract: {
            address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
          },
          amount: '12,000.000',
          token: {
            symbol: 'UNI',
            address: '',
          },
        },
        {
          action_type: TransactionActionType.BORROW,
          event_type: TransactionEventType.WITHDRAW,
          // market is cUSDCv3
          contract: {
            address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
          },
          amount: '50,000.0000',
          token: {
            symbol: 'USDC',
            address: '',
          },
        },
        {
          action_type: TransactionActionType.CLAIM,
          event_type: TransactionEventType.CLAIM_REWARDS,
          // Ethereum mainnet CometRewards that belongs to cUSDCv3/cWETHv3
          contract: '0x1b0e765f6224c21223aea2af16c1c46e38885a40',
          amount: '12.0827',
          token: {
            symbol: 'COMP',
            address: '',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.UNIT,
      transactionHash: '0x7432ffeuu',
      timestamp: 1675239400,
      network: 1,
      initiated_by: {
        // can populate profile if one exists for address
        address: '0xdefisaver',
        display_name: 'DeFi Saver',
        image_url: 'https://...',
        account_url: 'https://defisaver.com',
      },
      actions: [
        {
          action_type: TransactionActionType.SUPPLY,
          event_type: TransactionEventType.SUPPLY,
          // market is cUSDCv3
          contract: {
            address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
          },
          amount: '395.0006',
          token: {
            symbol: 'UNI',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.LIQUIDATION,
      transactionHash: '0xdeadbeefeeeee...',
      timestamp: 1675238400,
      network: {
        chainId: 137,
      },
      initiated_by: { address: '0x4788...F881' }, // liquidator
      actions: [
        {
          // AbsorbDebt
          action_type: TransactionActionType.REPAY,
          event_type: TransactionEventType.ABSORB_DEBT,
          // market is polygon-mainnet cUSDC
          contract: {
            address: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
          },
          amount: '1,028,361.3153',
          token: {
            symbol: 'USDC',
            address: '',
          },
        },
        {
          // AbsorbCollateral
          action_type: TransactionActionType.SEIZED,
          event_type: TransactionEventType.ABSORB_COLLATERAL,
          // market is polygon-mainnet cUSDC
          contract: {
            address: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
          },
          token: {
            symbol: 'LINK',
            address: '',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.WITHDRAW_BORROW,
      transactionHash: '0xfeedfeedee...',
      timestamp: 1677806110,
      network: {
        chainId: 1,
      },
      initiated_by: { address: '0xuser' }, // ie self
      actions: [
        {
          // Withdraw
          action_type: TransactionActionType.WITHDRAW,
          event_type: TransactionEventType.WITHDRAW, // presentValue >= 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '100.0000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          // Withdraw (same one as above!)
          action_type: TransactionActionType.BORROW,
          event_type: TransactionEventType.WITHDRAW, // presentValue < 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '1,000.000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.REPAY_SUPPLY,
      transactionHash: '0xfeedfeeeedee...',
      timestamp: 1672789789,
      network: {
        chainId: 1,
      },
      initiated_by: { address: '0xuser' }, // ie self
      actions: [
        {
          // Supply
          action_type: TransactionActionType.REPAY,
          event_type: TransactionEventType.SUPPLY, // presentValue < 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '1,000.000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          // Supply (same one as above!)
          action_type: TransactionActionType.SUPPLY,
          event_type: TransactionEventType.SUPPLY, // presentValue >= 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '100.0000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.BULK,
      transactionHash: '0xbeebeeee5554...',
      timestamp: 1672789788,
      network: {
        chainId: 1,
      },
      initiated_by: { address: '0xbulker' },
      actions: [
        {
          // SupplyCollateral
          action_type: TransactionActionType.SUPPLY,
          event_type: TransactionEventType.SUPPLY_COLLATERAL,
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '1,500.0000',
          token: {
            symbol: 'stETH',
            address: '',
          },
        },
        {
          // Withdraw
          action_type: TransactionActionType.WITHDRAW,
          event_type: TransactionEventType.WITHDRAW, // presentValue >= 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '100.0000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          // Withdraw (same one as above!)
          action_type: TransactionActionType.BORROW,
          event_type: TransactionEventType.WITHDRAW, // presentValue < 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '1,000.000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.BULK,
      transactionHash: '0xbeebeeee5554...',
      timestamp: 1672769788,
      network: {
        chainId: 1,
      },
      initiated_by: { address: '0xbulker' },
      actions: [
        {
          // SupplyCollateral
          action_type: TransactionActionType.SUPPLY,
          event_type: TransactionEventType.SUPPLY_COLLATERAL,
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '1,500.0000',
          token: {
            symbol: 'stETH',
            address: '',
          },
        },
        {
          // Withdraw
          action_type: TransactionActionType.WITHDRAW,
          event_type: TransactionEventType.WITHDRAW, // presentValue >= 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '100.0000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          // Withdraw (same one as above!)
          action_type: TransactionActionType.BORROW,
          event_type: TransactionEventType.WITHDRAW, // presentValue < 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '1,000.000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.UNIT,
      transactionHash: '0x7432ffeuu',
      timestamp: 1672749788,
      network: 1,
      initiated_by: {
        // can populate profile if one exists for address
        address: '0xdefisaver',
        display_name: 'DeFi Saver',
        image_url: 'https://...',
        account_url: 'https://defisaver.com',
      },
      actions: [
        {
          action_type: TransactionActionType.SUPPLY,
          event_type: TransactionEventType.SUPPLY,
          // market is cUSDCv3
          contract: {
            address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
          },
          amount: '375.0006',
          token: {
            symbol: 'UNI',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
  ],
};

export const mockTransactionHistoryRespLoadMore = {
  cursor: '0dbbazy74fjk==',
  done: true,
  item_count: 10,
  items: [
    {
      item_type: 'unit' as HistoryItemType,
      transactionHash: '0xff234ee1dabb...',
      timestamp: 1669881600,
      network: {
        chainId: 1,
      },
      initiated_by: { address: '0xuser' }, // ie. self
      actions: [
        {
          action_type: 'claim' as TransactionActionType,
          event_type: 'claimRewards' as TransactionEventType,
          // Ethereum mainnet CometRewards that belongs to cUSDCv3/cWETHv3
          contract: {
            address: '0x1b0e765f6224c21223aea2af16c1c46e38885a40',
          },
          amount: '5.067',
          token: {
            symbol: 'COMP',
            address: '',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.UNIT,
      transactionHash: '0x7432feefe...',
      timestamp: 1667286000,
      network: {
        chainId: 1,
      },
      initiated_by: {
        // can populate profile if one exists for address
        address: '0xdefisaver',
        display_name: 'DeFi Saver',
        image_url: 'https://...',
        account_url: 'https://defisaver.com',
      },
      actions: [
        {
          action_type: TransactionActionType.TRANSFER,
          event_type: TransactionEventType.SUPPLY,
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '390.0006',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.BULK,
      transactionHash: '0xabefdeaee...',
      timestamp: 1665792000,
      network: {
        chainId: 1,
      },
      initiated_by: { address: '0xuser' }, // ie. self
      actions: [
        {
          action_type: TransactionActionType.SUPPLY,
          event_type: TransactionEventType.SUPPLY,
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '378.0006',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          action_type: TransactionActionType.SUPPLY,
          event_type: TransactionEventType.SUPPLY_COLLATERAL,
          // market is cUSDCv3
          contract: {
            address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
          },
          amount: '12,000.000',
          token: {
            symbol: 'UNI',
            address: '',
          },
        },
        {
          action_type: TransactionActionType.BORROW,
          event_type: TransactionEventType.WITHDRAW,
          // market is cUSDCv3
          contract: {
            address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
          },
          amount: '50,000.0000',
          token: {
            symbol: 'USDC',
            address: '',
          },
        },
        {
          action_type: TransactionActionType.CLAIM,
          event_type: TransactionEventType.CLAIM_REWARDS,
          // Ethereum mainnet CometRewards that belongs to cUSDCv3/cWETHv3
          contract: '0x1b0e765f6224c21223aea2af16c1c46e38885a40',
          amount: '12.0827',
          token: {
            symbol: 'COMP',
            address: '',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.UNIT,
      transactionHash: '0x7432eeffe...',
      timestamp: 1675238300,
      network: 1,
      initiated_by: {
        // can populate profile if one exists for address
        address: '0xdefisaver',
        display_name: 'DeFi Saver',
        image_url: 'https://...',
        account_url: 'https://defisaver.com',
      },
      actions: [
        {
          action_type: TransactionActionType.SUPPLY,
          event_type: TransactionEventType.SUPPLY,
          // market is cUSDCv3
          contract: {
            address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
          },
          amount: '388.0006',
          token: {
            symbol: 'UNI',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.LIQUIDATION,
      transactionHash: '0xdeadbeeeef...',
      timestamp: 1675238400,
      network: {
        chainId: 137,
      },
      initiated_by: { address: '0x4788...F881' }, // liquidator
      actions: [
        {
          // AbsorbDebt
          action_type: TransactionActionType.REPAY,
          event_type: TransactionEventType.ABSORB_DEBT,
          // market is polygon-mainnet cUSDC
          contract: {
            address: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
          },
          amount: '1,028,361.3153',
          token: {
            symbol: 'USDC',
            address: '',
          },
        },
        {
          // AbsorbCollateral
          action_type: TransactionActionType.SEIZED,
          event_type: TransactionEventType.ABSORB_COLLATERAL,
          // market is polygon-mainnet cUSDC
          contract: {
            address: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
          },
          token: {
            symbol: 'LINK',
            address: '',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.WITHDRAW_BORROW,
      transactionHash: '0xfeedfeedff...',
      timestamp: 1662015600,
      network: {
        chainId: 1,
      },
      initiated_by: { address: '0xuser' }, // ie self
      actions: [
        {
          // Withdraw
          action_type: TransactionActionType.WITHDRAW,
          event_type: TransactionEventType.WITHDRAW, // presentValue >= 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '100.0000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          // Withdraw (same one as above!)
          action_type: TransactionActionType.BORROW,
          event_type: TransactionEventType.WITHDRAW, // presentValue < 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '1,000.000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.REPAY_SUPPLY,
      transactionHash: '0xfeeeeedfeed...',
      timestamp: 1672789789,
      network: {
        chainId: 1,
      },
      initiated_by: { address: '0xuser' }, // ie self
      actions: [
        {
          // Supply
          action_type: TransactionActionType.REPAY,
          event_type: TransactionEventType.SUPPLY, // presentValue < 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '1,000.000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          // Supply (same one as above!)
          action_type: TransactionActionType.SUPPLY,
          event_type: TransactionEventType.SUPPLY, // presentValue >= 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '100.0000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
    {
      item_type: HistoryItemType.BULK,
      transactionHash: '0xbeebeeee5554...',
      timestamp: 1660953600,
      network: {
        chainId: 1,
      },
      initiated_by: { address: '0xbulker' },
      actions: [
        {
          // SupplyCollateral
          action_type: TransactionActionType.SUPPLY,
          event_type: TransactionEventType.SUPPLY_COLLATERAL,
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '1,500.0000',
          token: {
            symbol: 'stETH',
            address: '',
          },
        },
        {
          // Withdraw
          action_type: TransactionActionType.WITHDRAW,
          event_type: TransactionEventType.WITHDRAW, // presentValue >= 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '100.0000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
        {
          // Withdraw (same one as above!)
          action_type: TransactionActionType.BORROW,
          event_type: TransactionEventType.WITHDRAW, // presentValue < 0
          // market is cWETHv3
          contract: {
            address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
          },
          amount: '1,000.000',
          token: {
            symbol: 'ETH',
            address: '0x0000000000000000000000000000000000000000',
          },
        },
      ],
    },
  ],
};

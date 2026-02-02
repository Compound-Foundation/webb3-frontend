import { HistoryItemType, TransactionActionType, TransactionEventType } from '@types';

export const mockUnitTransactionTransfer = {
  account: '0x888',
  itemType: HistoryItemType.UNIT,
  transactionHash: '0x7432ffeeee...',
  timestamp: 1677806611,
  network: {
    chainId: 1,
  },
  initiatedBy: {
    address: '0xdefisaver',
    displayName: 'DeFi Saver',
    imageUrl: 'https://...',
    accountUrl: 'https://defisaver.com',
  },
  actions: [
    {
      actionType: TransactionActionType.TRANSFER,
      eventType: TransactionEventType.SUPPLY,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
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
};

export const mockUnitTransactionBorrow = {
  account: '0x888',
  itemType: HistoryItemType.UNIT,
  transactionHash: '0x7432ffeeee...',
  timestamp: 1677806611,
  network: {
    chainId: 1,
  },
  initiatedBy: {
    address: '0xdefisaver',
    displayName: 'DeFi Saver',
    imageUrl: 'https://...',
    accountUrl: 'https://defisaver.com',
  },
  actions: [
    {
      actionType: TransactionActionType.BORROW,
      eventType: TransactionEventType.SUPPLY,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
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
};

export const mockUnitTransactionRepay = {
  account: '0x888',
  itemType: HistoryItemType.UNIT,
  transactionHash: '0x7432ffeeee...',
  timestamp: 1677806611,
  network: {
    chainId: 1,
  },
  initiatedBy: {
    address: '0xdefisaver',
    displayName: 'DeFi Saver',
    imageUrl: 'https://...',
    accountUrl: 'https://defisaver.com',
  },
  actions: [
    {
      actionType: TransactionActionType.REPAY,
      eventType: TransactionEventType.SUPPLY,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
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
};

export const mockUnitTransactionWithdraw = {
  account: '0x888',
  itemType: HistoryItemType.UNIT,
  transactionHash: '0x7432ffeeee...',
  timestamp: 1677806611,
  network: {
    chainId: 1,
  },
  initiatedBy: {
    address: '0xdefisaver',
    displayName: 'DeFi Saver',
    imageUrl: 'https://...',
    accountUrl: 'https://defisaver.com',
  },
  actions: [
    {
      actionType: TransactionActionType.WITHDRAW,
      eventType: TransactionEventType.WITHDRAW,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
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
};

export const mockUnitTransactionSupply = {
  account: '0x888',
  itemType: HistoryItemType.UNIT,
  transactionHash: '0x7432ffeeee...',
  timestamp: 1677806611,
  network: {
    chainId: 1,
  },
  initiatedBy: {
    address: '0xdefisaver',
    displayName: 'DeFi Saver',
    imageUrl: 'https://...',
    accountUrl: 'https://defisaver.com',
  },
  actions: [
    {
      actionType: TransactionActionType.SUPPLY,
      eventType: TransactionEventType.SUPPLY,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
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
};

export const mockUnitTransactionClaim = {
  account: '0x888',
  itemType: HistoryItemType.UNIT,
  transactionHash: '0x7432ffeeee...',
  timestamp: 1677806611,
  network: {
    chainId: 1,
  },
  initiatedBy: {
    address: '0xdefisaver',
    displayName: 'DeFi Saver',
    imageUrl: 'https://...',
    accountUrl: 'https://defisaver.com',
  },
  actions: [
    {
      actionType: TransactionActionType.CLAIM,
      eventType: TransactionEventType.CLAIM_REWARDS,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
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
};

export const mockUnitTransactionSeized = {
  account: '0x888',
  itemType: HistoryItemType.LIQUIDATION,
  transactionHash: '0x7432ffeeee...',
  timestamp: 1677806611,
  network: {
    chainId: 1,
  },
  initiatedBy: {
    address: '0xdefisaver',
    displayName: 'DeFi Saver',
    imageUrl: 'https://...',
    accountUrl: 'https://defisaver.com',
  },
  actions: [
    {
      // AbsorbDebt
      actionType: TransactionActionType.REPAY,
      eventType: TransactionEventType.ABSORB_DEBT,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
      // market is polygon-mainnet cUSDC
      contract: {
        address: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
      },
      amount: '1028361.3153',
      token: {
        symbol: 'USDC',
        address: '',
      },
    },
    {
      // AbsorbCollateral
      actionType: TransactionActionType.SEIZED,
      eventType: TransactionEventType.ABSORB_COLLATERAL,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
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
};

export const mockBulkTransaction = {
  itemType: HistoryItemType.BULK,
  transactionHash: '0xabefdea...',
  timestamp: 1678262400,
  network: {
    chainId: 1,
  },
  initiatedBy: { address: '0xuser' }, // ie. self
  actions: [
    {
      actionType: TransactionActionType.SUPPLY,
      eventType: TransactionEventType.SUPPLY,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
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
      actionType: TransactionActionType.BORROW,
      eventType: TransactionEventType.WITHDRAW,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
      contract: {
        address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
      },
      amount: '12000.000',
      token: {
        symbol: 'UNI',
        address: '',
      },
    },
    {
      actionType: TransactionActionType.BORROW,
      eventType: TransactionEventType.WITHDRAW,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
      contract: {
        address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
      },
      amount: '50000.0000',
      token: {
        symbol: 'USDC',
        address: '',
      },
    },
    {
      actionType: TransactionActionType.CLAIM,
      eventType: TransactionEventType.CLAIM_REWARDS,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
      contract: {
        address: '0x1b0e765f6224c21223aea2af16c1c46e38885a40',
      },
      amount: '12.0827',
      token: {
        symbol: 'COMP',
        address: '',
      },
    },
  ],
};

export const mockLiquidationTransaction = {
  account: '0x888',
  itemType: HistoryItemType.LIQUIDATION,
  transactionHash: '0x7432ffeeee...',
  timestamp: 1677806611,
  network: {
    chainId: 1,
  },
  initiatedBy: {
    address: '0xdefisaver',
    displayName: 'DeFi Saver',
    imageUrl: 'https://...',
    accountUrl: 'https://defisaver.com',
  },
  actions: [
    {
      // AbsorbDebt
      actionType: TransactionActionType.REPAY,
      eventType: TransactionEventType.ABSORB_DEBT,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
      // market is polygon-mainnet cUSDC
      contract: {
        address: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
      },
      amount: '1028361.3153',
      token: {
        symbol: 'USDC',
        address: '',
      },
    },
    {
      // AbsorbCollateral
      actionType: TransactionActionType.SEIZED,
      eventType: TransactionEventType.ABSORB_COLLATERAL,
      cometAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
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
};

export const mockTransactions = {
  cursor: '0dbbazy74fjk==',
  done: false,
  item_count: 10,
  item_limit: 10,
  items: [mockUnitTransactionTransfer, mockBulkTransaction],
};

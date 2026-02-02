type Decimal = {
  value: string;
};

export type Token = {
  address: string;
  decimals: number;
  name: string;
  symbol: string;
};

export type BaseAssetConfig = {
  symbol: string;
  name: string;
  isWrapped?: boolean;
};

export type BaseAsset = BaseAssetConfig &
  Token & {
    minBorrow: bigint;
    priceFeed: string;
  };

export type AssetInfo = Token & {
  priceFeed: string;
  collateralFactor: bigint;
  liquidateCollateralFactor: bigint;
  liquidationFactor: bigint;
  supplyCap: bigint;
};

export type TokenWithState = AssetInfo & {
  totalSupply: bigint;
  price: bigint;
};

export type BaseAssetWithState = BaseAsset & {
  balanceOfComet: bigint;
  price: bigint;
  baseAssetPriceInDollars: bigint;
};

export type TokenWithAccountState = TokenWithState & {
  allowance: bigint;
  balance: bigint;
  bulkerAllowance: bigint;
  walletBalance: bigint;
};

export type BaseAssetWithAccountState = BaseAssetWithState & {
  allowance: bigint;
  balance: bigint;
  borrowCapacity: bigint;
  bulkerAllowance: bigint;
  walletBalance: bigint;
};

export type TokenWithMarketState = TokenWithState & {
  liquidationPenalty: bigint;
  reserves: bigint;
  supplyCap: bigint;
  totalSupply: bigint;
};

export type CTokenWithMarketState = {
  borrowAPR: string;
  borrowCap: string;
  borrowRewardsAPR: string;
  collateralFactor: string;
  name: string;
  price: string;
  reserves: string;
  supplyAPR: string;
  supplyRewardsAPR: string;
  symbol: string;
  totalBorrow: string;
  totalSupply: string;
  borrowRates: [bigint, number][];
  supplyRates: [bigint, number][];
  reserveFactor: string;
  unformattedTotalBorrow: number;
  unformattedTotalSupply: number;
  utilization: bigint;
};

export type CToken = {
  borrow_cap: Decimal;
  borrow_rate: Decimal;
  cash: Decimal;
  collateral_factor: Decimal;
  comp_borrow_apy: Decimal;
  comp_supply_apy: Decimal;
  exchange_rate: Decimal;
  interest_rate_model_address: string;
  name: string;
  number_of_borrowers: number;
  number_of_suppliers: number;
  reserve_factor: Decimal;
  reserves: Decimal;
  supply_rate: Decimal;
  symbol: string;
  token_address: string;
  total_borrows: Decimal;
  total_supply: Decimal;
  underlying_address: string;
  underlying_name: string;
  underlying_price: Decimal;
  underlying_symbol: string;
};

export enum StateType {
  Loading = 'loading',
  NoWallet = 'no-wallet',
  Hydrated = 'hydrated',
}

export enum MeterRiskLevel {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}

export type V3MarketApiBucket = {
  timestamp: number;
  total_collateral_value: number;
  total_borrow_value: number;
  supply_apr: number;
  borrow_apr: number;
};

export type V3GovernanceApiProposal = {
  title: string;
  end_block: number;
  start_block: number;
  id: number;
  for_votes: number;
  against_votes: number;
};

export type MarketHistoricalBucket = {
  blockTimestamp: number;
  supplyTotal: number;
  borrowTotal: number;
  supplyRate: number;
  borrowRate: number;
};

export type ProtocolState = {
  baseAsset: BaseAssetWithState;
  borrowAPR: bigint;
  collateralAssets: TokenWithState[];
  earnAPR: bigint;
};

export type ProtocolAndAccountState = Omit<ProtocolState, 'baseAsset' | 'collateralAssets'> & {
  baseAsset: BaseAssetWithAccountState;
  collateralAssets: TokenWithAccountState[];
  collateralValue: bigint;
  isBulkerAllowed: boolean;
  liquidationCapacity: bigint;
};

export type ProtocolAndMarketsState = Omit<ProtocolState, 'collateralAssets'> & {
  borrowRates: [bigint, number][];
  collateralAssets: TokenWithMarketState[];
  cometAddress: string;
  factorScale: number;
  marketHistory: MarketHistoricalBucket[];
  reserves: bigint;
  supplyRates: [bigint, number][];
  targetReserves: bigint;
  totalBorrow: bigint;
  totalSupply: bigint;
  utilization: bigint;
  type: 'ProtocolAndMarketState';
};

export type V2ProtocolState = {
  cTokens: CTokenWithMarketState[];
  totalBorrow: string;
  totalSupply: string;
  marketHistory: MarketHistoricalBucket[];
  type: 'V2ProtocolState';
};

export type DisplayAccount = {
  address: string;
  displayName?: string;
  imageUrl?: string;
  votes?: string;
  voteWeight?: string;
};

// matches responses for states in Contract enum
export enum ProposalStateEnum {
  Pending = 'review',
  Active = 'active',
  Succeeded = 'passed',
  Failed = 'failed',
  Queued = 'queued',
  Executed = 'executed',
  Canceled = 'canceled',
  Expired = 'expired',
}

export enum DelegateTypeEnum {
  Delegated = 'delegated',
  Undelegated = 'undelegated',
  Self = 'self',
}

export enum VoteValueEnum {
  Against,
  For,
  Abstain,
}

export type VoteReceipt = {
  voted: boolean;
  value: VoteValueEnum;
  proposalId: bigint;
};

export type BlockProposalState = {
  state: ProposalStateEnum;
  startBlock: number;
  endBlock?: number;
};

export type UnixProposalState = {
  state: ProposalStateEnum;
  startTime: number;
  endTime: number;
};

export type BlockProposal = {
  id: bigint;
  title: string;
  description: string;
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
  startBlock: bigint;
  endBlock: bigint;
  eta: bigint;
  state: BlockProposalState;
};

export type Proposal = Omit<BlockProposal, 'state'> & {
  state: UnixProposalState;
};

export type CompAccount = {
  address: string;
  balance: bigint;
  votes: bigint;
  delegateType: DelegateTypeEnum;
  delegate: string;
};

export type ProposalAction = {
  title: string;
  subtitles: string[];
  target: string;
  value: bigint;
  signature: string;
  data: string;
};

export type VoteNoAccountState = {
  proposals: Proposal[];
  chainKey: string;
  chainId: number;
  decimals: number;
  canWrite: boolean;
  proposalThreshold: bigint;
  compAddress: string;
  govAddress: string;
};

export type VoteAccountState = VoteNoAccountState & {
  compAccount: CompAccount;
  voteReceipts: Map<bigint, VoteReceipt>;
};

export type RewardsTokenState = {
  chainId: number;
  comet: string;
  cometRewards: string;
  baseAsset: BaseAsset;
  rewardAsset: Token & { price: bigint };
  earnRewardsAPR: bigint;
  borrowRewardsAPR: bigint;
};

export type AccountRewardsState = RewardsTokenState & {
  amountOwed: bigint;
  walletBalance: bigint;
  supplyBalance: bigint;
  borrowBalance: bigint;
};

export interface ChainInformation {
  chainId: number;
  url: string;
  key: string;
  name: string;
  nativeToken: {
    name: string;
    symbol: string;
    decimals: number;
  };
  v3ApiNetworkKeyOverride?: string;
  assetOverrides: {
    [address: string]: Omit<Token, 'decimals'>;
  };
  unwrappedCollateralAssets: {
    [address: string]: Omit<Token, 'decimals'>;
  };
  extraPriceFeeds: {
    nativeTokenToUsd: string; //TODO: Should we just collapse this info into just tokensToUsd below?
    rewards: { [symbol: string]: string };
    otherBaseTokensToUsd: { [symbol: string]: string };
  };
  blockExplorerUrls: string[];
  testnet: boolean;
  walletRpcUrls: string[];
}

export type MarketData = {
  baseAsset: BaseAssetConfig;
  chainInformation: ChainInformation;
  iconPair: [string, string];
  marketAddress: string;
  bulkerAddress: string;
  fauceteerAddress?: string;
  rewardsAddress?: string;
  type: 'MarketData';
};

export type MarketDataLoaded = Omit<MarketData, 'baseAsset' | 'type'> & {
  baseAsset: BaseAsset;
  baseMinForRewards: bigint;
  baseTrackingSupplySpeed: bigint;
  baseTrackingBorrowSpeed: bigint;
  collateralAssets: AssetInfo[];
  trackingIndexScale: bigint;
  type: 'MarketDataLoaded';
};

/**
 * MarketSummary type from the v3-api
 */
export type MarketSummary = {
  chainId: number;
  comet: {
    address: string;
  };
  borrowAPR: bigint;
  supplyAPR: bigint;
  /**
   * Total borrow value in USD
   */
  totalBorrowValue: bigint;
  /**
   * Total supply value in USD
   */
  totalSupplyValue: bigint;
  /**
   * Total collateral value in USD
   */
  totalCollateralValue: bigint;
  utilization: bigint;
  timestamp: number;
  collateralAssetSymbols: string[];
  date: string;
};

export type AggregatedHistoricalSummary = {
  /**
   * Total borrow value in USD
   */
  totalBorrowValue: bigint;
  /**
   * Total supply value in USD
   */
  totalSupplyValue: bigint;
  /**
   * Total collateral value in USD
   */
  totalCollateralValue: bigint;
  date: string;
};

export type LatestMarketSummaries = MarketSummary[];
export type HistoricalMarketSummaries = AggregatedHistoricalSummary[];

export type MarketDataLoading = [StateType.Loading, MarketData | undefined];
export type MarketDataHydrated = [StateType.Hydrated, MarketDataLoaded | MarketData];
export type MarketDataState = MarketDataLoading | MarketDataHydrated;

export type SelectedMarketData = {
  selectedMarket: MarketDataState;
  selectMarket: (market: MarketData, switchWriteNetwork?: boolean) => void;
  selectMarketByAddress: (chainId: number, comet: string, switchWriteNetwork?: boolean) => void;
};

export type CometStateLoading = [StateType.Loading, undefined | ProtocolState];
export type CometStateNoWallet = [StateType.NoWallet, ProtocolState];
export type CometStateHydrated = [StateType.Hydrated, ProtocolAndAccountState];
export type CometState = CometStateLoading | CometStateNoWallet | CometStateHydrated;

export type MarketOverviewStateLoading = [StateType.Loading];
export type MarketOverviewStateHydrated = [
  StateType.Hydrated,
  {
    latestMarketSummaries: LatestMarketSummaries;
    historicalMarketSummaries: HistoricalMarketSummaries;
  }
];
export type MarketOverviewState = MarketOverviewStateLoading | MarketOverviewStateHydrated;

export type MarketStateLoading = [StateType.Loading];
export type MarketStateHydrated = [StateType.Hydrated, ProtocolAndMarketsState | V2ProtocolState];
export type MarketState = MarketStateLoading | MarketStateHydrated;

export type VoteStateLoading = [StateType.Loading];
export type VoteStateNoWallet = [StateType.NoWallet, VoteNoAccountState];
export type VoteStateHydrated = [StateType.Hydrated, VoteAccountState];
export type VoteState = VoteStateLoading | VoteStateNoWallet | VoteStateHydrated;

export type RewardStateInfo = [string, { chainInformation: ChainInformation; rewardsStates: RewardsTokenState[] }];
export type RewardAccountStateInfo = [
  string,
  { chainInformation: ChainInformation; rewardsStates: AccountRewardsState[] }
];
export type RewardsStateLoading = [StateType.Loading];
export type RewardsStateNoWallet = [StateType.NoWallet, undefined | RewardStateInfo[]];
export type RewardsStateHydrated = [StateType.Hydrated, undefined | RewardAccountStateInfo[]];
export type RewardsState = RewardsStateLoading | RewardsStateNoWallet | RewardsStateHydrated;

export type ExtensionsAccountEnableState = {
  enabled: string[];
  notEnabled: string[];
};
export type ExtensionsEnableStateHydrated = [StateType.Hydrated, ExtensionsAccountEnableState];
export type ExtensionsEnableStateLoading = [StateType.Loading];
export type ExtensionsEnableState = ExtensionsEnableStateLoading | ExtensionsEnableStateHydrated;

export enum ActionType {
  Borrow = 'borrow',
  ClaimRewards = 'claim',
  Repay = 'repay',
  Supply = 'supply',
  SupplyCollateral = 'supply-collateral',
  Withdraw = 'withdraw',
  WithdrawCollateral = 'withdraw-collateral',
}

export type BaseAssetAction = ActionType.Borrow | ActionType.Supply | ActionType.Repay | ActionType.Withdraw;
export type CollateralAction = ActionType.SupplyCollateral | ActionType.WithdrawCollateral;

export type PendingAction =
  | [BaseAssetAction, BaseAssetWithAccountState, bigint | undefined]
  | [ActionType.SupplyCollateral, TokenWithAccountState, bigint | undefined]
  | [ActionType.WithdrawCollateral, TokenWithAccountState, BaseAssetWithAccountState, bigint | undefined];

export type Action =
  | [BaseAssetAction, BaseAssetWithAccountState, bigint]
  | [CollateralAction, TokenWithAccountState, bigint]
  | [ActionType.ClaimRewards, Token & { price: bigint }, bigint, AccountRewardsState];

export type ActionQueue = {
  addOrUpdateAction: (action: Action) => void;
  clearActions: () => void;
  queueActions: (market: string, actions: Action[]) => void;
  getActions: (
    baseAsset: BaseAssetWithAccountState,
    collateralAssets: TokenWithAccountState[],
    rewardsState: RewardsState
  ) => Action[];
  getPendingAction: (
    baseAsset: BaseAssetWithAccountState,
    collateralAssets: TokenWithAccountState[]
  ) => PendingAction | undefined;
  removeAction: (action: Action) => void;
  setPendingAction: (pendingAction?: PendingAction) => void;
};

export enum ModalType {
  BulkerApprove = 'bulker-approve',
  Bulker = 'bulker',
}

export type SelectedActionModal = ModalType.BulkerApprove | ModalType.Bulker | undefined;

export type BulkerApproveModalProps = {
  isBulkerAllowed: boolean;
  transactions: Transaction[];
  onActionClicked: () => void;
  onCompleteClicked: () => void;
  onRequestClose: () => void;
  transactionPredicate: (transactions: Transaction[]) => Transaction | undefined;
};

export type BulkerModalProps = {
  actions: Action[];
  baseAsset: BaseAssetWithAccountState;
  collateralAssets: TokenWithAccountState[];
  transactions: Transaction[];
  onRequestClose?: () => void;
  transactionPredicate: (transactions: Transaction[]) => Transaction | undefined;
};

export type ActionModalBulker = [ModalType.Bulker, BulkerModalProps];
export type ActionModalBulkerApprove = [ModalType.BulkerApprove, BulkerApproveModalProps];
export type ActionModalState = ActionModalBulker | ActionModalBulkerApprove | undefined;

export enum TransactionState {
  AwaitingConfirmation = 'awaitingConfirmation',
  Pending = 'pending',
}

export type BaseTransaction = {
  id: string;
  key: string;
  networkId: number;
  networkName: string;
  description: string;
  nonce: number;
  callback?: () => void;
};
export type AwaitingConfirmationTransaction = BaseTransaction & {
  state: TransactionState.AwaitingConfirmation;
};
export type PendingTransaction = BaseTransaction & {
  state: TransactionState.Pending;
  hash: string;
};
export type Transaction = AwaitingConfirmationTransaction | PendingTransaction;

export type MarketsByNetwork = {
  [key: number]: { chainInformation: ChainInformation; markets: MarketData[] };
};

export enum Currency {
  USD = 'USD',
  USDC = 'USDC',
  ETH = 'ETH',
  WETH = 'WETH',
  AERO = 'AERO',
  WBTC = 'WBTC',
  RON = 'RON',
}

// START of transaction history types
// XXX When we switch to page folder structure, move to folder
export enum HistoryItemType {
  UNIT = 'Unit',
  BULK = 'Bulk',
  MULTI = 'Multi',
  LIQUIDATION = 'Liquidation',
  REPAY_SUPPLY = 'RepaySupply',
  WITHDRAW_BORROW = 'WithdrawBorrow',
}

export enum TransactionActionType {
  BORROW = 'Borrow',
  REPAY = 'Repay',
  WITHDRAW = 'Withdraw',
  SUPPLY = 'Supply',
  CLAIM = 'Claim',
  SEIZED = 'Seized',
  // LIQUIDATE = 'liquidate', // Liquidation is not an action type it's an event type
  TRANSFER = 'Transfer',
  REFUND = 'Refund',
}

export enum TransactionEventType {
  SUPPLY_COLLATERAL = 'SupplyCollateral',
  WITHDRAW = 'Withdraw',
  CLAIM_REWARDS = 'ClaimRewards',
  ABSORB_DEBT = 'AbsorbDebt',
  ABSORB_COLLATERAL = 'AbsorbCollateral',
  SUPPLY = 'Supply',
}

export type TransactionHistoryItem = {
  itemType: HistoryItemType;
  transactionHash: string;
  timestamp: number; // this is in seconds
  network: {
    chainId: number;
  };
  initiatedBy: DisplayAccount;
  actions: TransactionAction[];
};

export type TransactionHistoryApiResponse = {
  cursor: string;
  done: boolean;
  itemCount: number;
  itemLimit: number;
  items: TransactionHistoryItem[];
};

export type TransactionAction = {
  actionType: TransactionActionType;
  eventType: TransactionEventType;
  cometAddress: string;
  contract: {
    address: string;
  };
  amount?: string;
  token: {
    symbol: string;
    address: string;
  };
};

export type TransactionsAccountState = TransactionHistoryApiResponse & {
  account: string;
};

export type TransactionsStateLoading = [StateType.Loading];
export type TransactionsStateNoWallet = [StateType.NoWallet];
export type TransactionsStateHydrated = [StateType.Hydrated, TransactionsAccountState];
export type TransactionsState = TransactionsStateLoading | TransactionsStateNoWallet | TransactionsStateHydrated;

// END of transaction history types

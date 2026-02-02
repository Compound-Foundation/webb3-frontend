import { CHAINS, isTestnet } from '@constants/chains';
import { LIMIT } from '@hooks/useTransactionHistory';
import { ChainInformation, PendingTransaction, MarketData, MarketDataLoaded, TransactionHistoryItem } from '@types';

import { getGovernanceContractAddress, GovernanceNetworksEnum } from './contracts';

export const COMPOUND_URL = 'https://compound.finance/';
export const V2_URL = 'https://v2-app.compound.finance';
export const GOV_URL = `https://compound.finance/governance`;
export const SUPPORT_URL = `https://medium.com/compound-finance/the-compound-guide-to-supplying-borrowing-crypto-assets-94821f2950a0`;
export const TERMS_URL = `${V2_URL}/#terms`;
export const V3_API_URL = import.meta.env.VITE_V3_API_HOST || 'V3_API_HOST_NOT_CONFIGURED';
export const TIMESTAMP_API = 'https://timestamp.compound.finance';
export const TALLY_URL = 'https://www.tally.xyz';
export const TALLY_GOV_URL = 'https://www.tally.xyz/gov/compound';

export function getBlockExplorerUrl(chainId: number | undefined): string {
  if (chainId !== undefined) {
    const chainInfo: ChainInformation = CHAINS[chainId];
    if (chainInfo.blockExplorerUrls === undefined) {
      throw new Error(`Block explorer URL not set for chain: ${chainId}`);
    }
    return chainInfo.blockExplorerUrls.length > 0 ? chainInfo.blockExplorerUrls[0] : '';
  }
  return '';
}

export function getBlockExplorerUrlForAddress(chainId: number, address: string): string {
  return `${getBlockExplorerUrl(chainId)}/address/${address}`;
}

export function getBlockExplorerUrlForTransaction(transaction: PendingTransaction): string {
  return `${getBlockExplorerUrl(transaction.networkId)}/tx/${transaction.hash}`;
}

export function getBlockExplorerUrlForTransactionHistory(transaction: TransactionHistoryItem): string {
  return `${getBlockExplorerUrl(transaction.network.chainId)}/tx/${transaction.transactionHash}`;
}

export function getMarketDataUrlForMarket(market: MarketData | MarketDataLoaded): string {
  const v3ApiNetworkKey = market.chainInformation.v3ApiNetworkKeyOverride ?? market.chainInformation.key;
  return `${V3_API_URL}/market/${v3ApiNetworkKey}/${market.marketAddress}`;
}

export function getGovernanceUrlForChain(chainKey: string): string {
  return `${V3_API_URL}/governance/${chainKey}`;
}

export function getTallyProfileForChain(chainId: number, address: string): string {
  const [governor] = getGovernanceContractAddress(
    isTestnet(chainId) ? GovernanceNetworksEnum.Testnet : GovernanceNetworksEnum.Mainnet
  );
  return `${TALLY_URL}/profile/${address}?governanceId=eip155:${chainId}:${governor}`;
}

export function getTransactionHistoryEndpoint(
  account: string,
  cursor?: string,
  limit?: number,
  useTestnet?: boolean // temporarily hardcode testnet markets to test transaction history
): string {
  const useTestnetSuffix = useTestnet
    ? '&markets[]=11155111_0x2943ac1216979aD8dB76D9147F64E61adc126e96,11155111_0xAec1F48e02Cfb822Be958B68C7957156EB3F0b6e'
    : '';

  return `${V3_API_URL}/account/${account}/transaction_history?${cursor ? `cursor=${cursor}&` : ''}limit=${
    limit || LIMIT
  }${useTestnetSuffix}`;
}

export function getMarketRewardsStateEndpoint(includeTestnets = false): string {
  return `${V3_API_URL}/market/all-networks/all-contracts/rewards/dapp-data${
    includeTestnets ? '?testnets=include' : ''
  }`;
}

export function getAccountRewardsStateEndpoint(account: string, includeTestnets = false): string {
  return `${V3_API_URL}/account/${account}/rewards${includeTestnets ? '?testnets=include' : ''}`;
}

export function getLatestMarketSummaryEndpoint(includeTestnets = false): string {
  return `${V3_API_URL}/market/all-networks/all-contracts/summary${includeTestnets ? '?testnets=include' : ''}`;
}

export function getHistoricalMarketSummaryEndpoint(includeTestnets = false): string {
  return `${V3_API_URL}/market/all-networks/all-contracts/historical/summary${
    includeTestnets ? '?testnets=include' : ''
  }`;
}

export function getV2MarketsUrl(): string {
  return `${V3_API_URL}/legacy/mainnet/ctokens`;
}

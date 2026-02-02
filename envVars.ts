const rpcProviderHost = import.meta.env.VITE_V3_RPC_PROVIDER_HOST || 'RPC_PROVIDER_HOST_NOT_CONFIGURED';
const walletConnectProjectId =
  import.meta.env.VITE_V3_WALLET_CONNECT_PROJECT_ID || 'WALLET_CONNECT_PROJECT_ID_NOT_CONFIGURED';

export const SEPOLIA_URL = `https://${rpcProviderHost}/ethereum-sepolia`;
export const MAINNET_URL = `https://${rpcProviderHost}/ethereum-mainnet`;
export const POLYGON_URL = `https://${rpcProviderHost}/polygon-mainnet`;
export const ARBITRUM_URL = `https://${rpcProviderHost}/arbitrum-mainnet`;
export const SCROLL_URL = 'https://rpc.scroll.io';
export const OPTIMISM_URL = `https://${rpcProviderHost}/optimism-mainnet`;
export const AVALANCHE_URL = `https://${rpcProviderHost}/avalanche-mainnet`;
export const FUJI_URL = `https://${rpcProviderHost}/avalanche-fuji`;
export const BASE_MAINNET_URL = `https://${rpcProviderHost}/base-mainnet`;
export const WALLECT_CONNECT_PROJECT_ID = walletConnectProjectId;
export const MANTLE_URL = `https://${rpcProviderHost}/mantle-mainnet`;
export const LINEA_URL = `https://${rpcProviderHost}/linea-mainnet`;
export const UNICHAIN_URL = `https://${rpcProviderHost}/unichain-mainnet`;
export const RONIN_URL = `https://${rpcProviderHost}/ronin-mainnet`;

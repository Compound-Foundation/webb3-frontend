// const rpcProviderHost = import.meta.env.VITE_V3_RPC_PROVIDER_HOST || 'RPC_PROVIDER_HOST_NOT_CONFIGURED';
const walletConnectProjectId =
  import.meta.env.VITE_V3_WALLET_CONNECT_PROJECT_ID || 'WALLET_CONNECT_PROJECT_ID_NOT_CONFIGURED';
const screeningEndpoint = import.meta.env.VITE_SCREENING_ENDPOINT || 'SCREENING_ENDPOINT_NOT_CONFIGURED';

export const SCREENING_URL = screeningEndpoint;

// TODO: Should be restored to original version before merge it into main
// TODO: Remove yaml file
// export const SEPOLIA_URL = `https://${rpcProviderHost}/ethereum-sepolia`;
// export const MAINNET_URL = `https://rpc.ankr.com/eth/${import.meta.env.VITE_ANKR_KEY}`;
// export const POLYGON_URL = `https://${rpcProviderHost}/polygon-mainnet`;
// export const ARBITRUM_URL = `https://${rpcProviderHost}/arbitrum-mainnet`;
// export const SCROLL_URL = 'https://rpc.scroll.io';
// export const OPTIMISM_URL = `https://${rpcProviderHost}/optimism-mainnet`;
// export const AVALANCHE_URL = `https://${rpcProviderHost}/avalanche-mainnet`;
// export const FUJI_URL = `https://${rpcProviderHost}/avalanche-fuji`;
// export const BASE_MAINNET_URL = `https://${rpcProviderHost}/base-mainnet`;
export const WALLECT_CONNECT_PROJECT_ID = walletConnectProjectId;
// export const MANTLE_URL = `https://${rpcProviderHost}/mantle-mainnet`;
// export const LINEA_URL = `https://${rpcProviderHost}/linea-mainnet`;
// export const UNICHAIN_URL = `https://${rpcProviderHost}/unichain-mainnet`;
// export const RONIN_URL = `https://${rpcProviderHost}/ronin-mainnet`;

export const SEPOLIA_URL = `https://rpc.ankr.com/eth_sepolia/${import.meta.env.VITE_ANKR_KEY}`;
export const MAINNET_URL = import.meta.env.VITE_MAINNET_URL;
export const POLYGON_URL = import.meta.env.VITE_POLYGON_URL;
export const ARBITRUM_URL = import.meta.env.VITE_ARBITRUM_URL;
export const SCROLL_URL = import.meta.env.VITE_SCROLL_URL;
export const OPTIMISM_URL = import.meta.env.VITE_OPTIMISM_URL;
export const AVALANCHE_URL = `https://rpc.ankr.com/avalanche/${import.meta.env.VITE_ANKR_KEY}`;
export const FUJI_URL = `https://rpc.ankr.com/avalanche_fuji/${import.meta.env.VITE_ANKR_KEY}`;
export const BASE_MAINNET_URL = import.meta.env.VITE_BASE_URL;
export const MANTLE_URL = import.meta.env.VITE_MANTLE_URL;
export const LINEA_URL = import.meta.env.VITE_LINEA_URL;
export const UNICHAIN_URL = import.meta.env.VITE_UNICHAIN_URL;
export const RONIN_URL = `https://rpc.ankr.com/ronin/${import.meta.env.VITE_ANKR_KEY}`;
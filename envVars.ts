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

const screeningEndpoint = import.meta.env.VITE_SCREENING_ENDPOINT || 'SCREENING_ENDPOINT_NOT_CONFIGURED';

export const SCREENING_URL = screeningEndpoint;

/**
 * Local-dev escape hatch for wallet screening.
 *
 * The screening worker gates on a CORS Origin allowlist that does not include the
 * dev server's origin, so on `yarn dev` every screen fails closed and the app gates
 * the connected wallet out of view. When this is true, `useAddressScreening` skips
 * the network call and treats the address as allowed.
 *
 * Two conditions, both required:
 *  - `import.meta.env.DEV` — only the dev server. Vite statically replaces this with
 *    `false` in `vite build`, so a deployed build can never take this path.
 *  - no `VITE_SCREENING_ENDPOINT` — set it locally (e.g. in `.env.local`) to point at
 *    a reachable worker and screening runs normally, fail-closed behavior included.
 */
export const SCREENING_DISABLED = Boolean(import.meta.env.DEV) && !import.meta.env.VITE_SCREENING_ENDPOINT;

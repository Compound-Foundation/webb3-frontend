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

/** The values of `import.meta` that decide whether the dev server skips screening. */
export type ScreeningBypassEnvironment = {
  /** `import.meta.env.DEV`. */
  DEV: boolean;
  /** Whether the Vite dev server served this module: `import.meta.hot` is defined. */
  isDevServer: boolean;
  /** `import.meta.env.VITE_SCREENING_ENDPOINT`. */
  VITE_SCREENING_ENDPOINT?: string;
};

/**
 * Whether `useAddressScreening` skips the screening endpoint: only on the Vite dev server with DEV true
 * and no endpoint configured. See `SCREENING_DISABLED`.
 */
export function isScreeningBypassed({
  DEV,
  isDevServer,
  VITE_SCREENING_ENDPOINT,
}: ScreeningBypassEnvironment): boolean {
  return Boolean(DEV) && isDevServer && !VITE_SCREENING_ENDPOINT;
}

/**
 * Local-dev escape hatch for wallet screening.
 *
 * The screening worker gates on a CORS Origin allowlist that does not include the
 * dev server's origin, so on `yarn dev` every screen fails closed and the app gates
 * the connected wallet out of view. When this is true, `useAddressScreening` skips
 * the network call and treats the address as allowed.
 *
 * Three conditions, all required:
 *  - `import.meta.env.DEV` is true. Vite derives it from NODE_ENV, not from the mode,
 *    so it is true on the dev server and also in a `vite build` run with
 *    NODE_ENV=development.
 *  - The Vite dev server served this module, so `import.meta.hot` is defined. The dev
 *    server gives every module that reads `import.meta.hot` a hot context. `vite build`
 *    replaces `import.meta.hot` with `undefined` whatever the mode, NODE_ENV or `.env*`
 *    files, so this condition is false in every build. The mode does not matter on the
 *    dev server: `yarn dev` and `yarn dev --mode playground` both meet it.
 *  - No `VITE_SCREENING_ENDPOINT`. Set it locally (e.g. in `.env.local`) to point at
 *    a reachable worker and screening runs normally, fail-closed behavior included.
 */
export const SCREENING_DISABLED = isScreeningBypassed({
  DEV: import.meta.env.DEV,
  isDevServer: import.meta.hot !== undefined,
  VITE_SCREENING_ENDPOINT: import.meta.env.VITE_SCREENING_ENDPOINT,
});

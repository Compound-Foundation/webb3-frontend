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

/** The values of `import.meta.env` that decide whether the dev server skips screening. */
export type ScreeningBypassEnv = { DEV: boolean; MODE: string; VITE_SCREENING_ENDPOINT?: string };

/**
 * Whether `useAddressScreening` skips the screening endpoint: only on the local dev server with no
 * endpoint configured. See `SCREENING_DISABLED`.
 */
export function isScreeningBypassed({ DEV, MODE, VITE_SCREENING_ENDPOINT }: ScreeningBypassEnv): boolean {
  return Boolean(DEV) && MODE === 'development' && !VITE_SCREENING_ENDPOINT;
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
 *  - `import.meta.env.MODE` is `development`. Vite sets the mode from `--mode`: the dev
 *    server (`vite`, `yarn dev`) uses `development`, and `vite build` uses `production`
 *    whatever NODE_ENV says.
 *  - `import.meta.env.DEV` is true. Vite derives `DEV` and `PROD` from NODE_ENV, not
 *    from the mode, so `NODE_ENV=development vite build` compiles DEV=true and
 *    PROD=false. Neither flag alone tells the dev server from such a build, so the mode
 *    check above is what keeps the bypass off in every `vite build`.
 *  - no `VITE_SCREENING_ENDPOINT` — set it locally (e.g. in `.env.local`) to point at
 *    a reachable worker and screening runs normally, fail-closed behavior included.
 *
 * Do not rely on a build removing the branch that reads this flag. Whether Rollup
 * drops it depends on how the expression is written. The flag is false in every
 * `vite build` either way.
 */
export const SCREENING_DISABLED = isScreeningBypassed({
  DEV: import.meta.env.DEV,
  MODE: import.meta.env.MODE,
  VITE_SCREENING_ENDPOINT: import.meta.env.VITE_SCREENING_ENDPOINT,
});

export const WALLECT_CONNECT_PROJECT_ID =
  import.meta.env.VITE_V3_WALLET_CONNECT_PROJECT_ID || 'WALLET_CONNECT_PROJECT_ID_NOT_CONFIGURED';

export const SEPOLIA_URL = import.meta.env.VITE_SEPOLIA_URL;
export const MAINNET_URL = import.meta.env.VITE_MAINNET_URL;
export const POLYGON_URL = import.meta.env.VITE_POLYGON_URL;
export const ARBITRUM_URL = import.meta.env.VITE_ARBITRUM_URL;
export const SCROLL_URL = import.meta.env.VITE_SCROLL_URL;
export const OPTIMISM_URL = import.meta.env.VITE_OPTIMISM_URL;
export const AVALANCHE_URL = import.meta.env.VITE_AVALANCHE_URL;
export const FUJI_URL = import.meta.env.VITE_FUJI_URL;
export const BASE_MAINNET_URL = import.meta.env.VITE_BASE_MAINNET_URL;
export const MANTLE_URL = import.meta.env.VITE_MANTLE_URL;
export const LINEA_URL = import.meta.env.VITE_LINEA_URL;
export const UNICHAIN_URL = import.meta.env.VITE_UNICHAIN_URL;
export const RONIN_URL = import.meta.env.VITE_RONIN_URL;

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

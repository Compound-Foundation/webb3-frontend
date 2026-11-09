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

/** The values, read or computed from `import.meta`, that decide whether the dev server skips screening. */
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
 *    so it is true on the dev server under the default NODE_ENV and also in a
 *    `vite build` run with NODE_ENV=development. A dev server started with
 *    NODE_ENV=production has DEV false and screens.
 *  - The Vite dev server served this module, so `import.meta.hot` is defined. The dev
 *    server gives every browser module that reads `import.meta.hot` a hot context (SSR
 *    modules and classic workers get none). `vite build` replaces `import.meta.hot` with
 *    `undefined` whatever the mode, NODE_ENV or `.env*` files, so this condition is false
 *    in every build. A `define` entry for `import.meta.hot` in the Vite configuration
 *    would override that replacement, so the configuration must not define it. The mode
 *    does not matter on the dev server: `yarn dev` and `yarn dev --mode playground` both
 *    meet this condition.
 *  - No `VITE_SCREENING_ENDPOINT`. Set it locally (e.g. in `.env.local`) to point at
 *    a reachable worker and screening runs normally, fail-closed behavior included.
 */
export const SCREENING_DISABLED = isScreeningBypassed({
  DEV: import.meta.env.DEV,
  isDevServer: import.meta.hot !== undefined,
  VITE_SCREENING_ENDPOINT: import.meta.env.VITE_SCREENING_ENDPOINT,
});

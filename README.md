## Getting Started

First, install the components:

```sh
yarn install
```

Then, to run the development server:

```bash
yarn run dev
```

Open [http://localhost:5173](http://localhost:5173) with your browser to see the result.

You can start editing the page by modifying `src/Home.tsx`. The page auto-updates as you edit the file.

[API routes](https://reactrouter.com/) can be accessed on [http://localhost:5173/markets](http://localhost:5173/markets). This endpoint can be edited in `src/Markets.tsx`.

## Development Environment

Developers contributing to this repo are highly encouraged to use [VS Code](https://code.visualstudio.com).

You are free to use you own preferred IDE as well and if you do we ask that you add instructions for adding Typescript types, Prettier formatting and ESLinting to your editor environment as all 3 are required and checked on any PRs.

### VS Code

First go and download vs code here: [VS Code](https://code.visualstudio.com).

Once you have downloaded then you can open the webb3 repo. The repo has a folder called `.vscode` with some configuration files.
`settings.json` - Workspace settings and is used to tell Pretter which files to format. Formatting is perfomed on save.
`extensions.json` - Recommended extensions. Here Prettier and ESlint are both specified and integrate nicely within VSCode.

Note: `.vscode/settings.json` contain workspace settings, but you are free to also specify more of your own User settings so long as they don't conflict with the workplace settings we have specifed.

Install both Prettier and ESLint through VS Code extensions. (They should show up under Extensions > Recommended)

## Required Environment Variables

The application requires the following environment variables to be set in order to function properly:

- `VITE_V3_API_HOST` - The host endpoint used for the v3 api. The Dashboard will function without the api but the Markets page and Rewards balances are rendered from data given by the v3 api.
- `VITE_V3_RPC_PROVIDER_HOST` - An RPC host provider. This app was designed to work with the v3 api Node Proxy but any RPC provider should work. You should make sure your RPC provider supports all of the supported networks to function properly. See [Running the Backend Locally](#running-the-backend-locally).
- `VITE_V3_WALLET_CONNECT_PROJECT_ID` - A Wallet Connect project id used if you want the app to support Wallet Connect.
- `VITE_SCREENING_ENDPOINT` - The wallet address screening endpoint (a Cloudflare Worker that lives in a separate repo). Screening is fail-closed, so in a deployed build an unset or unreachable endpoint blocks every connected wallet.

On the local dev server (`yarn dev`), leaving `VITE_SCREENING_ENDPOINT` unset skips the screening call entirely, so you can connect a wallet locally without an endpoint. Set it (e.g. in `.env.local`) to a worker that allowlists your dev origin if you need to exercise screening locally. This applies to the dev server only — `vite build` always screens.

## Running the Backend Locally

Full local functionality (wallet balances, positions, on-chain reads) requires the `node-provider-proxy` from [`webb3-backend-api`](https://github.com/Compound-Foundation/webb3-backend-api) running alongside this app. Without it, `VITE_V3_RPC_PROVIDER_HOST` has nothing valid to point at and the app will sit on skeleton loaders indefinitely (RPC calls silently fail).

1. Clone the backend repo alongside this one:
   ```sh
   git clone https://github.com/Compound-Foundation/webb3-backend-api.git
   cd webb3-backend-api/node-provider-proxy
   npm install
   ```

2. Get your own API key from an RPC provider — [Alchemy](https://dashboard.alchemy.com/) is the primary provider this proxy uses and has a free tier; Infura and QuickNode are also supported (see `src/providers.ts` for the full mapping). Do not use a production key for local dev.

3. Create `node-provider-proxy/.dev.vars` (gitignored) with your key repeated for whichever networks you need. At minimum, for the primary USDC/ETH mainnet market.  **Note:**A modern Alchemy key works across all its supported networks, so the same value can go in every `alchemy*` line:
   ```
   alchemyEthMainnet=<your Alchemy API key>
   ```
   See `wrangler.toml`'s `[vars]` block for the rest (`alchemyArbMainnet`, `alchemyPolygonMainnet`, `alchemyBaseMainnet`, etc.) if you need other networks.

4. Start the proxy over HTTPS (plain HTTP won't work — this app's RPC URLs are always constructed as `https://`):
   ```sh
   npx wrangler dev --local --local-protocol https
   ```
   This serves on `https://localhost:8787` with a self-signed cert. `allowedHosts` defaults to `[]` (no origin restriction) for local runs, so this bypasses the 401 issue entirely.

5. **One-time only**: visit `https://localhost:8787/` directly in your browser and click through the self-signed-certificate warning (Advanced → Proceed). Browsers remember this exception per-origin, so the frontend's requests to it will go through afterward without further prompts.

6. In this repo's `.env.local`:
   ```
   VITE_V3_RPC_PROVIDER_HOST=localhost:8787
   ```
   Restart `yarn dev` if it's already running to pickup the envvar updates

## Extensions

If you want to develop extensions, please run the extension locally (e.g. on http://localhost:5183) and then set the environment variable `VITE_{EXTENSION}_SOURCE`, e.g.:

```
VITE_COMET_MIGRATOR_SOURCE=http://localhost:5183 yarn dev
```

The app will use that address instead of the configured address to load the app `comet_migrator`.

You can also use:

```
yarn dev --mode playground
```

In playground mode, mainnet will point to `http://localhost:8545`, and all extensions will point to `http://localhost:8545/embedded.html`.

You can also use:

```
VITE_EXTRA_EXTENSIONS=cool VITE_COOL_SOURCE=... yarn dev
```

This will add a new blank extension named `cool`.

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
- `VITE_V3_RPC_PROVIDER_HOST` - An RPC host provider. This app was designed to work with the v3 api Node Proxy but any RPC provider should work. You should make sure your RPC provider supports all of the supported networks to function properly.
- `VITE_V3_WALLET_CONNECT_PROJECT_ID` - A Wallet Connect project id used if you want the app to support Wallet Connect.

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

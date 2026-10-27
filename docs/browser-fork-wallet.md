# Browser fork wallet

The browser integration suite runs the app in Chromium against a local Ethereum mainnet fork, with a test wallet that tests and agents control. Playwright injects an EIP-6963 provider that announces itself as `io.metamask`, so the app lists it through its existing wallet list (`KNOWN_WALLETS`) with no change under `src/`. The wallet behind it queues each request for a decision, signs messages with keys made for the run, and sends transactions only to the fork.

The suite lives in `e2e/`: the harness in `e2e/harness/`, the browser specs in `e2e/specs/`, and the harness's unit tests in `e2e/harness/__tests__/`, which `yarn test` runs with the rest of Jest. The browser specs run only with `yarn test:browser`.

## Prerequisites

- Node 22, as `package.json` pins through Volta, and `yarn install`.
- Foundry's `anvil` 1.2.3 on `PATH`, at `~/.foundry/bin/anvil`, or named by `ANVIL`. Install it with `foundryup --install 1.2.3` (https://getfoundry.sh).
- `openssl`, which makes the run's TLS certificate. macOS and Linux ship one.
- Playwright's browsers, at the version `@playwright/test` pins (1.64.1, Chromium 156):
  - `npx playwright install chromium-headless-shell` for the automated suite.
  - `npx playwright install chromium` as well for the headed interactive session.
- Network access to a mainnet RPC that serves state at block 26244888. By default the harness tries public endpoints, in COM-289's order: drpc, Tenderly, Blast, MEV Blocker, PublicNode. Public endpoints rate-limit; see [Private configuration](#private-configuration).

## Commands

| Command                                       | What it runs                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn test:browser`                           | The whole suite: the `dev` project on the dev server and the `prod-build` project on two production builds. This is the acceptance run.                                                                                                                                                                                                                                                                  |
| `yarn test:browser e2e/specs/signing.spec.ts` | One spec file, with Playwright's usual filters (`-g <title>`, `--project dev`). Any run that selects fewer tests than the whole suite, by title (`-g`, `--grep-invert`), file, line, project or shard, is INCOMPLETE: the summary compares the run's tests with a `--list` of the full suite, and names each test it left out. The production builds run only when the `prod-build` project is selected. |
| `yarn test:browser:dev`                       | The `dev` project only, without the production builds, which take about two minutes. Its summary marks AC7's production coverage **INCOMPLETE**.                                                                                                                                                                                                                                                         |
| `yarn test:browser:open`                      | An interactive session: a headed browser on the app, for an agent or a person to drive. With `BROWSER_WALLET_HEADLESS=1`, a headless one. See [Interactive control](#interactive-control).                                                                                                                                                                                                               |

The suite runs on one worker, because every test shares one fork, and with no retries, so a flaky case shows as a failure. A full run takes about 10 to 15 minutes, most of it in the production builds, Vite's first load, and the screening timeout case.

Each run writes `test-results/browser-fork/<run ID>/`, which Git ignores:

| File                      | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summary.md`              | Every test as passed, FAILED or INCOMPLETE (skipped, interrupted or not run) with its reason; each acceptance criterion from the tests' `@ACn` tags; the fork block and hash; tool versions; the production builds' resolved `DEV` and `PROD`; the proxies' method counts and refusals; and the secret scan. Its verdict is the acceptance verdict: PASS only when every test of the full suite was selected, ran and passed, and the production builds ran. A known acceptance case the suite does not execute yet is a `test.fixme` in the inventory, and keeps its criterion and the verdict INCOMPLETE. A separate line says whether all implemented tests passed. |
| `manifest.json`           | The run's configuration: fork block, hash and endpoint label, tool versions, Git HEAD and whether the tree was dirty, every service's address, the HTTPS trust mode, the production builds, the app's `VITE_*` values (harness ports only), and the path of the token file. It holds no secret.                                                                                                                                                                                                                                                                                                                                                                        |
| `stats.json`              | The RPC proxy's and the upstream proxy's counts, the scan of the production bundles for the run's secrets, and any cleanup problem.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `anvil.log`, `wallet.log` | anvil's output and the wallet's log of requests and decisions, both redacted. Neither holds a key or the token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `html/`, `playwright/`    | Playwright's HTML report, and each failed test's trace, screenshot and attachments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `startup-failure.txt`     | Why the harness did not start, if it did not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `warm-up.json`            | If the first page load did not render, the page's errors, failed requests and blocked requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## What runs

All services listen on 127.0.0.1, on ports the system chooses. The Playwright runner starts them in its global setup and stops them in its teardown.

| Service           | Role                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream proxy    | anvil's only route to mainnet. It forwards a fixed list of reads (`fork.ts`, `UPSTREAM_METHODS`) and refuses every other method. It forwards `eth_getLogs` only by block hash, or for named addresses over at most 10,000 blocks, and reads at most 64 MB of an answer, so no caller can spend a private key's credits on a query of the whole chain. Only this process holds the upstream URL. |
| anvil             | The pinned fork of chain 1, started with `--accounts 0`, so it holds no unlocked account and can sign nothing. The harness checks its chain, client, fork block and hash before the run and before every send.                                                                                                                                                                                  |
| RPC proxy (HTTPS) | The target of the app's `VITE_V3_RPC_PROVIDER_HOST`. `/ethereum-mainnet` forwards the app's reads to anvil. Every write, signing and administrative method (`eth_sendRawTransaction`, `eth_sendTransaction`, `personal_sign`, `anvil_*`, `evm_*`, `debug_*` and the rest) is refused on every route. Other networks answer a JSON-RPC error: the harness forks Ethereum alone.                  |
| Screening stub    | `POST /screen`, with a behaviour per address, and the test extension page at `/extension/`.                                                                                                                                                                                                                                                                                                     |
| Wallet server     | The accounts, the request queue, signing, and sending through anvil. Its control API is below.                                                                                                                                                                                                                                                                                                  |
| Vite              | The dev server, and two production builds served from static servers.                                                                                                                                                                                                                                                                                                                           |

The harness makes a self-signed certificate for 127.0.0.1 with `openssl`, one day long. The browser itself never connects to it: the egress route fetches each browser request in Node (see below). The runner and the test workers add that one certificate to Node's trusted certificates, beside the system's, and disable no verification.

### The browser's boundary

Each test gets a fresh browser context, so each starts from a clean profile. The context reaches only the exact origins it needs: the app, the RPC proxy and the screening stub, and Vite's HMR WebSocket on the dev server. Every other request is aborted and every other WebSocket closed, including the raw anvil port, the upstream proxy, the wallet server, and every production host such as the v3 API, WalletConnect, Coinbase and `rpc.scroll.io`. Service workers are blocked, because Playwright's routes do not see their requests. Each test attaches the list of what was blocked.

The browser makes no request itself. Playwright calls a route for a request's first URL only, and a browser follows a redirect without calling it again, so the route fetches each allowed request in Node with redirects off. It checks each redirect's destination as a request of its own, follows it there, and answers the browser with the final response. A redirect to a destination that is not allowed fails the request before anything is sent there, and is recorded with the URL it came from. Each hop follows the browser's rules: a 303 makes any method but GET and HEAD a GET, a 301 or 302 makes a POST a GET, and those hops drop the body and its headers; a 307 or 308 keeps the method and body. No hop to another origin carries the Authorization header, and no hop copies the Cookie header: the context's cookie jar gives the hop's own cookies.

**No worker can start.** A dedicated or shared worker's own fetch, XHR and WebSocket do not pass through Playwright's routes, so a worker could reach any server, raw anvil included. Every document the route fulfills, top-level or framed, gets the policy `Content-Security-Policy: worker-src 'none'`, beside any policy it already has. A frame made from `about:`, `data:` or `blob:` inherits it. The app starts no worker, so the policy changes nothing it does. `harness-security.spec.ts` tries a dedicated and a shared worker in the app page and in same-origin, other-origin, `data:` and `blob:` frames. Each worker would open a WebSocket and send a fetch and an XHR to a server outside the allowlist, and a WebSocket and a fetch that call `anvil_setBalance` on raw anvil. The test asserts that the server received nothing and that the fork's balance did not change.

**Local Network Access.** Every document the browser loads is fulfilled by the route, so it has no network address, and Chromium's Local Network Access check counts it as public. The check stays on. Only the dev server's origin gets Chromium's `local-network-access` permission, so that Vite's HMR WebSocket to 127.0.0.1 opens. Without HMR, Vite cannot reload a page after it re-optimizes dependencies, and the page loads two copies of React. `routeWebSocket` still decides each WebSocket that a page or frame opens, and the worker policy keeps workers, which `routeWebSocket` does not see, from starting at all.

The provider is injected only into the app's top frame. The page reaches the wallet only through a Playwright binding, whose handler runs in the test worker, checks that the caller is the app's top frame at the app's origin, and accepts two kinds of call: a provider request and the events poll. The per-run token stays in the worker; the page never holds it.

## Configuration

The harness reads no `.env` file. Vite runs with an empty `envDir`, every `VITE_*` variable in the shell is removed (`manifest.json` lists their names), and the harness sets only its own:

| Variable                                         | Dev server                          | Production, no endpoint | Production, allowed |
| ------------------------------------------------ | ----------------------------------- | ----------------------- | ------------------- |
| `VITE_V3_RPC_PROVIDER_HOST`                      | RPC proxy                           | RPC proxy               | RPC proxy           |
| `VITE_SCREENING_ENDPOINT`                        | stub                                | not set                 | stub                |
| `VITE_EXTRA_EXTENSIONS`, `VITE_CFHARNESS_SOURCE` | the test extension                  | not set                 | not set             |
| `VITE_V3_API_HOST`                               | only with `BROWSER_TEST_V3_API_URL` | same                    | same                |

Each production build runs with `NODE_ENV=production`, and the harness refuses to serve one unless Vite resolved `DEV=false` and `PROD=true`. The bundle still holds the bypass's warning text: Vite compiles the flag to `Boolean(false) && true`, which the minifier does not fold, so the branch stays but cannot run. The tests check the behaviour, not the text. Vite keeps an existing `NODE_ENV`, and a build in a process where the dev server had set `development` would compile `DEV=true` and with it the dev-only screening bypass. The builds run before the dev server for that reason.

### Private configuration

None of these is a `VITE_*` variable, because Vite embeds every `VITE_*` variable in the public bundle.

| Variable                    | Use                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_FORK_RPC_URL`      | A private, archive-capable mainnet RPC for anvil, in place of the public endpoints. HTTP(S) only, with the key in the path or query; the harness refuses a user name or password. Only the runner process holds it: the workers never see it, every log is redacted, a private upstream's error text is withheld, and only results of the right shape reach anvil.                                                                              |
| `BROWSER_FORK_BLOCK`        | `pinned` (the default) forks block 26244888 and checks its hash. `latest` forks the endpoint's latest block less 8, and the manifest records the block and hash it chose.                                                                                                                                                                                                                                                                       |
| `BROWSER_TEST_V3_API_URL`   | A public, credential-free HTTPS base URL for the production v3 API, for interactive use. The harness refuses one with a user name, password, query, fragment or key-like path segment, and the browser may only GET or HEAD the paths the app reads under it (`/market`, `/governance`, `/account`, `/legacy`). Its displays are production data, not fork state, and the manifest says so. Keep a credentialed API behind a proxy of your own. |
| `BROWSER_TEST_SKIP_PROD=1`  | Skips the production builds, as `yarn test:browser:dev` does. The summary then marks AC7's production coverage INCOMPLETE.                                                                                                                                                                                                                                                                                                                      |
| `BROWSER_WALLET_HEADLESS=1` | Runs the interactive session headless, for an agent with no display.                                                                                                                                                                                                                                                                                                                                                                            |
| `ANVIL`                     | The anvil binary to use.                                                                                                                                                                                                                                                                                                                                                                                                                        |

When public endpoints rate-limit, anvil can fail to start. The harness then moves to the next public endpoint, as COM-289's runner does. It never retries in the middle of a run. If every endpoint fails, set `BROWSER_FORK_RPC_URL` or try again later.

## Startup, reset and cleanup

The global setup:

1. stops what an earlier run left behind if its runner was killed (see below);
2. makes a private 0700 directory under the system's temporary directory, outside the repository, for the TLS key, the 0600 control token file and the production builds;
3. finds an endpoint that serves the pinned block with the recorded hash, starts the upstream proxy and anvil, verifies the fork, and checks that anvil has no unlocked account;
4. starts the RPC proxy, the screening stub and the wallet server, with a new random token, and takes the fork's baseline snapshot;
5. builds and serves the two production builds, unless skipped;
6. starts the dev server, and loads the app once, so Vite's first dependency optimization is not charged to a test, and to check the browser's trust in the certificate.

Each service registers its own stop as soon as it starts, so a failure at any step stops everything started before it. `startup-failure.txt` says why.

Before each test, the wallet resets: anvil reverts to the baseline snapshot and takes a new one; every account is forgotten and its impersonation stopped (a revert does not stop one); pending requests fail with 4900; delayed decisions are cancelled; long polls end; the chain returns to 1 with only chain 1 known; policies return to manual; and screening behaviours are cleared. The reset starts a new generation, and a request from an earlier generation can no longer be decided. Each test also makes fresh random accounts.

The teardown scans the production bundles for the run's secrets, stops every service, stops anvil with SIGTERM and then SIGKILL after 5 s, and removes the private directory. On Ctrl-C, Playwright runs the same teardown. On SIGTERM the harness runs it and then exits. A signal during start-up stops what has started, and no further service starts. On process exit, as after a Ctrl-C during start-up, anvil is killed through its process handle, and anvil's working directory and the private directory are removed, synchronously, as a last resort.

**After a killed runner.** If the runner is killed with SIGKILL, it cannot stop anvil. The next run stops it: each run records its runner's PID, anvil's PID, anvil's working directory and the upstream proxy's port in `test-results/browser-fork/<run ID>/processes.json`. A later run stops a recorded anvil only when that run's runner is gone and the process is anvil forked from that run's own proxy port, so it never touches another session's anvil, such as COM-289's. If a live process at the recorded PID is not that anvil, the record stays for a person to check. To do it by hand:

```bash
cat test-results/browser-fork/<run ID>/processes.json   # runnerPid, anvilPid, anvilCwd, upstreamProxyPort, privateDir
ps -p <anvilPid> -o command=                              # check that it is anvil --fork-url http://127.0.0.1:<upstreamProxyPort>/
kill <anvilPid>
rm -rf <privateDir> <anvilCwd>
```

An orphaned anvil holds no key, and its upstream proxy has gone with the runner.

## Interactive control

`yarn test:browser:open` starts the services without the production builds, opens a headed browser on the app with the wallet injected, and prints:

```text
Browser fork wallet: interactive session
  App:           http://127.0.0.1:<port>
  Control API:   http://127.0.0.1:<port>
  Token file:    /var/folders/.../cf-browser-wallet-XXXX/control-token
  Manifest:      test-results/browser-fork/<run ID>/manifest.json
  End with:      POST /v1/session/end, or Ctrl-C
```

It never prints the token. The session connects nothing and approves nothing by itself: every request waits for a decision. It runs until `POST /v1/session/end` or Ctrl-C.

For scripted UI control, write a spec that imports `test` and `expect` from `e2e/harness/fixtures.ts` and run it with `yarn test:browser <file>`. Its fixtures give a fresh page with the wallet injected, the `wallet` control client and a `fork` client for reading anvil. The harness exposes no CDP or remote-debugging port, which would be an unauthenticated control surface.

### The control API

Every request needs the bearer token. The server refuses a request with no or a wrong token (401), a `Host` other than `127.0.0.1:<port>`, or any `Origin` header at all, `null` included (403), so no browser page can use it. It sends no CORS headers. Bodies are JSON, at most 1 MB.

Keep the token out of shell history, `set -x` traces and process lists. This helper passes it to curl on standard input rather than as an argument:

```bash
export BROWSER_WALLET_CONTROL_URL=http://127.0.0.1:<port>
export BROWSER_WALLET_TOKEN_FILE=/var/folders/.../control-token
wallet() {
  # `route`, not `path`: zsh ties `path` to PATH.
  local method=$1 route=$2; shift 2
  printf 'header = "authorization: Bearer %s"\n' "$(cat "$BROWSER_WALLET_TOKEN_FILE")" |
    curl -sS -K - -X "$method" -H 'content-type: application/json' "$BROWSER_WALLET_CONTROL_URL$route" "$@"
}

wallet POST /v1/accounts/new -d '{"eth":"10","usdc":"1000"}'          # => {"address":"0x…","kind":"keyed"}
wallet POST /v1/accounts/select -d '{"addresses":["0x…"]}'
# Click Connect Wallet, then MetaMask, in the app. Then:
wallet GET '/v1/requests?status=pending'
wallet POST /v1/requests/<id>/approve -d '{}'
wallet POST /v1/requests/<id>/approve -d '{"delayMs":5000}'
wallet POST /v1/requests/<id>/reject -d '{"code":4001}'
wallet POST /v1/reset -d '{}'
wallet POST /v1/session/end -d '{}'
```

From Node, `e2e/harness/controlClient.ts` gives the same calls, typed, and reads the token file itself:

```ts
import { ControlClient } from './e2e/harness/controlClient';

const wallet = ControlClient.fromEnvironment(); // BROWSER_WALLET_CONTROL_URL and BROWSER_WALLET_TOKEN_FILE
const request = await wallet.waitForRequest({ method: 'eth_sendTransaction' });
await wallet.approve(request.id);
```

| Endpoint                                                                                                            | Does                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/health`, `GET /v1/state`                                                                                   | Health; the wallet's generation, chain, known chains, permitted origin, selected accounts, accounts (address and kind, never a key) and policies.                                                                                                                                                                                                                              |
| `GET /v1/requests?status=&method=`, `GET /v1/requests/:id`                                                          | The queue and its history for this generation. A record holds the method, raw params, origin, chain and selected account when it arrived, status (`pending`, `approved`, `rejected`, `failed`), result or error, and times.                                                                                                                                                    |
| `POST /v1/requests/:id/approve {delayMs?}`                                                                          | Approves now, or after `delayMs`. A request takes one decision: a second one, while the first is scheduled or running, answers 409. The wallet checks the request again when it runs: the account must still be selected and permitted, and the chain the same. A chain-switch request is exempt from the chain check.                                                         |
| `POST /v1/requests/:id/reject {code?, message?, delayMs?}`                                                          | Rejects with `code`, 4001 by default. Use 4902, -32002 or -32603 to inject those errors.                                                                                                                                                                                                                                                                                       |
| `POST /v1/policy {method, policy}`                                                                                  | `manual` (the default), `approve`, or `{"reject": code}` for one queued method, or `*` for all.                                                                                                                                                                                                                                                                                |
| `POST /v1/accounts/new {eth?, usdc?, screening?}`                                                                   | A new random keyed account, impersonated on anvil, funded with ETH and USDC, and screened as `allowed` unless `screening` says otherwise.                                                                                                                                                                                                                                      |
| `POST /v1/accounts/impersonate {address, eth?, usdc?, screening?}`                                                  | An existing address with no key: it can send transactions but not sign messages.                                                                                                                                                                                                                                                                                               |
| `POST /v1/accounts/select {addresses}`                                                                              | The accounts the wallet exposes, the first selected. Emits `accountsChanged` when the app is permitted.                                                                                                                                                                                                                                                                        |
| `POST /v1/chain {chainId}`, `POST /v1/chains/known {chainIds}`                                                      | Changes the wallet's chain (emits `chainChanged`), and sets which chains a switch can reach without 4902.                                                                                                                                                                                                                                                                      |
| `POST /v1/disconnect`                                                                                               | Emits `disconnect` (4900) and `accountsChanged []`, and drops the permission.                                                                                                                                                                                                                                                                                                  |
| `POST /v1/fork/send {from, to, data?, value?, gas?}`                                                                | Sends a set-up transaction from a harness account straight to the fork, without the app, such as an existing position.                                                                                                                                                                                                                                                         |
| `POST /v1/screening {address, behaviour}`, `POST /v1/screening/release {address, outcome}`, `GET /v1/screening/log` | Screening behaviours: `allowed`, `blocked`, `timeout` (never answers; the app gives up after 10 s), `hold` (answers on release), `malformed-text`, `malformed-string`, `malformed-empty`, `error` (500). An address with no behaviour is blocked.                                                                                                                              |
| `GET /v1/calls`, `GET /v1/provider-calls`, `GET /v1/stats`                                                          | Calls answered at once, such as `wallet_revokePermissions`. Every provider call from the page in this generation, those the wallet answered or refused at once included, for a test that claims a method was never called. If a generation makes more calls than the record holds (100,000), the client reports the overflow instead of a partial record. The proxies' counts. |
| `POST /v1/reset`, `POST /v1/session/end`, `GET /v1/session`                                                         | Reset; end the interactive session.                                                                                                                                                                                                                                                                                                                                            |

The provider answers `eth_chainId`, `net_version`, `eth_accounts`, `wallet_getPermissions` and `wallet_revokePermissions` from the wallet's state, and forwards reads to the fork while its chain is 1. It queues `wallet_requestPermissions`, `eth_requestAccounts` (unless already permitted), `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`, `wallet_switchEthereumChain` and `wallet_addEthereumChain`. Any other method answers 4200.

## How the wallet signs and sends

- **Transactions are never signed.** An approved `eth_sendTransaction` goes to anvil's `eth_sendTransaction` from the impersonated sender, with only `from`, `to`, `data`, `value`, `gas` and the fee fields, after the wallet verifies the fork again. Each block is mined 12 s after the previous one, so interest accrual, and every Comet assertion, is the same on each run. No signed chain-1 transaction exists that could be replayed on mainnet.
- **Messages are signed** with a key made for the run (`viem` `generatePrivateKey`), held only in the wallet server's memory. No key is funded on any public chain, anvil's default keys are never used, and no control answer, log or report holds a key.
- An impersonated account has no key, so `personal_sign` and `eth_signTypedData_v4` from it answer 4200.

## What the assertions rely on

Every state and request assertion uses the fork or the wallet's queue:

- **Fork RPC, read from anvil in Node:** receipts (status, sender, contract, canonical block on the same node, 12 s block spacing), USDC balances and allowances, and Comet principals and balances at each receipt's block.
- **The wallet's queue:** the chain, origin, sender, contract, token, spender, amount and value of each request, decoded before it is approved.
- **The app's UI, rendered from fork RPC reads:** the connected account, the USDC wallet balance, the supply position, the pending state and the network-switch prompt. The home page renders positions, balances and markets from RPC alone.

No assertion uses production API data. Without `BROWSER_TEST_V3_API_URL`, the v3 API is not configured, and its displays (market summaries, APR history, rewards and transaction history) are empty or fail; none is asserted. With it, those displays show production data that does not reflect the fork.

Raw-unit tolerances: USDC balances and allowances are exact. Comet's principal and balance are exact against values derived from the supply index of the block that mined each action, with Comet's own rounding (`e2e/harness/contracts.ts`), because a supply of 100 USDC can read back as 99.999999 USDC. USDC (FiatToken) spends even an unlimited allowance, so after approving the maximum and supplying 100 USDC, the allowance is the maximum less 100 USDC.

## Coverage and its limits

| Area                                                                                                       | Covered by                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery and connection (AC2)                                                                             | `connect.spec.ts`                                                                                                                                                             |
| USDC approve, supply and withdraw, requests and fork state (AC3, AC4, AC8)                                 | `usdc-supply-withdraw.spec.ts`, `existing-position.spec.ts`                                                                                                                   |
| Signing (AC5)                                                                                              | `signing.spec.ts`: the extension bridge, the app's one flow that signs, for both methods; direct provider calls for rejection, chain checks, message forms and account checks |
| Rejection, pending and delayed requests, account and chain changes, chain-switch errors, disconnects (AC6) | `wallet-events.spec.ts`                                                                                                                                                       |
| Screening on the dev server (AC7)                                                                          | `screening.spec.ts`, with every behaviour and attempted actions during pending and changed screening                                                                          |
| Production screening (AC7)                                                                                 | `prod-build.spec.ts`: a build with no endpoint fails closed; an allowed control connects; the `NODE_ENV=development` build is a known case not executed                       |
| The harness's boundaries (AC8, AC9)                                                                        | `harness-security.spec.ts`, and the harness unit tests                                                                                                                        |
| Production bundle (AC10)                                                                                   | `bundle.spec.ts`, the teardown's bundle scan, and `bundleBoundary.test.ts`                                                                                                    |

Limits:

- Real MetaMask: its UI, confirmations, simulations and key handling are not covered. WalletConnect, Ledger, Coinbase, Safe and Anchorage are out of scope.
- Transactions are never signed, so transaction serialization and EIP-1559 signing are not covered.
- Impersonation cannot sign messages.
- The fork runs Prague, the latest that anvil 1.2.3 knows. Mainnet runs Osaka. Gas figures can differ.
- Only Ethereum is forked. Other chains answer a JSON-RPC error, and nothing else runs on them.
- The app calls wagmi's `switchChain`, which does not reject to its caller, so `switchWriteNetwork`'s own `catch` branches for 4902, 4001 and -32002 never run. wagmi's connector handles 4902 by adding the chain. The tests assert that sequence and do not cover the app's catch branches.
- The production builds run with `NODE_ENV=production`, as `vite build` does when `NODE_ENV` is unset. A build run with `NODE_ENV=development` compiles `DEV=true`, and with it the dev-only screening bypass, whatever its mode. The harness sets `NODE_ENV` itself, so it does not test that case. The case is a `test.fixme` in `prod-build.spec.ts`, so the summary reports AC7, and the acceptance, INCOMPLETE until the product fix to `envVars.ts` lands and the test runs.
- Playwright routes neither WebRTC nor WebTransport. No harness service speaks either, and the tests do not cover them.
- The screening tests assert that the app made no signing call, from the wallet's record of every provider call, not only from its queue, so a call the wallet refused before queueing still fails the test.
- The screening stub follows the worker's request and response contract, not its real origin allowlist or rate limiting.
- The extension used for signing is a harness test page. Bulker, wrapped lending, rewards, transaction history and extension operator allows are not covered.
- anvil checks no `Host` header and has no credential. While a run lasts, another local process, or a page in another browser through DNS rebinding, can reach it and change the fork's state. It holds no key and its upstream forwards only reads. Run the suite with no untrusted page open.
- The secret scan after a run finds a leak. It does not prevent one. The token never enters the page by design.

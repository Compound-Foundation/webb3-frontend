# Browser fork wallet

The browser integration suite runs the app in Chromium against a local Ethereum mainnet fork, with a test wallet that tests and agents control. Playwright injects an EIP-6963 provider that announces itself as `io.metamask`, so the app lists it through its existing wallet list (`KNOWN_WALLETS`) with no change under `src/`. The wallet behind it queues each request for a decision, signs messages with keys made for the run, and sends transactions only to the fork.

The suite lives in `e2e/`: the harness in `e2e/harness/`, the browser specs in `e2e/specs/`, and the harness's unit tests in `e2e/harness/__tests__/`, which `yarn test` runs with the rest of Jest. The browser specs run only with `yarn test:browser`.

## Prerequisites

- Node 22, as `package.json` pins through Volta, and `yarn install`.
- Foundry's `anvil` 1.9.0 on `PATH`, at `~/.foundry/bin/anvil`, or named by `ANVIL`. Install it with `foundryup --install 1.9.0` (https://getfoundry.sh). The fork cache needs 1.9.0: with an earlier anvil the suite runs uncached. COM-289's wrapped lending fork runner (`scripts/test-wrapped-lending-fork.js`) uses the same anvil; its recorded runs were on 1.2.3.
- `openssl`, which makes the run's TLS certificate. macOS and Linux ship one.
- Playwright's browsers, at the version `@playwright/test` pins (1.64.1, Chromium 156):
  - `npx playwright install chromium-headless-shell` for the automated suite.
  - `npx playwright install chromium` as well for the headed interactive session.
- Network access to a mainnet RPC that serves state at block 26244888. By default the harness tries public endpoints, in COM-289's order: drpc, Tenderly, Blast, MEV Blocker, PublicNode. Public endpoints rate-limit; see [Private configuration](#private-configuration). Once a run has filled [the fork cache](#the-fork-cache), later runs read most of their state from it, but each start and each reset still needs the endpoint.

## Commands

| Command                                       | What it runs                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn test:browser`                           | The whole suite: `dev`, then `dev-server-security` for the probes that broadcast Vite error overlays, plus `prod-build` on two production builds. This is the acceptance run.                                                                                                                                                                                                                            |
| `yarn test:browser e2e/specs/signing.spec.ts` | One spec file, with Playwright's usual filters (`-g <title>`, `--project dev`). Any run that selects fewer tests than the whole suite, by title (`-g`, `--grep-invert`), file, line, project or shard, is INCOMPLETE: the summary compares the run's tests with a `--list` of the full suite, and names each test it left out. The production builds run only when the `prod-build` project is selected. |
| `yarn test:browser:dev`                       | The `dev` project only, without production builds or the `dev-server-security` probe. Its summary remains **INCOMPLETE**.                                                                                                                                                                                                                                                                                |
| `yarn test:browser:open`                      | An interactive session: a headed browser on the app, for an agent or a person to drive. With `BROWSER_WALLET_HEADLESS=1`, a headless one. See [Interactive control](#interactive-control).                                                                                                                                                                                                               |

Each Playwright worker has its own fork lane. Playwright schedules each test on its own (`fullyParallel: true`), so tests from one file can run in different workers at once. There are no retries, so a flaky case shows as a failure. The harness estimates the worker count unless you set it. See [Choosing the worker count](#choosing-the-worker-count).

The [performance experiment record](browser-testing-performance.md) describes opt-in bundled dev, parallel builds, browser pooling and minification. Three matched Linux pairs measured a 28.7% median paired reduction. The Linux half-time target remains unmet.

A separate [native Mac option](browser-testing-performance.md#native-mac-execution-is-a-separate-option) repeated at a 69.81-second median. This changes the host and cache seed. The performance flags default to off, and the Node 22 pin remains unchanged. Vite itself is upgraded.

In the [per-test scheduling benchmarks](#per-test-against-per-file-scheduling), warm four-worker runs took 135, 141 and 157 seconds. Cold runs took 154 seconds with four workers and 270 with two. Set-up took 18–20 seconds warm and 29–33 seconds cold across both scheduling modes. These runs retained baseline failures and the skipped AC7 case, as detailed below.

On `main` at `3c19d18` (2026-11-03), on the benchmark machine with 4 workers and a warm cache, `yarn test:browser:dev` took 142 s and `yarn test:browser` took 161 s. Each run failed one test, `mixed-position.spec.ts:416`, which failed on `main` until COM-369 set a gas limit on sends that name none (see [How the wallet signs and sends](#how-the-wallet-signs-and-sends)). See [the benchmarks below](#benchmarks) for other worker counts and cold caches.

Each run writes `test-results/browser-fork/<run ID>/`, which Git ignores:

| File                             | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `summary.md`                     | Every test as passed, FAILED or INCOMPLETE (skipped, interrupted or not run) with its reason; each acceptance criterion from the tests' `@ACn` tags; the fork block and hash; tool versions; the production builds' resolved `DEV` and `PROD`; the proxies' method counts and refusals; and the secret scan. Its verdict is the acceptance verdict: PASS only when every test of the full suite was selected, ran and passed, and the production builds ran. A known acceptance case the suite does not execute yet is a `test.fixme` in the inventory, and keeps its criterion and the verdict INCOMPLETE. A separate line says whether all implemented tests passed. |
| `manifest.json`                  | The run's configuration: fork block, hash and endpoint label, tool versions, Git HEAD and whether the tree was dirty, every service's address, the HTTPS trust mode, the production builds, the app's `VITE_*` values (harness ports only), and the path of the token file. It holds no secret.                                                                                                                                                                                                                                                                                                                                                                        |
| `stats.json`                     | The RPC proxy's and the upstream proxy's counts, the scan of the production bundles for the run's secrets, and any cleanup problem.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `anvil-<lane>.log`, `wallet.log` | Each lane's anvil output, with a line for each start, and the wallet requests and decisions prefixed by `lane <n>`. Both logs are redacted. Neither holds a key or the token.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `html/`, `playwright/`           | Playwright's HTML report, and each failed test's trace, screenshot and attachments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `startup-failure.txt`            | Why the harness did not start, if it did not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `warm-up.json`                   | If the first page load did not render, the page's errors, failed requests and blocked requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## Iterating and pushing

While iterating, run only the browser specs that cover the change. Before each push that changes code in the browser harness (`e2e/`), wallet connection, transactions, screening, `vite.config.js` or dependencies, run the full `yarn test:browser` once. Run it on a clean tree, at the head being pushed.

### Scoped runs

Pass spec paths, a title filter or a project to select the tests. The project decides whether the production builds run: a run whose projects include `prod-build` builds the two production bundles, whatever specs it selects, unless `BROWSER_TEST_SKIP_PROD=1` is set. A run without `--project dev` includes `prod-build`.

```bash
# Run one spec file on the dev server, without the production builds.
yarn test:browser e2e/specs/connect.spec.ts --project dev

# Run the disconnect cases in one spec file.
yarn test:browser e2e/specs/wallet-events.spec.ts -g disconnect --project dev

# Run every dev-server spec. The production builds are skipped.
yarn test:browser --project dev

# The same, as a package script.
yarn test:browser:dev

# Run screening on the dev server and on the production builds.
yarn test:browser e2e/specs/screening.spec.ts e2e/specs/prod-build.spec.ts
```

Add `prod-build.spec.ts` to a scoped run when the change touches screening, `envVars.ts` or the build, and leave out `--project dev`. Under `--project dev` or `yarn test:browser:dev`, `prod-build.spec.ts` and `bundle.spec.ts` are dropped without an error.

A scoped run's summary says "Scoped run, INCOMPLETE" and names the tests it left out, or "Not an acceptance run, INCOMPLETE" when the harness could not list the full suite. A scoped run is never acceptance evidence.

The spec files below live in `e2e/specs/`. Choose the specs for the source areas the change touches.

| Area of change                                                                                                                                                                                                                                                             | Specs to run                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet connection: `src/components/ConnectWalletModal.tsx`, `src/components/SafeAutoConnect.tsx`, `src/contexts/Web3Context.tsx`, `src/main.tsx`                                                                                                                           | `connect.spec.ts`, `wallet-events.spec.ts`, and `screening.spec.ts`, since every connected address is screened. Safe is not covered: see [Coverage and its limits](#coverage-and-its-limits). |
| Standard transactions: the actions in `src/helpers/`, `useWriteCometState`, `useTransactionManager`, `src/pages/home/components/ActionModal/`                                                                                                                              | `usdc-supply-withdraw.spec.ts`, `existing-position.spec.ts`, `wallet-events.spec.ts`, `mixed-position.spec.ts`                                                                                |
| Wrapped route: `useWriteWrappedState`, `useWrappedAction`, `useLendingRoute`, `useWrappedPosition`, `src/helpers/wrappedActions.ts`, `src/helpers/wrappedPositions.ts`, `src/helpers/queuedExecution.ts`, `src/helpers/lendingRoute.ts`, `src/constants/wrappedMarkets.ts` | `wrapped-queue.spec.ts`, `mixed-position.spec.ts`                                                                                                                                             |
| Parts both routes use: `src/pages/home/index.tsx`, `src/hooks/useActionQueue.ts`, `src/pages/home/components/ActionQueueItem.tsx`, `src/pages/home/components/Masthead.tsx`, `src/pages/home/components/PositionCard.tsx`, and `src/helpers/actions.ts`                    | The specs of both rows above                                                                                                                                                                  |
| Screening: `src/helpers/screening.ts`, `src/hooks/useAddressScreening.ts`, `src/hooks/useDisconnectBlockedWallet.ts`, `src/components/ScreeningErrorOverlay.tsx`, `envVars.ts`                                                                                             | `screening.spec.ts`, `prod-build.spec.ts`, and `wallet-events.spec.ts`, which screens an account change                                                                                       |
| Extensions and signing: `src/pages/extensions/`                                                                                                                                                                                                                            | `signing.spec.ts`, and `screening.spec.ts`, which blocks an extension's signing request after an account change                                                                               |
| Build: `vite.config.js`, `envVars.ts`, the HTML entry points                                                                                                                                                                                                               | `bundle.spec.ts`, `prod-build.spec.ts`                                                                                                                                                        |
| Dependencies                                                                                                                                                                                                                                                               | `bundle.spec.ts`, `prod-build.spec.ts`, and the specs of the areas the dependency serves                                                                                                      |
| Harness: `e2e/harness/`, `e2e/playwright.config.ts`                                                                                                                                                                                                                        | `harness-security.spec.ts`, `dev-server-security.spec.ts`, and the specs that use the changed part. Shared parts need the full suite, as below.                                               |
| Interactive session                                                                                                                                                                                                                                                        | `interactive.session.ts` is the session behind `yarn test:browser:open`, not a test.                                                                                                          |

For a change to shared harness parts, run the full suite. These parts include fixtures, the wallet server, the fork, proxies, lanes, the summary reporter and the Playwright config.

### Pushes and evidence

A push needs the full suite when it changes code in the browser harness (`e2e/`), wallet connection, transactions, screening, `vite.config.js` or dependencies. Extensions are part of wallet connection, and `envVars.ts` is part of screening. A dependency change is any change to `package.json`'s dependencies or to `yarn.lock`. Docs-only pushes and PR-body-only edits do not need the full suite. A merge of the base into the branch needs it when the merge changes code in those areas.

Report these from the full run's `summary.md`:

- The `All implemented tests passed: yes` line, or the base-failure exception below.
- The `Git:` line naming the head of the push that needed the run, with no `(dirty tree)`.
- No `Scoped run, INCOMPLETE` or `Not an acceptance run, INCOMPLETE` line, and a `Production builds:` line that is not `skipped`. A `yarn test:browser:dev` run passes the first two checks, but not this one.
- The summary's path. The line near the end of the output that starts `Browser harness:` ends with `Summary: <path>`.

While `prod-build.spec.ts` holds its `test.fixme`, a run whose implemented tests all pass has the verdict INCOMPLETE, with that one test incomplete. This is expected. A failure takes precedence, so a run with a failed test has the verdict FAIL. `All implemented tests passed: no`, a FAIL verdict, a dirty tree or a different head is not evidence that the pushed head passed.

A test that also fails at the base does not block the push, provided every other implemented test passes. The summary then shows `All implemented tests passed: no` and the verdict FAIL. Report that result as it is, with the failing test, its tracking issue, and the summary of a full run at the base that fails the same test. Any other failure blocks the push.

### Verifiers

A verifier reads the `summary.md` of a full run, at the path the implementer reports, instead of running the full suite again. If no push in the PR changed code in the areas above, no full run is required. Otherwise the verifier reads the summary for the latest push that did, and matches its `Git:` line to that push's head. Later pushes outside those areas need no other full run. The verifier checks the lines above, or the base-failure exception, then runs only the specs its own checks need. If that full run is missing, the implementer still owes it.

### Run time and background commands

A full run took 161 s on the benchmark machine with a warm cache. A cold cache, one worker or a loaded machine makes it longer. On the same day, a `yarn test:browser:dev` run took 331 s with a cold cache, 2 workers, a loaded machine and a public endpoint that rate-limited it.

Agent hosts stop long foreground commands. By default, Claude Code stops a foreground command after 2 minutes and allows at most 10. Both limits are configurable. Start the full run as a background command and wait for it to finish before ending the turn. A run left behind when the turn ends goes unreported.

Do not start a second run while one is going. Two runs compete for the machine, and only one holds the [fork cache](#the-fork-cache) port.

## What runs

All services listen on 127.0.0.1. The system chooses their ports, except for the shared upstream proxy's fixed port when caching. The Playwright runner starts the shared services and lane 0 in global setup, starts other lanes on demand, and stops them in teardown.

| Service           | Role                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upstream proxy    | Every lane's only route to mainnet, through one shared proxy. It forwards a fixed list of reads (`fork.ts`, `UPSTREAM_METHODS`) and refuses every other method. It forwards `eth_getLogs` only by block hash, or for named addresses over at most 10,000 blocks, and reads at most 64 MB of an answer, so no caller can spend a private key's credits on a query of the whole chain. Only this process holds the upstream URL. |
| anvil             | One fork of chain 1 per lane, started with `--accounts 0`, so it holds no unlocked account and can sign nothing. The harness checks its chain, client, fork block and hash before the run and before every send.                                                                                                                                                                                                               |
| RPC proxy (HTTPS) | The target of the app's `VITE_V3_RPC_PROVIDER_HOST`. `/ethereum-mainnet` forwards the app's reads to the fork named by the lane header. Every write, signing and administrative method (`eth_sendRawTransaction`, `eth_sendTransaction`, `personal_sign`, `anvil_*`, `evm_*`, `debug_*` and the rest) is refused on every route. Other networks answer a JSON-RPC error: the harness forks Ethereum alone.                     |
| Screening stub    | `POST /screen`, with separate behaviours, logs and held requests per lane, and the shared test extension page at `/extension/`.                                                                                                                                                                                                                                                                                                |
| Wallet server     | One server per lane for accounts, the request queue, signing, and sending through that lane's anvil. Its control API is below.                                                                                                                                                                                                                                                                                                 |
| Lane server       | Leases a fork lane to each Playwright worker by its parallel index. It uses the run token and the same Host and Origin checks as the wallet server.                                                                                                                                                                                                                                                                            |
| Vite              | The dev server, and two production builds served from static servers.                                                                                                                                                                                                                                                                                                                                                          |

The harness makes a self-signed certificate for 127.0.0.1 with `openssl`, one day long. The browser itself never connects to it: the egress route fetches each browser request in Node (see below). The runner and the test workers add that one certificate to Node's trusted certificates, beside the system's, and disable no verification.

### Fork lanes

A [fork lane](../e2e/harness/forkLanes.ts) has its own anvil, wallet server and screening partition. When caching is enabled, each anvil has a private cache home. By default, each worker also has its own Chromium and Node process. The opt-in [browser pool](browser-testing-performance.md#run-the-opt-in-configuration) shares Chromium servers while retaining separate contexts and worker connections. The lanes share the read-only upstream proxy, the HTTPS RPC proxy, the screening stub, the dev server and both production builds.

A worker leases the lane for its Playwright `parallelIndex` when its first test needs the fixtures. Lane 0 starts during set-up to choose the upstream endpoint. Other lanes start on their first lease, so unused lanes start no anvil. A replacement worker gets the same parallel index and leases the same lane. The wallet reset before each test clears the previous worker's fork changes, accounts, requests and screening state.

If a lane's anvil has exited, the next lease stops that lane and starts it again with the next lane generation. The earlier start's cache remains a promotion candidate, subject to its own gates. The lane generation counts starts and is separate from the wallet generation, which counts resets. Lanes live in the runner, so a worker crash does not remove the runner's ability to stop them.

The app's RPC and screening URLs are compiled into its bundles, so every worker reaches the same two services. The worker's [egress route](../e2e/harness/egress.ts) sets the [lane header](../e2e/harness/laneHeader.ts), `x-cf-harness-lane`, on the first request and every redirect hop to those origins. It replaces any page-supplied value, regardless of letter case, and removes the header from requests to other origins. The RPC proxy forwards reads to that lane's fork. The screening stub answers from that lane's partition. Wallet writes use the Playwright binding to that lane's wallet server, which sends to the same fork.

Both services refuse RPC or screening requests with a missing or invalid lane header. The RPC proxy also refuses a lane whose fork has not started, with JSON-RPC error -32603. The screening stub checks the index against its configured partitions and returns HTTP 403 for an invalid index. It does not check whether the lane's anvil has started. The app treats HTTP 403 as a failed screen.

### The browser's boundary

Each test gets a fresh browser context, so each starts from a clean profile. The context reaches only the exact origins it needs: the app, the RPC proxy and the screening stub, and Vite's HMR WebSocket on the dev server. Every other request is aborted and every other WebSocket closed, including raw anvil ports, the upstream proxy, the wallet servers, the lane server, and every production host such as the v3 API, WalletConnect, Coinbase and `rpc.scroll.io`. Service workers are blocked, because Playwright's routes do not see their requests. Each test attaches the list of what was blocked.

The browser makes no request itself. Playwright calls a route for a request's first URL only, and a browser follows a redirect without calling it again, so the route fetches each allowed request in Node with redirects off. It checks each redirect's destination as a request of its own, follows it there, and answers the browser with the final response. A redirect to a destination that is not allowed fails the request before anything is sent there, and is recorded with the URL it came from. Each hop follows the browser's rules: a 303 makes any method but GET and HEAD a GET, a 301 or 302 makes a POST a GET, and those hops drop the body and its headers; a 307 or 308 keeps the method and body. No hop to another origin carries the Authorization header, and no hop copies the Cookie header: the context's cookie jar gives the hop's own cookies.

**No worker can start.** A dedicated or shared worker's own fetch, XHR and WebSocket do not pass through Playwright's routes, so a worker could reach any server, raw anvil included. Every document the route fulfills, top-level or framed, gets the policy `Content-Security-Policy: worker-src 'none'`, beside any policy it already has. A frame made from `about:`, `data:` or `blob:` inherits it. The app starts no worker, so the policy changes nothing it does. `harness-security.spec.ts` tries a dedicated and a shared worker in the app page and in same-origin, other-origin, `data:` and `blob:` frames. Each worker would open a WebSocket and send a fetch and an XHR to a server outside the allowlist, and a WebSocket and a fetch that call `anvil_setBalance` on raw anvil. The test asserts that the server received nothing and that the fork's balance did not change.

One document has no worker policy: a popup a page opens `noopener` on `about:blank`. It gets no network response, so the route never fulfills it, and in this Chromium its blank document does not inherit the opener's policy. The page cannot reach it, since its reference is null. Code that automation injects into it can start a worker, so a harness context closes every page it did not open itself, as soon as the page appears, and records it in the test's blocked list as a `popup`. `harness-security.spec.ts` tries the page-only variants: `javascript:`, `data:` and `blob:` URLs opened `noopener` and through `noopener` links, a named popup reacquired by name, and a popup whose opener the page clears. It asserts that none reached a server outside the allowlist or raw anvil, and that only the test's own page is left. A spec that needs a second page opens it with `context.newPage()`, which the harness allows.

**Local Network Access.** Every document the browser loads is fulfilled by the route, so it has no network address, and Chromium's Local Network Access check counts it as public. The check stays on. The dev server's top-level origin gets Chromium's `local-network-access` permission, so that Vite's HMR WebSocket to 127.0.0.1 opens. Without HMR, Vite cannot reload a page after it re-optimizes dependencies, and the page loads two copies of React. A top-level page from another origin, such as a production build's, still gets the check. Frames under a dev page inherit the permission whatever their origin, the extension frame included, so the check is not what protects frames. For pages and frames alike, the enforced boundaries are the route, which decides each HTTP request, `routeWebSocket`, which decides each WebSocket a page or frame opens, and the worker policy, which keeps workers, which neither sees, from starting at all.

The provider is injected only into the app's top frame. The page reaches the wallet only through a Playwright binding, whose handler runs in the test worker, checks that the caller is the app's top frame at the app's origin, and accepts two kinds of call: a provider request and the events poll. The per-run token stays in the worker; the page never holds it.

## Configuration

The harness reads no `.env` file. Vite runs with an empty `envDir`, every `VITE_*` variable in the shell is removed (`manifest.json` lists their names), and the harness sets only its own:

| Variable                                         | Dev server                          | Production, no endpoint | Production, allowed |
| ------------------------------------------------ | ----------------------------------- | ----------------------- | ------------------- |
| `VITE_V3_RPC_PROVIDER_HOST`                      | RPC proxy                           | RPC proxy               | RPC proxy           |
| `VITE_SCREENING_ENDPOINT`                        | stub                                | not set                 | stub                |
| `VITE_EXTRA_EXTENSIONS`, `VITE_CFHARNESS_SOURCE` | the test extension                  | not set                 | not set             |
| `VITE_V3_API_HOST`                               | only with `BROWSER_TEST_V3_API_URL` | same                    | same                |

### The announced wallet and the wrapper release controls

The provider announces `io.metamask` unless a spec sets another wallet with `test.use({ harnessWallet: ANCHORAGE_WALLET })` (`e2e/harness/injectedProvider.ts`). `ANCHORAGE_WALLET` announces `com.anchorage.connect`, which makes the app lend through the wrappers on the three wrapped Ethereum markets. Pass the wallet's label to `connectAccount` so that it clicks the right row ("Anchorage Digital").

The committed wrapper registry (`src/constants/wrappedMarkets.ts`) keeps every release control closed, and the harness never changes it. The dev server alone runs a Vite plugin, `openWrappedReleaseControls` (`e2e/harness/releaseControls.ts`), that opens the six controls in the module it serves, so `wrapped-queue.spec.ts` can supply and withdraw through a wrapper. The plugin is declared `apply: 'serve'`, so `vite build`, the harness's production builds included, never runs it, and it uses no `VITE_*` variable. It throws unless it finds exactly six closed controls, and `manifest.json` records `app.wrappedReleaseControls: 'open'`. The controls affect the Anchorage route only, so the specs that announce MetaMask are unaffected.

Each production build runs with `NODE_ENV=production`, and the harness refuses to serve one unless Vite resolved `DEV=false` and `PROD=true`. The bundle still holds the bypass's warning text: Vite compiles the flag to `Boolean(false) && true`, which the minifier does not fold, so the branch stays but cannot run. The tests check the behaviour, not the text. Vite keeps an existing `NODE_ENV`, and a build in a process where the dev server had set `development` would compile `DEV=true` and with it the dev-only screening bypass. The builds run before the dev server for that reason.

### Private configuration

None of these is a `VITE_*` variable, because Vite embeds every `VITE_*` variable in the public bundle.

| Variable                    | Use                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSER_FORK_RPC_URL`      | A private, archive-capable mainnet RPC for anvil, in place of the public endpoints. HTTP(S) only, with the key in the path or query; the harness refuses a user name or password. Only the runner process holds it: the workers never see it, every log is redacted, a private upstream's error text is withheld, and only results of the right shape reach anvil.                                                                              |
| `BROWSER_FORK_BLOCK`        | `pinned` (the default) forks block 26244888 and checks its hash. `latest` forks the endpoint's latest block less 8, and the manifest records the block and hash it chose.                                                                                                                                                                                                                                                                       |
| `BROWSER_TEST_V3_API_URL`   | A public, credential-free HTTPS base URL for the production v3 API, for interactive use. The harness refuses one with a user name, password, query, fragment or key-like path segment, and the browser may only GET or HEAD the paths the app reads under it (`/market`, `/governance`, `/account`, `/legacy`). Its displays are production data, not fork state, and the manifest says so. Keep a credentialed API behind a proxy of your own. |
| `BROWSER_TEST_WORKERS`      | `auto`, unset or empty estimates the worker count. A whole number from 1 to 16 sets it without reading machine signals. Other values stop the run. Playwright's `--workers` overrides either choice. See [Choosing the worker count](#choosing-the-worker-count).                                                                                                                                                                               |
| `BROWSER_TEST_SKIP_PROD=1`  | Skips the production builds, as `yarn test:browser:dev` does. The summary then marks AC7's production coverage INCOMPLETE.                                                                                                                                                                                                                                                                                                                      |
| `BROWSER_WALLET_HEADLESS=1` | Runs the interactive session headless, for an agent with no display.                                                                                                                                                                                                                                                                                                                                                                            |
| `BROWSER_FORK_CACHE`        | `on` (the default) starts a fork of the pinned block from the fork cache, and promotes what it reads back to it. `off` reads all state from the upstream and leaves the cache as it is. Any other value stops the run before it contacts an endpoint.                                                                                                                                                                                           |
| `BROWSER_FORK_CACHE_DIR`    | An absolute path for the fork cache, in place of `$XDG_CACHE_HOME/cf-browser-fork` or `~/.cache/cf-browser-fork`. It must be a directory you own with mode 0700, or a path the harness can create. Otherwise, or with a relative path, the run stops before it contacts an endpoint.                                                                                                                                                            |
| `ANVIL`                     | The anvil binary to use.                                                                                                                                                                                                                                                                                                                                                                                                                        |

When public endpoints rate-limit during lane 0's start-up, anvil can fail to start. The harness then moves to the next public endpoint, as COM-289's runner does. After lane 0 starts, later lanes and restarted lanes use the selected endpoint. The harness does not switch endpoints during tests. If every endpoint fails during set-up, set `BROWSER_FORK_RPC_URL` or try again later.

### Choosing the worker count

The [worker-count estimator](../e2e/harness/concurrency.ts) chooses once when the runner first loads [the Playwright configuration](../e2e/playwright.config.ts). Workers inherit the selection through `BROWSER_HARNESS_CONCURRENCY` and do not sample again. The estimate is a heuristic for this suite on the machine running it, not a proven optimum.

The estimate takes the smallest limit, rounded down, with at least one worker:

```text
cpuLimit = floor((availableCPUs × idleShare - 2) / 2)
memoryLimit = floor((availableMemory - 4 GiB) / 1.5 GiB)
workers = max(1, min(cpuLimit, memoryLimit, upstreamLimit, 4))
```

- **CPU.** `availableCPUs` comes from `os.availableParallelism()`, capped by the CPU quota of the process's own Linux cgroup when present. The harness finds that cgroup from `/proc/self/cgroup` and the mounted hierarchy, and takes the tightest quota from it up to the mount point, so a nested systemd scope or CI slice counts. If that call fails, the harness uses `os.cpus().length`. An unknown count becomes 2. `idleShare` is the idle fraction over a 300 ms sample, or 50% if unavailable. The formula reserves 2 CPUs for shared services and budgets 2 per worker.
- **Memory.** On Linux, available memory is `MemAvailable`, or, when lower, the tightest memory limit less use on the path from the process's own cgroup (v2 or v1) up to the mount point. On macOS, it is the free, inactive and speculative pages from `vm_stat`. The fallback is `os.freemem()`. Unknown memory sets the memory limit to one worker. The formula reserves 4 GiB for shared services and headroom, then budgets 1.5 GiB per worker.
- **Upstream.** Public endpoints without a warm shared cache file have a limit of 2, including when the cache is off. A warm cache or a private endpoint uses 4.
- **Maximum.** The estimate never exceeds 4 workers. The [performance trials](browser-testing-performance.md) include higher counts with opt-in settings. Those observations do not establish a higher automatic limit.

Set a whole number from 1 to 16 to bypass the estimate and its limits. No machine signals are read for that override. `auto`, unset or empty selects the estimate. Any other value stops the run. Playwright's `--workers` overrides the configured count. An interactive session uses one lane and one worker.

```bash
BROWSER_TEST_WORKERS=1 yarn test:browser
BROWSER_TEST_WORKERS=4 yarn test:browser
yarn test:browser --workers=2
```

The startup line and `summary.md`'s Run section report the count, selection source, each limit's reasoning and unavailable signals. `manifest.json` records the selection and the count Playwright uses. If `--workers` changes the selected count, the printed report names that override and the earlier count instead of the estimate's reasons. The manifest retains those reasons and missing signals.

The CPU sample is short, and other processes can change the load after selection. The cache signal checks that a shared file exists, not whether anvil can use it. If port 18546 is taken, the run uses an uncached fork even if the estimate assumed a warm cache.

The estimator reads no file count and applies no test-count limit, so its selected lane count can exceed the number of tests in a filtered run. Unused lanes start no anvil. Playwright schedules individual tests, and the full inventory has 59 entries, far above the four-worker maximum. No test-count limit replaces the file limit because the full suite has enough tests to fill the workers, and the old file count ignored filters anyway.

#### Benchmarks

COM-349 measured worker counts with per-file scheduling on 2026-11-03 at commit `559b3e3`. These measurements cover that commit's full suite: 51 cases across the dev and prod-build projects, with 50 implemented and one skipped. The skipped AC7 `NODE_ENV=development` case keeps the acceptance verdict **INCOMPLETE** until the product fix. Commit `37981f6` adds another harness-security browser test, so these results do not measure its full suite.

The benchmark machine was an Apple M4 Max with 16 CPUs and 128 GB of memory. The runs used anvil 1.9.0, Node 22.22.0, Playwright 1.64.1 and pinned block 26244888. Each run selected the public drpc endpoint. Runs executed one at a time, alternating cold and warm caches, with worker counts set by `BROWSER_TEST_WORKERS`. A cold run used an empty cache directory. Each warm run used a fresh directory with the same baseline cache, copied from the cold one-worker run's promotion.

A sampler read the run's process tree every two seconds. Peak RSS is the sampled resident memory of that process tree. Set-up covers global setup through services ready, including production builds. Tests + teardown covers services ready through the end of teardown, including promotion. Wall time covers the whole command.

Other sessions ran on the machine during most measurements, with one-minute load averages up to 38, so timings carry noise. The repeated warm four-worker run finished within two seconds of the first.

| Run         | Workers | Wall (s) | Set-up (s) | Tests + teardown (s) | Passed / failed / skipped | Upstream requests | Upstream errors | Peak open upstream | Peak upstream/s | Peak RSS (GiB) |
| ----------- | ------- | -------- | ---------- | -------------------- | ------------------------- | ----------------- | --------------- | ------------------ | --------------- | -------------- |
| Cold        | 1       | 329      | 29         | 298                  | 50 / 0 / 1                | 2614              | 0               | 4                  | 38              | 4.1            |
| Cold        | 2       | 235      | 41         | 192                  | 50 / 0 / 1                | 2951              | 0               | 6                  | 44              | 4.0            |
| Cold        | 4       | 165      | 37         | 126                  | 50 / 0 / 1                | 3633              | 0               | 11                 | 89              | 5.7            |
| Warm        | 1       | 314      | 17         | 294                  | 50 / 0 / 1                | 2154              | 0               | 3                  | 42              | 4.1            |
| Warm        | 2       | 197      | 22         | 173                  | 50 / 0 / 1                | 2121              | 0               | 4                  | 53              | 5.8            |
| Warm        | 4       | 129      | 20         | 107                  | 50 / 0 / 1                | 2131              | 0               | 5                  | 60              | 7.7            |
| Warm repeat | 4       | 131      | 20         | 109                  | 50 / 0 / 1                | 2129              | 0               | 7                  | 61              | 8.2            |
| Warm        | 6       | 122      | 21         | 99                   | 50 / 0 / 1                | 2140              | 0               | 7                  | 90              | 9.4            |

Every measured run passed the 50 implemented tests, with no flaky result, upstream failure, cleanup error or lane restart. Every lane's cache merged. These results support the estimator's constants:

- **Four-worker maximum.** Warm wall time fell from 314 seconds with one worker to 197 with two, 129 with four, and 122 with six. Six workers gained about 6% over four, while peak upstream requests per second rose from 60 to 90. Peak RSS rose from 7.7–8.2 GiB at four workers to 9.4 GiB at six. The wallet-events and screening files took about 85 and 75 seconds of roughly 290 seconds of total test time. Each file ran in one worker in this benchmark, so those files limited further gains. The [per-test comparison below](#per-test-against-per-file-scheduling) supports per-test scheduling with the same four-worker maximum.
- **Two-worker cold-public limit.** Cold runs sent 2614, 2951 and 3633 upstream requests at one, two and four workers. The peak rate rose from 38 to 89 requests per second, with up to 11 open requests. Each lane sends its own cache misses upstream. drpc answered every request in these runs, but public endpoint rate limits are not published and can change. Warm runs still sent about 2130 requests because fresh accounts, resets and misses need the upstream.
- **Memory budget.** The samples showed about 3 GiB shared and about 1.1 GiB per worker. Chromium used about 0.7 GiB per worker, Node about 0.3 GiB, and anvil under 0.1 GiB. No swap was used. The estimator budgets 4 GiB shared and 1.5 GiB per worker to leave headroom.
- **CPU budget.** A worker averaged about 0.6 CPUs and peaked near 1.6. The estimator budgets 2 CPUs per worker and reserves 2 for shared services.

##### Per-test against per-file scheduling

COM-368 retains per-test scheduling in commit `a60a504`. Warm four-worker runs without the intermittent reorg timeout averaged 138 seconds with per-test scheduling against 161.5 seconds with per-file scheduling, about 14 % faster. The four-worker maximum and two-worker cold-public limit stay unchanged.

The comparison ran on 2026-11-03, in the PST afternoon and evening, on an Apple M4 Max with 16 CPUs and 128 GB. Every counted run used a clean tree at commit `3c19d18`, the main-branch merge of PR #97. Per-file runs used that commit's configuration with `fullyParallel: false`. Per-test runs used the same commit and configuration with Playwright's `--fully-parallel` flag. The runs used anvil 1.9.0, Node 22.22.0, Playwright 1.64.1, pinned block 26244888 and the public drpc endpoint (`https://eth.drpc.org`).

Worker counts came from `BROWSER_TEST_WORKERS`. The estimator sampled on this machine chose two workers for a cold public run and four for a warm run. Cold runs therefore compared the estimated count of two and the maximum of four. Warm runs used four workers, which matched both the estimate and the maximum, with three runs per mode.

Runs executed one at a time, alternating per-file and per-test scheduling. Each cold run used an empty 0700 cache directory. Each warm run used a fresh 0700 directory with the same baseline cache file used by COM-349, copied unchanged (SHA-256 prefix `df7d827a`). Every warm run therefore started from the same cache.

A sampler read the run's process tree every two seconds for resident memory (RSS) and CPU use. It recorded the one-minute load average before each run and its maximum during the run. Upstream counts came from `stats.json`. Set-up covers global setup through services ready, including production builds. Tests + teardown covers services ready through the end of teardown, including cache promotion. Wall time covers the whole command.

Other sessions ran browser suites and other work during most runs. One-minute load averages reached 29–38 during the first eight runs, so timings carry noise. The third warm pair ran on a quiet machine, with maximum load averages of 6.8 and 7.4.

Two attempts are excluded from the table:

- The first attempt at the third warm pair ran while another session held port 18546. Both runs used uncached forks with cache state `off`. They took 441 and 394 seconds, sent about 20,600 and 20,900 upstream requests, and had 291 and 163 upstream failures. The pair was rerun after the port was free.
- An earlier matrix attempt on commit `f33e64d` stopped during its first run when PR #97 merged. The matrix restarted on `3c19d18`, and the earlier attempt produced no counted result.

| Run           | Scheduling | Workers | Wall (s) | Set-up (s) | Tests + teardown (s) | Passed / failed / skipped | Failed tests                                          | Upstream requests | Upstream errors | Peak open upstream | Peak upstream/s | Peak RSS (GiB) | Mean / peak CPU (%) | Load before / max |
| ------------- | ---------- | ------- | -------- | ---------- | -------------------- | ------------------------- | ----------------------------------------------------- | ----------------- | --------------- | ------------------ | --------------- | -------------- | ------------------- | ----------------- |
| cold          | per file   | 2       | 285      | 33         | 244                  | 57 / 1 / 1                | mixed-position.spec.ts:416                            | 3743              | 0               | 10                 | 45              | 4              | 156 / 449           | 3.7 / 36.2        |
| cold          | per test   | 2       | 270      | 31         | 231                  | 57 / 1 / 1                | mixed-position.spec.ts:416                            | 3843              | 0               | 10                 | 59              | 5.3            | 154 / 441           | 33.8 / 33.7       |
| cold          | per file   | 4       | 188      | 29         | 150                  | 57 / 1 / 1                | mixed-position.spec.ts:416                            | 4599              | 0               | 12                 | 106             | 7.8            | 256 / 729           | 18.8 / 29.2       |
| cold          | per test   | 4       | 154      | 30         | 116                  | 57 / 1 / 1                | mixed-position.spec.ts:416                            | 4601              | 0               | 14                 | 100             | 8.4            | 290 / 707           | 28.8 / 31.1       |
| warm          | per file   | 4       | 159      | 19         | 132                  | 57 / 1 / 1                | mixed-position.spec.ts:416                            | 2997              | 0               | 12                 | 75              | 8              | 272 / 859           | 18.8 / 29.2       |
| warm          | per test   | 4       | 135      | 18         | 109                  | 57 / 1 / 1                | mixed-position.spec.ts:416                            | 3039              | 0               | 12                 | 71              | 7.6            | 306 / 775           | 23.9 / 29.8       |
| warm repeat 2 | per file   | 4       | 228      | 19         | 195                  | 56 / 2 / 1                | mixed-position.spec.ts:416 mixed-position.spec.ts:601 | 2986              | 0               | 11                 | 77              | 7.9            | 189 / 762           | 30.6 / 31.2       |
| warm repeat 2 | per test   | 4       | 141      | 19         | 114                  | 57 / 1 / 1                | mixed-position.spec.ts:416                            | 3043              | 0               | 13                 | 76              | 8.7            | 296 / 940           | 26.1 / 38.5       |
| warm repeat 3 | per file   | 4       | 164      | 20         | 136                  | 57 / 1 / 1                | mixed-position.spec.ts:416                            | 2995              | 0               | 11                 | 76              | 7.7            | 249 / 682           | 2.5 / 6.8         |
| warm repeat 3 | per test   | 4       | 157      | 19         | 123                  | 56 / 2 / 1                | mixed-position.spec.ts:416 mixed-position.spec.ts:601 | 3041              | 0               | 13                 | 73              | 9              | 267 / 881           | 3 / 7.4           |

Peak RSS values of 4 and 8 mean 4.0 and 8.0 GiB. Upstream errors include transport failures and error answers. Every counted run had zero upstream errors.

The HTML reports' per-test start times give these file spans for the first warm four-worker run of each mode:

| Spec file                | Tests | Per-file span (s) | Per-test span (s) | Summed test time (s) |
| ------------------------ | ----- | ----------------- | ----------------- | -------------------- |
| mixed-position.spec.ts   | 7     | 129.5             | 53.1              | ~128–131             |
| wallet-events.spec.ts    | 10    | 85.0              | 27.0              | ~85–88               |
| screening.spec.ts        | 11    | 76.6              | 36.3              | ~76                  |
| harness-security.spec.ts | 12    | 37.3              | 17.1              | ~37                  |
| signing.spec.ts          | 6     | 30.0              | 11.5              | ~24–30               |

No two tests of one file overlapped in per-file mode. In per-test mode, tests overlapped in every file with more than one test. Under file scheduling, `mixed-position.spec.ts` alone spanned about 130 seconds, nearly the whole test phase.

The comparison supports the scheduling decision:

- **Wall time.** Warm runs without the `:601` timeout took 159 and 164 seconds in per-file mode (mean 161.5), against 135 and 141 in per-test mode (mean 138). That is about 14 % faster. All three warm runs took 159/228/164 seconds in per-file mode (mean 184), against 135/141/157 in per-test mode (mean 144). Tests + teardown took 132/195/136 seconds in per-file mode and 109/114/123 in per-test mode. Cold four-worker wall time fell from 188 to 154 seconds (18 %), and cold two-worker time fell from 285 to 270 seconds (5 %). Set-up time stayed at 18–20 seconds warm and 29–33 seconds cold.
- **Upstream.** Request counts were about equal: warm runs sent about 2990 in per-file mode and 3040 in per-test mode. Cold four-worker runs sent 4599 and 4601, and cold two-worker runs sent 3743 and 3843. Peak open requests ranged from 10 to 14 across both modes. Warm peak rates ranged from 71 to 77 requests per second across both modes. Cold four-worker peaks were 106 in per-file mode and 100 in per-test mode, and cold two-worker peaks were 45 and 59. There were no upstream errors.
- **Memory.** Warm peak RSS ranged from 7.7–8.0 GiB in per-file mode and 7.6–9.0 GiB in per-test mode. Cold four-worker peaks were 7.8 and 8.4 GiB. Swap use was zero before and after the runs.
- **CPU.** Mean process-tree CPU use in warm runs ranged from 189–272 % in per-file mode and 267–306 % in per-test mode, with the work completed sooner. Peaks across both modes were about 680–940 %. More than four workers is unmeasured with per-test scheduling.

Known failures and skipped coverage remain:

- **Baseline failure at `mixed-position.spec.ts:416`.** The test that keeps the hold when another interface supplies 100 USDC and withdraws 301 USDC failed in all ten counted runs. Both modes reported `transaction … on the fork: status reverted`. This was the main-branch failure with anvil 1.9.0 that COM-369 fixed (see [How the wallet signs and sends](#how-the-wallet-signs-and-sends)). Every per-file run on the same commit reproduced it. The fix is outside COM-368's scope.
- **Intermittent failure at `mixed-position.spec.ts:601`.** The reorg test failed in per-file warm repeat 2 and per-test warm repeat 3. Both failures timed out after 60 seconds on the same `expect.poll` assertion for `isReorged` at line 669. The test passed in about 11–13 seconds in the other eight runs. The failure with `fullyParallel: false` on the same commit shows that per-test scheduling did not cause it. COM-349 had also seen this timeout once under four-worker load. COM-368 leaves this intermittent failure in both modes unfixed and changes no spec behaviour.
- **Skipped AC7 case.** Every other implemented test passed in every counted run. The AC7 `NODE_ENV=development` case stays skipped, so AC7 and acceptance remain **INCOMPLETE** until the product fix and execution of that case. Each counted run's own acceptance verdict was **FAIL** because of `:416`. Without that failure, the skipped case still prevents clean acceptance.

No spec file is marked serial because no spec proved order-dependent. Each test resets its worker's wallet and fork and gets a fresh browser context. The proxies' counters and the lane list stay shared across the run. Two tests read them, and both hold whatever ran before them. AC8's method checks hold because the proxies refuse every method outside their allowlists. The harness-security listener check reads the lane list when it runs. The specs contain no `beforeAll`, `afterAll`, serial mode or module-level mutable state. Each worker leases the lane of its Playwright `parallelIndex`, and its other worker-scoped fixtures (manifest, wallet client, fork client and browser) come from that lane.

Each run promoted the union of every lane except the reorg test's lane, leaving one eligible lane at two workers. The reorg test sent `evm_snapshot` to its fork, which excludes that lane's cache from promotion by design. No lane restarted, and no cleanup error occurred.

### The fork cache

Each lane's fork of the pinned block reuses state from its private cache copy. The state at that block never changes, so cached reads serve later tests in that lane and, after promotion, later runs. A fork of the latest block is never cached.

- **The reset.** Before each test, the wallet resets the fork with `anvil_reset` to its block. Since anvil 1.8.0, a reset to the same block writes what anvil read from the upstream to its cache file and reads it back. `evm_revert` discards what anvil read after the snapshot.
- **Where.** The cache's root is `BROWSER_FORK_CACHE_DIR`, else `cf-browser-fork` under an absolute `$XDG_CACHE_HOME`, else `~/.cache/cf-browser-fork`. The harness creates a missing root with mode 0700. Whoever can write in the root decides the fork state of later runs. The harness therefore refuses a root that is a symbolic link, that another user owns, or that anyone else can read or write. It also refuses a root whose path passes a directory or link that another user can change. The default root is outside the repository, so every worktree shares it.
- **Account salt.** With the cache on, the harness reads or creates `<cache root>/account-salt`: 32 random bytes as hex, created once with mode 0600. The harness writes the salt to a file of its own in the root and links it into place, so the salt file appears whole or not at all. Before reading it, the harness checks that the opened file is regular, belongs to the user and grants no permissions to other users. It refuses symbolic links and malformed contents. The salt keeps anyone without it from deriving the test keys. If the salt file is deleted, every test gets new addresses on the next run. The harness registers the salt as a run secret for the secret scan. A leak report names it as "the account salt".
- **Two trust classes.** The root holds `public/mainnet-26244888.json` for the answers of public endpoints, and `private/mainnet-26244888.json` for those of `BROWSER_FORK_RPC_URL`. A run with the private endpoint never reads what a public endpoint answered.
- **A fixed port.** anvil 1.9.0 names its cache file for the fork URL, which is the upstream proxy's, and checks the URL when it reads the file. The shared proxy of a cached run listens on port 18546, so every lane uses the same fork URL. Lanes never choose separate proxy ports. If another concurrent run holds that port, the new run uses one free proxy port and runs uncached. An installed anvil other than 1.9.0 also disables caching. The summary says why.
- **During the run.** Each lane takes a private copy of the shared cache when it starts, in its own anvil home. anvil writes that copy on each reset and when it stops on SIGTERM or SIGINT. It never writes to the shared file. Changes made on the fork, such as balances the harness sets and transactions it mines, never reach the copy. The copy records the proxy's `127.0.0.1` address, never an upstream URL.
- **After the run.** The teardown stops every lane before the upstream proxy, which holds its port through every anvil cache flush. It then promotes the union of eligible caches, including eligible earlier starts of restarted lanes. A lane stop failure is reported but does not prevent other lanes from stopping or their caches from entering promotion.
- **Promotion gates.** [Each lane start passes the gates separately](../e2e/harness/fork.ts). The proxy must still hold its port when that anvil stops. anvil must be version 1.9.0 and exit cleanly. Its log must contain `eth_chainId` and `anvil_metadata`, with no methods outside `eth_`, `net_`, `web3_` and the harness's own allowlist. It must write a cache of the pinned block and hash in the expected format: `meta`, `accounts`, `storage`, `block_hashes` and `block_hash_cache_version`, with no extra sections. `block_hash_cache_version` must be 1. The first eligible lane's full `meta` must match every other file included in the union.
- **The union.** Promotion checks the cache root again and re-reads the shared file, preserving eligible entries promoted since this run started. A shared file from another fork is replaced. The union combines account entries, block hashes and individual storage slots. If two files disagree on an entry, the union leaves it out, including the shared file's value, so the next run reads it upstream again. Promotion writes a new 0600 file beside the shared file, then renames it over that file. It writes nothing if no lane is eligible or the union equals the shared file.
- **Other local processes.** anvil's port has no credential. A process that resets the fork to its own upstream fills that upstream's cache file, which is never promoted, and the harness's next reset names its own upstream again. A process that calls `anvil_setRpcUrl`, or `anvil_setLoggingEnabled` to hide its calls, excludes that lane start's cache from promotion. Such a call can change the run it reaches, but not a later run. The rename leaves readers a complete file.
- **Sends.** anvil 1.9.0 answers `eth_sendTransaction` before it mines the transaction. The wallet answers the page only once anvil has the receipt. The app's receipt wait then finds the block it watches for, and each send's block comes 12 s after the one before. The wait takes at most 30 s, receipt reads included. When anvil has not mined the transaction by then, or a receipt read fails, the page gets an error and the wallet asks anvil to drop the transaction, without waiting for the answer. anvil can still mine one it has begun to execute, so the wallet refuses every later send until a reset succeeds.
- **What a run records.** The manifest and the summary give the cache's state, with its trust class and root, the home directory shown as `~`: `off`, with why when the cache is on but the run cannot use it; `cold`, when no file of the block that anvil can read was there at the start; or `warm`. Both record the promotion result and each lane start's contribution or refusal reason. The summary's upstream counts show what the run still read from the upstream.
- **No live sharing.** Warm caches are private copies taken at lane start, not a live shared read cache. A miss filled in one lane does not reach another lane during the run. Two lanes can send the same miss upstream, with no live request deduplication.
- **Limits.** Each start and each reset makes about eight upstream requests. A run with a cache still needs an endpoint. A read the cache does not hold goes to the upstream as before. With a cache salt, each test repeats its keyed accounts across runs that use the same cache root. Reads for those accounts go upstream once, then come from the cache after promotion. The harness loads the salt only when a cache root exists and the installed anvil can read the cache. Keys stay random with `BROWSER_FORK_CACHE=off`, with `BROWSER_FORK_BLOCK=latest` or with an installed anvil other than 1.9.0. A reset without a seed also gives random keys. A port conflict disables state caching after the salt is loaded. Accounts still repeat in that case. anvil 1.9.0 also asks the upstream for `anvil_nodeInfo`, `eth_getAccountInfo` and `eth_getBlockAccessList`. The upstream proxy refuses them. The summary counts them as refused, and anvil falls back to the reads the proxy forwards.

The cache keeps a wrong answer. If an upstream once answered a read with wrong state, later runs read that state from the cache. If a test fails on fork state and passes with `BROWSER_FORK_CACHE=off`, delete the trust class's file. The root also holds `account-salt`; keep it to preserve the test accounts:

```bash
rm ~/.cache/cf-browser-fork/public/mainnet-26244888.json   # or private/; under $XDG_CACHE_HOME/cf-browser-fork, or BROWSER_FORK_CACHE_DIR, when set
```

#### Repeated test accounts

COM-372 compared random and derived keys on 2026-11-03, in the PST evening. The machine was an Apple M4 Max with 16 CPUs and 128 GB. The runs used Node 22.22.0, anvil 1.9.0, Playwright 1.64.1, pinned block 26244888 and the public drpc endpoint. `BROWSER_TEST_WORKERS` set four workers, and port 18546 was free.

Each mode started from a copy of the same cache file (SHA-256 prefix `ec7ebbdb`) in its own `BROWSER_FORK_CACHE_DIR`. Each ran twice in a row, so the second run read what the first promoted. Random keys ran on `main` at `27dd643`. Derived keys ran at `5df93ad`, which derived keys from the test identity without a salt. The salt added in `185e403` changes which addresses are derived, not how often they repeat. The earlier COM-349 and COM-368 benchmark tables used random accounts, so their timings are not directly comparable to runs that reuse derived accounts.

The `startSupply` wait measures the `expect(...).toPass` around the "Supply USDC" click in `wallet-events.spec.ts`, across nine calls in eight tests per run. The chain-change test calls it twice.

| Run         | Wall (s) | Set-up (s) | Tests (s) | Upstream requests | `eth_getStorageAt` | `eth_getBalance` | Entries promoted | Mean `startSupply` (ms) | Passed / failed |
| ----------- | -------- | ---------- | --------- | ----------------- | ------------------ | ---------------- | ---------------- | ----------------------- | --------------- |
| Random 1st  | 167      | 23         | 152       | 2738              | 2237               | 47               | 1978             | 3949                    | 56 / 2          |
| Random 2nd  | 175      | 19         | 161       | 2741              | 2239               | 47               | 1980             | 5555                    | 56 / 2          |
| Derived 1st | 163      | 20         | 149       | 2736              | 2237               | 48               | 1979             | 3532                    | 56 / 2          |
| Derived 2nd | 108      | 18         | 101       | 780               | 389                | 7                | 256              | 668                     | 57 / 1          |

The second derived run sent 72 % fewer upstream requests than the second random run (780 against 2741). It made 83 % fewer `eth_getStorageAt` requests (389 against 2239) and promoted 87 % fewer new entries (256 against 1980). The mean `startSupply` wait fell from 5.6 s to 0.67 s. Test time fell from 161 s to 101 s, and wall time fell from 175 s to 108 s (38 %). The first derived run matched the random runs because its accounts were not in the cache. The remaining upstream requests include each start's and reset's own reads. They also include other reads the cache does not hold.

`mixed-position.spec.ts:416` failed in all four runs. It failed on `main` until COM-369 (#101) fixed it. These benchmark runs predate that fix. The intermittent reorg timeout at `mixed-position.spec.ts:601` failed in the first three runs and passed in the fourth. It also failed with random keys, so it is a known intermittent failure, not caused by key derivation. Every run skipped one AC7 test and had zero upstream errors. These runs are not clean acceptance results.

The lane that ran the reorg test is excluded from promotion by design. The random runs promoted 599/591/788 and 652/486/842 entries per eligible lane. The derived runs promoted 653/540/786 and 126/66/64. The first random run promoted lanes 0, 1 and 3. The second derived run promoted lanes 1, 2 and 3.

## Startup, reset and cleanup

The global setup:

1. stops what an earlier run left behind if its runner was killed (see below);
2. makes a private 0700 directory under the system's temporary directory, outside the repository, for the TLS key, the 0600 control token file and the production builds;
3. starts the RPC proxy and screening stub with routing and partitions for the configured lanes, and creates the random control token;
4. finds an endpoint that serves the pinned block with the recorded hash, starts the shared upstream proxy and lane 0's anvil, verifies the fork, checks that anvil has no unlocked account, and starts lane 0's wallet server;
5. starts the lane pool and lane server for workers to lease their lanes;
6. builds and serves the two production builds, unless skipped;
7. starts the dev server and loads the app once on lane 0, so Vite's first dependency optimization is not charged to a test, and to check the browser's trust in the certificate.

Each service registers its own stop as soon as it starts, so a failure at any step stops everything started before it. `startup-failure.txt` says why.

Before each test, that lane's wallet resets: anvil resets its fork to its block from the upstream proxy (`anvil_reset`), which drops every change made on the fork; every account is forgotten and its impersonation stopped; pending requests fail with 4900; delayed decisions are cancelled; long polls end; the chain returns to 1 with only chain 1 known; policies return to manual; and screening behaviours are cleared. The reset starts a new generation, and a request from an earlier generation can no longer be decided.

The `resetWallet` fixture sends `POST /v1/reset` with the test's Playwright `testId`, repeat index and retry joined with `/` as its seed. With the cache on, the wallet derives each keyed account from the cache root's salt, that seed and the account's index after the reset. The accounts repeat across runs using that root and differ between tests, repeats and retries. Without a cache salt, keys are random. The interactive session uses its own seed, so its first accounts also repeat across sessions using the same cache root.

The teardown scans the production bundles for the run's secrets. It stops the dev and production servers, then the lane server and every lane. Each lane closes its wallet server before stopping anvil. anvil receives SIGTERM, then SIGKILL if it is still running five seconds later. After the lanes stop and eligible caches are promoted, the teardown stops the upstream proxy, then the screening stub and RPC proxy. The proxy holds its port through every anvil cache flush.

The teardown removes the private directory and reports stop failures without abandoning other lanes.

On Ctrl-C, Playwright runs the teardown. On SIGTERM, the harness stops its services and exits. An anvil still starting has its own stop registered after the proxy's, so cleanup stops it before the proxy. Once a signal starts cleanup, startup checks prevent later stages from starting, and a service that finishes starting registers an immediate stop. On process exit, including Ctrl-C during start-up, the last resort synchronously kills remaining anvils through their process handles and removes their working directories and the private directory.

**After a killed runner.** If the runner is killed with SIGKILL, it cannot stop its anvils. Each run records `runnerPid`, `upstreamProxyPort`, `privateDir` and an `anvils` list of `{pid, cwd}` entries in `test-results/browser-fork/<run ID>/processes.json`. The list includes each lane's anvil and every restart. Recovery also reads older records with `anvilPid` and `anvilCwd`.

The next run checks each recorded anvil after confirming its runner is gone. It stops the process only if its command forks from the recorded proxy port and its working directory matches the record. The directory distinguishes lanes and concurrent cached runs that use the same proxy port. Recovery reads it through `/proc/<pid>/cwd` on Linux or `lsof`. If the directory cannot be read, recovery leaves that anvil running. A live process that does not match keeps the record for manual inspection. Recovery removes the private directory and, when no live process is unmatched, the recorded anvil directories.

To recover by hand:

1. Read the process record and confirm that `runnerPid` is no longer running.

   ```bash
   cat test-results/browser-fork/<run ID>/processes.json   # runnerPid, anvils: [{pid, cwd}, ...], upstreamProxyPort, privateDir
   ps -p <runnerPid> -o command=
   ```

2. For each entry in `anvils`, check its `pid` and `cwd` against the live process.

   ```bash
   ps -p <pid> -o command=       # must be anvil --fork-url http://127.0.0.1:<upstreamProxyPort>/
   lsof -a -p <pid> -d cwd -Fn   # must match this entry's cwd
   ```

3. Stop each matching process and confirm that it has exited before removing its directory. Leave unmatched processes and their directories for inspection.

   ```bash
   kill <pid>
   ps -p <pid> -o command=
   rm -rf <cwd>
   ```

4. After checking every entry, remove the run's private directory.

   ```bash
   rm -rf <privateDir>
   ```

An orphaned anvil holds no key, and its upstream proxy has gone with the runner.

## Interactive control

`yarn test:browser:open` uses one worker on lane 0. It starts the shared services and that lane's wallet server without production builds, opens a headed browser with the wallet injected, and prints:

```text
Browser fork wallet: interactive session
  App:           http://127.0.0.1:<port>
  Control API:   http://127.0.0.1:<port>
  Token file:    /var/folders/.../cf-browser-wallet-XXXX/control-token
  Manifest:      test-results/browser-fork/<run ID>/manifest.json
  End with:      POST /v1/session/end, or Ctrl-C
```

It never prints the token. The session connects nothing and approves nothing by itself: every request waits for a decision. It runs until `POST /v1/session/end` or Ctrl-C.

For scripted UI control, write a spec that imports `test` and `expect` from [the harness fixtures](../e2e/harness/fixtures.ts) and run it with `yarn test:browser <file>`. The worker-scoped `lane` fixture leases that worker's lane. The `manifest` fixture substitutes its fork URL, anvil PID and wallet URL for lane 0's. The `wallet` and `fork` clients use that lane, and each test gets a fresh page with the wallet injected. The harness exposes no CDP or remote-debugging port, which would be an unauthenticated control surface.

`BROWSER_WALLET_CONTROL_URL` names lane 0's wallet server. `BROWSER_HARNESS_LANES_URL` names the lane server. Both use the token file at `BROWSER_WALLET_TOKEN_FILE`. On the lane server, `POST /v1/lanes/<index>` leases a lane and `GET /v1/lanes` lists started lanes. Its token, Host and no-Origin checks prevent browser pages from using it. Use the `wallet` fixture to control the worker's lane in a spec, rather than the environment's lane 0 client.

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

From Node, [the control client](../e2e/harness/controlClient.ts) gives the same calls, typed, and reads the token file itself. `ControlClient.fromEnvironment()` uses lane 0. `ControlClient.forUrl(url)` uses a named lane wallet or the lane server with the same run token:

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
| `POST /v1/accounts/new {eth?, usdc?, screening?}`                                                                   | A new keyed account, with a key derived from the reset's seed and the cache root's salt, or random if either is absent. It is impersonated on anvil, funded with ETH and USDC, and screened as `allowed` unless `screening` says otherwise.                                                                                                                                    |
| `POST /v1/accounts/impersonate {address, eth?, usdc?, screening?}`                                                  | An existing address with no key: it can send transactions but not sign messages.                                                                                                                                                                                                                                                                                               |
| `POST /v1/accounts/select {addresses}`                                                                              | The accounts the wallet exposes, the first selected. Emits `accountsChanged` when the app is permitted.                                                                                                                                                                                                                                                                        |
| `POST /v1/chain {chainId}`, `POST /v1/chains/known {chainIds}`                                                      | Changes the wallet's chain (emits `chainChanged`), and sets which chains a switch can reach without 4902.                                                                                                                                                                                                                                                                      |
| `POST /v1/disconnect`                                                                                               | Emits `disconnect` (4900) and `accountsChanged []`, and drops the permission.                                                                                                                                                                                                                                                                                                  |
| `POST /v1/fork/send {from, to, data?, value?, gas?}`                                                                | Sends a set-up transaction from a harness account straight to the fork, without the app, such as an existing position.                                                                                                                                                                                                                                                         |
| `POST /v1/screening {address, behaviour}`, `POST /v1/screening/release {address, outcome}`, `GET /v1/screening/log` | Screening behaviours: `allowed`, `blocked`, `timeout` (never answers; the app gives up after 10 s), `hold` (answers on release), `malformed-text`, `malformed-string`, `malformed-empty`, `error` (500). An address with no behaviour is blocked.                                                                                                                              |
| `GET /v1/calls`, `GET /v1/provider-calls`, `GET /v1/stats`                                                          | Calls answered at once, such as `wallet_revokePermissions`. Every provider call from the page in this generation, those the wallet answered or refused at once included, for a test that claims a method was never called. If a generation makes more calls than the record holds (100,000), the client reports the overflow instead of a partial record. The proxies' counts. |
| `POST /v1/reset {seed?}`, `POST /v1/session/end`, `GET /v1/session`                                                 | Reset with an optional `seed`, a string of 1 to 512 characters. An invalid seed answers 400. End the interactive session or read its state.                                                                                                                                                                                                                                    |

The provider answers `eth_chainId`, `net_version`, `eth_accounts`, `wallet_getPermissions` and `wallet_revokePermissions` from the wallet's state, and forwards reads to the fork while its chain is 1. It queues `wallet_requestPermissions`, `eth_requestAccounts` (unless already permitted), `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`, `wallet_switchEthereumChain` and `wallet_addEthereumChain`. Any other method answers 4200.

## How the wallet signs and sends

- **Transactions are never signed.** An approved `eth_sendTransaction` goes to anvil's `eth_sendTransaction` from the impersonated sender, with only `from`, `to`, `data`, `value`, `gas` and the fee fields, after the wallet verifies the fork again. Each block is mined 12 s after the previous one, so interest accrual, and every Comet assertion, is the same on each run. No signed chain-1 transaction exists that could be replayed on mainnet.
- **Gas limits.** A send that names no `gas`, from the app or from `POST /v1/fork/send`, gets anvil's `eth_estimateGas` at the `pending` block, asked after the next block's time is set. Otherwise anvil 1.9.0 fills in the limit from an estimate at the latest block's time. When the latest block holds a Comet action, that estimate leaves out the interest accrual the next block does. A Comet withdrawal sent with it runs out of gas inside USDC's transfer and reverts without data. If anvil refuses the estimate, nothing is sent: the page gets code -32603 with anvil's message, and `POST /v1/fork/send` answers HTTP 500. A send that names its own `gas` keeps it.
- **Messages are signed** with a key derived from the cache root's salt, the test's seed and the keyed account's index when the cache is on. Without a salt or seed, `viem` `generatePrivateKey` makes a random key. Every key stays only in the wallet server's memory and goes to the secret scan. The salt is also a run secret. No key is funded on any public chain, anvil's default keys are never used, and no control answer, log or report holds a key.
- An impersonated account has no key, so `personal_sign` and `eth_signTypedData_v4` from it answer 4200.

## What the assertions rely on

Every state and request assertion uses the fork or the wallet's queue:

- **Fork RPC, read from anvil in Node:** receipts (status, sender, contract, canonical block on the same node, 12 s block spacing), USDC balances and allowances, and Comet principals and balances at each receipt's block.
- **The wallet's queue:** the chain, origin, sender, contract, token, spender, amount and value of each request, decoded before it is approved.
- **The app's UI, rendered from fork RPC reads:** the connected account, the USDC wallet balance, the supply position, the pending state and the network-switch prompt. The home page renders positions, balances and markets from RPC alone.

No assertion uses production API data. Without `BROWSER_TEST_V3_API_URL`, the v3 API is not configured, and its displays (market summaries, APR history, rewards and transaction history) are empty or fail; none is asserted. With it, those displays show production data that does not reflect the fork.

Raw-unit tolerances: USDC balances and allowances are exact. Comet's principal and balance are exact against values derived from the supply index of the block that mined each action, with Comet's own rounding (`e2e/harness/contracts.ts`), because a supply of 100 USDC can read back as 99.999999 USDC. USDC (FiatToken) spends even an unlimited allowance, so after approving the maximum and supplying 100 USDC, the allowance is the maximum less 100 USDC.

## Coverage and its limits

| Area                                                                                                                                                                                                      | Covered by                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery and connection (AC2)                                                                                                                                                                            | `connect.spec.ts`                                                                                                                                                             |
| USDC approve, supply and withdraw, requests and fork state (AC3, AC4, AC8)                                                                                                                                | `usdc-supply-withdraw.spec.ts`, `existing-position.spec.ts`                                                                                                                   |
| Signing (AC5)                                                                                                                                                                                             | `signing.spec.ts`: the extension bridge, the app's one flow that signs, for both methods; direct provider calls for rejection, chain checks, message forms and account checks |
| Rejection, pending and delayed requests, account and chain changes, chain-switch errors, disconnects (AC6)                                                                                                | `wallet-events.spec.ts`                                                                                                                                                       |
| Screening on the dev server (AC7)                                                                                                                                                                         | `screening.spec.ts`, with every behaviour and attempted actions during pending and changed screening                                                                          |
| Production screening (AC7)                                                                                                                                                                                | `prod-build.spec.ts`: a build with no endpoint fails closed; an allowed control connects; the `NODE_ENV=development` build is a known case not executed                       |
| The harness's boundaries (AC8, AC9)                                                                                                                                                                       | `harness-security.spec.ts`, `dev-server-security.spec.ts`, and the harness unit tests                                                                                         |
| COM-309: the Anchorage route through production's queue, with no dialog. Desktop: Approve & Add, Submit and a Max exit executed on the fork. Mobile: the bottom sheet and the exact approval request only | `wrapped-queue.spec.ts`, on the dev server with the release controls opened                                                                                                   |
| Production bundle (AC10)                                                                                                                                                                                  | `bundle.spec.ts`, the teardown's bundle scan, and `bundleBoundary.test.ts`                                                                                                    |

Limits:

- Real MetaMask: its UI, confirmations, simulations and key handling are not covered. WalletConnect, Ledger, Coinbase and Safe are out of scope. The real Anchorage extension is out of scope too: `wrapped-queue.spec.ts` announces its RDNS from the harness provider, so it covers the app's route, not the extension.
- The release controls are open on the dev server only, so the wrapped specs do not run against the production builds.
- Transactions are never signed, so transaction serialization and EIP-1559 signing are not covered.
- Impersonation cannot sign messages.
- The fork runs Prague, as COM-289's runner pinned. Mainnet runs Osaka. Gas figures can differ.
- Only Ethereum is forked. Other chains answer a JSON-RPC error, and nothing else runs on them.
- The app calls wagmi's `switchChain`, which does not reject to its caller, so `switchWriteNetwork`'s own `catch` branches for 4902, 4001 and -32002 never run. wagmi's connector handles 4902 by adding the chain. The tests assert that sequence and do not cover the app's catch branches.
- The production builds run with `NODE_ENV=production`, as `vite build` does when `NODE_ENV` is unset. A build run with `NODE_ENV=development` compiles `DEV=true`, and with it the dev-only screening bypass, whatever its mode. The harness sets `NODE_ENV` itself, so it does not test that case. The case is a `test.fixme` in `prod-build.spec.ts`, so the summary reports AC7, and the acceptance, INCOMPLETE until the product fix to `envVars.ts` lands and the test runs.
- Playwright routes neither WebRTC nor WebTransport. No harness service speaks either, and the tests do not cover them.
- The screening tests assert that the app made no signing call, from the wallet's record of every provider call, not only from its queue, so a call the wallet refused before queueing still fails the test.
- The screening stub follows the worker's request and response contract, not its real origin allowlist or rate limiting.
- The extension used for signing is a harness test page. Bulker, rewards, transaction history and extension operator allows are not covered. Wrapped lending is covered by `wrapped-queue.spec.ts` on the dev server only, as above.
- anvil checks no `Host` header and has no credential. While a run lasts, another local process, or a page in another browser through DNS rebinding, can reach it and change the fork's state. It holds no key and its upstream forwards only reads. Run the suite with no untrusted page open.
- The secret scan after a run finds a leak. It does not prevent one. The token never enters the page by design.

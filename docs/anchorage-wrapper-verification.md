# Anchorage wrapper verification: mainnet fork and deployed bytecode

This document records how the wrapped lending frontend was checked against the three deployed wrappers, on a local fork of Ethereum mainnet. It also records how the wrappers' deployed bytecode was checked against their build input. [`docs/anchorage-wrapper-registry.md`](anchorage-wrapper-registry.md) records the deployment evidence and the release checks that keep both release controls off.

Conclusions:

- Every fork scenario passed on all three markets, at the registry's pinned block 26244888 and at a recent block. The [scenario matrix](#scenario-matrix) lists the 21 scenarios.
- Every exit mined at the state its quote read paid exactly the quoted cash and burned exactly the quoted shares, a difference of 0 raw units. An exit mined one slot later paid 5 to 11 base units more, inside the bound that Comet's supply rate sets.
- The deployed runtime code of the three wrappers and of the factory equals the solc 0.8.28 output of the build input committed at `comet-erc4626` `1152de2`. Only the constructor's immutable values differ, and they hold each wrapper's Comet, 6 decimals, canonical Permit2 and an offset of 12.
- The fork found no difference between the app's quotes and the deployed contracts, and no gap in the COM-287 or COM-288 code.
- These results are not audit approval. Certora's audit does not cover the preview changes made after it (release check 1). The fork signs with impersonated accounts, so it does not replace signing through Porto (COM-290).

## Run the fork suite

Run the suite from the repository root:

```bash
node scripts/test-wrapped-lending-fork.js --solc-output <path to solc output>
```

The runner needs `yarn install`, Node 22 and Foundry's `anvil`. The recorded runs used anvil 1.2.3. Set `ANVIL` to anvil's path if it is not on `PATH`.

| Option                                                 | Effect                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--block auto`                                         | The default. Forks the pinned block 26244888 when the upstream serves its state, and a recent block otherwise.                                    |
| `--block pinned`, `--block recent`, `--block <number>` | Forks that block. A recent block is the latest block less 8.                                                                                      |
| `--solc-output <path>`                                 | solc's standard-JSON output for the wrappers' build input, for the bytecode comparison. Without it, that comparison is recorded as not exercised. |
| `--log-dir <path>`                                     | Where `anvil.log`, `jest.log`, `results.json` and `summary.md` go. The default is a new directory under the system's temporary directory.         |
| `--port <number>`                                      | The fork's local port. The default is a free port.                                                                                                |
| `--test <pattern>`                                     | Runs only the fork suites whose path matches the pattern.                                                                                         |

### Upstream RPC

The runner reads the upstream RPC URL from `WRAPPED_FORK_RPC_URL`, a private variable for an archive-capable mainnet RPC. Do not use a `VITE_` variable for it. Vite embeds those in the public bundle. Put the key in the URL's path or query. The runner refuses a URL with a user name or password, because `fetch` rejects one with an error that quotes the URL.

Only the runner's own process holds the URL:

- anvil reaches the upstream through a proxy that the runner runs on 127.0.0.1. Its arguments, logs, errors and JSON-RPC methods, `anvil_nodeInfo` included, carry only the proxy's local address.
- The proxy refuses what a web page can send. It refuses any request with an Origin header, any method other than POST, and any content type or body that is not JSON. It also refuses a body over 10 MB and an empty batch. It sends anvil no text of its own errors, which can name the upstream. The upstream's own answers reach anvil unchanged, and the runner redacts every output.
- The proxy forwards only the reads anvil makes to fork mainnet state: `eth_chainId`, `eth_blockNumber`, `eth_gasPrice`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_getTransactionByHash` and `eth_getTransactionReceipt`. It refuses any other method, and any batch that holds one, with 403. So no local process can send a transaction to mainnet through it. It forwards each call it checked, rebuilt from its four JSON-RPC members: `jsonrpc`, `id`, `method` and `params`. A body can name a method twice, or under a key in another case such as `Method`. The rebuilt call still carries only the method that the proxy checked. The summary lists the methods the proxy forwarded, and each refusal by its method or reason.
- The runner never prints the URL. It redacts the URL from every output it writes, a whole line at a time. It redacts the whole URL, and each part of it that can be a key. Such a part is the host, a path segment or a query value, with 16 characters or more that are not all digits. A shorter part, such as `v2` or `eth`, also occurs in ordinary output, and redacting it corrupts that output. The tests write their results into a temporary directory that only the user can read. When Jest ends, the runner parses the results, redacts them value by value and writes them to the log directory. So the redaction cannot break the file's JSON, and no unredacted copy stays in the log directory, even after Ctrl-C.
- The tests inherit only `PATH`, `HOME`, `TMPDIR`, `CI` and `NODE_OPTIONS` from the runner's environment, so no key in that environment reaches them.
- A run of the deployment suite at `18cfa4e`, with a 26-character fake key in the query of `WRAPPED_FORK_RPC_URL`, found no trace of the key, the query's name or the host in the console output, `anvil.log`, `jest.log`, `results.json` or `summary.md`. anvil's banner showed only the proxy's address.

Without `WRAPPED_FORK_RPC_URL`, the runner tries these public endpoints in order: `eth.drpc.org`, `mainnet.gateway.tenderly.co`, `eth-mainnet.public.blastapi.io`, `rpc.mevblocker.io` and `ethereum-rpc.publicnode.com`. The first four served state at the pinned block during these runs. `ethereum-rpc.publicnode.com` refuses state outside its recent window. An endpoint serves the pinned block only if its block 26244888 has the hash the registry records, `0x440c51a6…883839`, and a balance read at that block succeeds.

Under `--block auto`, the runner falls back to a recent block when no endpoint serves the pinned block, and it labels the run as a recent-block fork. If no endpoint serves a fork, the runner exits with an error and records no result.

The runner runs the suite a second time only when the upstream failed to serve the fork's state, and then only once. All of these must hold:

- At least one cell failed, and every failed cell carries anvil's own fetch error, such as `failed to get account for <address>: …` or `failed to get transaction <hash>: …`. No failed cell carries a revert: `execution reverted`, `call revert exception` or `UNPREDICTABLE_GAS_LIMIT`.
- Jest reported its results, failed no other test, and ran every suite. A test that Jest failed before its scenario ran, for example in a `beforeAll` hook, counts as a failed cell, with Jest's failure as its reason.
- anvil did not exit during the run.
- The proxy saw the upstream fail a request or answer a call with an error.

A recent-block run retries from the latest block less 8 at the time of the retry. A run at the pinned block, or at a given block, retries at the same block. It tries the other endpoints first and the failed one last, so with `WRAPPED_FORK_RPC_URL` it retries on the same endpoint. The summary then lists run 1's block, its upstream errors and its failed cells, and run 2's files carry `-2` in their names. If the last run also failed only on the upstream, its failed cells are recorded as not exercised, with the upstream's error. The result is then `NOT EXERCISED`, with exit code 1. A failure of any other kind is never retried, and it fails the run. When a failed run's upstream failed requests, the summary says so.

### What the runner does

1. It chooses the upstream endpoint and the fork block, as above.
2. It starts anvil on 127.0.0.1 only, with chain ID 1, Prague rules (`--hardfork prague`), no CORS headers (`--no-cors`), `--no-storage-caching`, 5 retries and a 45-second timeout. Then anvil binds a free port itself. The runner reads the port from anvil's own output, so no other process can take the port first.
3. It refuses to continue unless the node at that port is the fork it chose:
   - `eth_chainId` returns 1, and `web3_clientVersion` names anvil.
   - `anvil_metadata` reports the chosen fork block and hash. `anvil_metadata` carries no upstream URL, unlike `anvil_nodeInfo`.
   - The fork's block at that number has the hash that the upstream reported.
4. It runs Jest with `__tests__/integration/wrappedLendingFork/jest.config.js`, in one process, with the local fork's URL. If anvil exits while Jest runs, the runner stops Jest and the run fails. A reporter, `cellReporter.js`, writes Jest's own result for each test, and the runner fails any matrix cell whose test Jest failed. A scenario can record its cell after Jest failed its test, for example on a timeout.
5. It prints the environment, the proxy's use of the upstream, the scenario matrix, each exit of the supply-and-exit sequence against its quote, and every failed or unexercised scenario. It writes the same report to `summary.md`.
6. It stops anvil and removes its temporary directories, anvil's working directory and the tests' results directory, on success, on failure, on Ctrl-C and on SIGTERM.

The runner exits with 0 only when Jest passes and no scenario failed. Its summary ends with `Result: PASS`, `FAIL` or `NOT EXERCISED`. The default `yarn test` skips `__tests__/integration/wrappedLendingFork/`, because that suite needs the fork.

The suite also refuses connections to other hosts. `forkSetup.ts` replaces the request functions of Node's `http` and `https` modules, which ethers sends its requests through, and `net.Socket`'s `connect`, which every TCP connection goes through. Each throws for any destination but the local fork. `connect` also throws for a connection with a `path`, which is a pipe. It throws for a connection with its own `lookup` too, because a `lookup` can resolve the fork's host name to another address. A test confirms that each of these fails:

- a request to a public endpoint
- a raw connection to one
- a pipe
- a connection to the fork's port with its own `lookup`

### The runner's own tests

`yarn test:fork-runner` tests the runner's rules in `scripts/lib/wrapped-fork-runner.js` with Node's test runner, `node:test`. The tests need no fork and no network. Each test that needs an upstream runs a stand-in for it on 127.0.0.1. `yarn test` also runs them, through `__tests__/scripts/wrappedForkRunner.test.ts`. They cover these rules:

- the upstream endpoints, and the redaction of the private URL from text, JSON results and split lines
- the proxy's address, its read-only method allowlist, the calls it rebuilds, and each request it refuses
- each matrix cell held to Jest's own result for its test, a timeout included
- the retry rule, against each failure that it must not retry

### Build the solc output for the bytecode comparison

The wrappers and the factory were deployed from the Hardhat build input committed in `Compound-Foundation/comet-erc4626` at `1152de2b3942df189817ff03213177061455fb1d`:

1. Clone the repository and check out that commit.
2. Extract the solc input from `ignition/deployments/chain-1/build-info/solc-0_8_28-359744a66884ae15ce482203bdd9e1fa504d6706.json`:
   `python3 -c "import json,sys; json.dump(json.load(open(sys.argv[1]))['input'], open(sys.argv[2], 'w'))" <build-info> solc-input.json`
3. Install solc 0.8.28+commit.7893614a. `forge build --use 0.8.28` on any Foundry project installs it through svm, under `~/.svm/0.8.28/` on Linux and `~/Library/Application Support/svm/0.8.28/` on macOS.
4. Compile the input with it:
   `<svm directory>/solc-0.8.28 --standard-json < solc-input.json > solc-output.json`
5. Pass `--solc-output solc-output.json` to the runner.

The recorded runs used these files:

| File                | sha256                                                             |
| ------------------- | ------------------------------------------------------------------ |
| The build-info file | `76ddfafd49b0fc25ff20bf01dd23544ffbbf2ec5521e6045e1d3c6ab171875bb` |
| `solc-input.json`   | `cbb176602320708fbaaf17a6b985d79b229ceb9684a674fa13c470c60755a8ca` |
| `solc-output.json`  | `bab8938094a275ffef5970e7bd75188c678374a8da4bc6fe117972289a896a5d` |

## What the suite runs

The fork suite renders the app's own hooks against the fork, as `App` wires them:

- `useTransactionManager`, `useWrappedAction`, `useWriteWrappedState` and `useWrappedPosition` for the wrapped route. Each review, pre-signature check, simulation, gas estimate and wallet request is the app's own.
- `validateWrappedMarket` for the wrapper check, and `resolveLendingRoute` for the route.
- `useCometState` and `useWriteCometState` for the direct Comet position and the standard route's approvals, `allow` and Bulker transactions.
- `planExecution`, `submitExecution`, `getBulkerTrxData` and `isSubmissionRefused` for mixed requests.

The app's wallet provider is an ethers provider for the fork. anvil signs for the account with `anvil_impersonateAccount`, so no private key is used. Each test account is a fresh address derived from `keccak256("com-289 fork <role> <market>")`, with no code or history on mainnet. It gets 100 ETH from `anvil_setBalance`. The suite sets its base-token balance with `anvil_setStorageAt` on the token's balance mapping, as Foundry's `deal` does. It writes a candidate slot, reads `balanceOf` back, and restores every slot that was not the balance. The balance mapping is slot 9 for USDC and slot 2 for USDT.

The chain is the oracle, not the app's formulas. The suite reads the account's wallet balance and shares at the receipt's block and at its parent block. It parses the wrapper's `Deposit` and `Withdraw` events and the base token's `Transfer` events in the receipt. The suite checks that the receipt's block holds that transaction alone, so the parent block holds the state just before it. It also checks that each test account has no code and no transactions before its first use. The bound for a delayed exit comes from the wrapper's own `convertToAssets` and Comet's own `getSupplyRate`. The check of the panel's value uses `convertToAssets` too.

Every signed exit goes through one check, `expectExitPaid`. It requires the exact burned shares, a `Withdraw` event naming them, and the exact cash, all of it in base-token transfers to the account. The one-slot exit is checked the same way for its shares, and against its bound for its cash.

Each market's supply-and-exit sequence runs as one session of the app. Every other scenario runs in its own anvil snapshot with a fresh app, and the fork returns to the snapshot afterwards.

## Recorded runs

Both runs below used commit `18cfa4e` of this branch, with no uncommitted changes.

|                                 | Pinned-block run                                                                       | Recent-block run                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Upstream                        | `https://eth.drpc.org` (public)                                                        | `https://eth.drpc.org` (public)                                                         |
| Fork block                      | 26244888, the registry's pinned block                                                  | 26253275, the latest block less 8 when the run started                                  |
| Block hash                      | `0x440c51a6a6953b880568c1b60e4ad59044f3fa783e340e34d66793e466883839`                   | `0x64d195a2a984208c06b19206392cabc331d1807c14328cb94e8ce4c5710c07ce`                    |
| Block time                      | 2026-10-22 01:32:47 UTC                                                                | 2026-10-23 05:36:47 UTC                                                                 |
| Local fork                      | 127.0.0.1, chain ID 1, Prague rules, no CORS, upstream through the runner's proxy      | the same                                                                                |
| Tools                           | Node 22.22.0, anvil 1.2.3-stable (`a813a2c`), Jest 30.2.0                              | the same                                                                                |
| Result                          | PASS: 65 tests passed, 0 failed, 0 not exercised, in 391 s                             | PASS: 65 tests passed, 0 failed, 0 not exercised, in 429 s                              |
| Upstream use, through the proxy | 4,119 requests forwarded, 0 failed upstream, 0 calls answered with an error, 0 refused | 4,152 requests forwarded, 35 failed upstream, 0 calls answered with an error, 0 refused |

The 65 tests are the 21 scenarios on each of the three markets, the factory's bytecode comparison and the test of the suite's network guard. In the recent-block run, the upstream failed 35 requests, the first with `HTTP 429`. anvil's own retries recovered from each, and no test failed. The raw logs of both runs are under `/tmp/com289-fork/` on the machine that ran them, and the PR quotes their summaries.

## Scenario matrix

Every cell passed in both runs. The factory has only the bytecode comparison.

| Scenario                          | What the fork exercises                                                                                       | USDC | USDT | Institutional USDC | Factory |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---- | ---- | ------------------ | ------- |
| `deployment`                      | Code hash against the registry, `getWrapper`, `asset()`, decimals, Permit2, the app's `validateWrappedMarket` | pass | pass | pass               | -       |
| `source-build`                    | Deployed runtime against the compiled build input, outside the immutables                                     | pass | pass | pass               | pass    |
| `supply-zero-allowance`           | An exact approval, then `supplyAndWrap`                                                                       | pass | pass | pass               | -       |
| `supply-sufficient-allowance`     | `supplyAndWrap` alone                                                                                         | pass | pass | pass               | -       |
| `supply-insufficient-allowance`   | USDT: reset to 0, exact approval, supply. USDC: exact approval, supply                                        | pass | pass | pass               | -       |
| `accrued-value`                   | 30 days of interest in the panel's value                                                                      | pass | pass | pass               | -       |
| `partial-exit`                    | 1,000 base units, mined at the quote block's timestamp                                                        | pass | pass | pass               | -       |
| `partial-exit-delayed`            | 500 base units, mined one slot (12 s) after the quote block                                                   | pass | pass | pass               | -       |
| `partial-exit-held-open`          | 300 base units, confirmed a day after the review, or sooner at a high rate                                    | pass | pass | pass               | -       |
| `partial-exit-held-too-long`      | 300 base units, confirmed after twice the time interest takes to reach 0.1%                                   | pass | pass | pass               | -       |
| `full-exit`                       | The whole balance, mined at the quote block's timestamp                                                       | pass | pass | pass               | -       |
| `dust`                            | A position worth no more than the buffer, and the dust a partial exit of the whole cash leaves                | pass | pass | pass               | -       |
| `pause`                           | The pause guardian pauses withdrawals, then supplies                                                          | pass | pass | pass               | -       |
| `insufficient-liquidity`          | A borrower leaves 50 base units in Comet                                                                      | pass | pass | pass               | -       |
| `excessive-debit`                 | A back-dated accrual makes Comet debit more than the shares cover                                             | pass | pass | pass               | -       |
| `estimate-rose`                   | A donation of at least 0.5% of the wrapper's assets between review and signature                              | pass | pass | pass               | -       |
| `stale-state`                     | Shares, cash, allowance and wallet balance change between review and signature                                | pass | pass | pass               | -       |
| `session-races`                   | Account, chain, market, screening, connector and release controls change between review and signature         | pass | pass | pass               | -       |
| `other-connectors-and-watch-only` | Four other connectors, watch-only, and screening that has not allowed the account                             | pass | pass | pass               | -       |
| `direct-alongside`                | A direct ETH-collateral borrow through the Bulker beside a wrapped supply and exit                            | pass | pass | pass               | -       |
| `standard-route-lending`          | A MetaMask session's direct supply and withdrawal through the Bulker                                          | pass | pass | pass               | -       |

## The supply-and-exit sequence's exits against their quotes

The table gives the pinned-block run's partial, one-slot, held-open and full exits. `expectExitPaid` holds every other signed exit to its quote in its own scenario:

- the exit after a pause is lifted
- the partial exit that leaves dust
- the exit of the 50 that Comet's cash still pays
- the fresh review and the full exit after a donation
- the fresh review after a review held too long
- the wrapped exit beside a direct borrow

Shares are in share units (18 decimals) and cash in base units (6 decimals). An exit is held to the quote of the check just before its signature when that check ran at a later block than the review. Otherwise it is held to its review's quote, which the check then quoted again unchanged.

| Market             | Exit                                | Quoted shares                 | Burned shares                 | Reviewed cash | The check's cash | Paid cash     | Held to    | Paid minus that quote | Tolerance |
| ------------------ | ----------------------------------- | ----------------------------- | ----------------------------- | ------------- | ---------------- | ------------- | ---------- | --------------------- | --------- |
| USDC               | partial 1,000, at its quote's state | 993,958,141,107,603,898,111   | 993,958,141,107,603,898,111   | 1,000,000,000 | 1,000,000,000    | 1,000,000,000 | the review | 0                     | 0         |
| USDC               | partial 500, one slot later         | 496,979,071,665,689,208,885   | 496,979,071,665,689,208,885   | 500,000,000   | -                | 500,000,008   | the review | 8                     | 0 to 11   |
| USDC               | partial 300, confirmed a day later  | 298,187,439,133,936,271,105   | 298,187,439,133,936,271,105   | 300,000,000   | 300,034,730      | 300,034,730   | the check  | 0                     | 0         |
| USDC               | full, at its quote's state          | 1,403,669,833,018,404,654,004 | 1,403,669,833,018,404,654,004 | 1,415,190,406 | 1,415,190,406    | 1,415,190,406 | the review | 0                     | 0         |
| USDT               | partial 1,000, at its quote's state | 994,890,452,605,461,562,092   | 994,890,452,605,461,562,092   | 1,000,000,000 | 1,000,000,000    | 1,000,000,000 | the review | 0                     | 0         |
| USDT               | partial 500, one slot later         | 497,445,227,415,312,412,095   | 497,445,227,415,312,412,095   | 500,000,000   | -                | 500,000,006   | the review | 6                     | 0 to 9    |
| USDT               | partial 300, confirmed a day later  | 298,467,133,700,718,262,867   | 298,467,133,700,718,262,867   | 300,000,000   | 300,026,487      | 300,026,487   | the check  | 0                     | 0         |
| USDT               | full, at its quote's state          | 1,402,686,031,791,945,927,179 | 1,402,686,031,791,945,927,179 | 1,412,834,465 | 1,412,834,465    | 1,412,834,465 | the review | 0                     | 0         |
| Institutional USDC | partial 1,000, at its quote's state | 996,044,015,171,352,018,094   | 996,044,015,171,352,018,094   | 1,000,000,000 | 1,000,000,000    | 1,000,000,000 | the review | 0                     | 0         |
| Institutional USDC | partial 500, one slot later         | 498,022,008,699,351,278,539   | 498,022,008,699,351,278,539   | 500,000,000   | -                | 500,000,005   | the review | 5                     | 0 to 8    |
| Institutional USDC | partial 300, confirmed a day later  | 298,813,202,888,587,926,191   | 298,813,202,888,587,926,191   | 300,000,000   | 300,022,987      | 300,022,987   | the check  | 0                     | 0         |
| Institutional USDC | full, at its quote's state          | 1,403,088,417,426,653,517,350 | 1,403,088,417,426,653,517,350 | 1,411,586,558 | 1,411,586,558    | 1,411,586,558 | the review | 0                     | 0         |

The tolerances and their reasons:

- **Shares burned: 0 share units.** `unwrapAndWithdraw(shares)` burns exactly the shares in its argument, so any difference is a fault.
- **Cash at the quote's state: 0 base units.** anvil mined each exit in a block with the timestamp of the block its quote read. The wrapper then prices the exit from the same Comet balance, `totalSupply` and stored supply index that the quote read. The quote transcribes the wrapper's rounding: `floor(shares × (totalAssets + 1) ÷ (totalSupply + 10^12)) − (floor(baseSupplyIndex ÷ 10^15) + 2)`. So any difference is a fault in the quote. The app's own check before the signature also requires its simulation to pay exactly this quote.
- **Cash one slot later: 0 to `ceil(worth × supplyRate × 12 ÷ 10^18) + 2` base units.** In 12 seconds, Comet accrues interest on the wrapper's balance, so the same shares pay more. `worth` is the wrapper's own `convertToAssets(shares)` at the quote's block, and `supplyRate` is Comet's `getSupplyRate(getUtilization())` there. The payout and the quote each round down, so they differ by at most 1 unit more than the interest. Comet's rounding of the wrapper's balance adds less than 1 unit to the shares' value. The bound assumes that no other transaction touches Comet between the quote and the exit, as on the fork. A payout below the quote is a fault, because the review shows the quote as the least the user gets.

Each partial exit's `Withdraw` event carries the shares quoted. Comet debited the wrapper 1,000,000,001 base units for each 1,000,000,000 that the partial exits paid, so the wrapper's buffer absorbed one unit of Comet's rounding.

### A review held open

COM-288's check before the signature quotes the reviewed shares again at its own block. It stops a partial exit whose payout rose more than 0.1% (10 basis points) above the reviewed cash. It lets a full exit go on at any rise. On the fork:

| Pinned-block run                                            | USDC                                                                                                                                                | USDT                                                                                                                                                | Institutional USDC                                                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time the review stayed open                                 | 1 day                                                                                                                                               | 1 day                                                                                                                                               | 1 day                                                                                                                                               |
| Rise of the 300 exit's payout in that time                  | 1.157 basis points                                                                                                                                  | 0.882 basis points                                                                                                                                  | 0.766 basis points                                                                                                                                  |
| Paid less the check's quote                                 | 0                                                                                                                                                   | 0                                                                                                                                                   | 0                                                                                                                                                   |
| Days of interest at the market's supply rate to reach 0.1%  | 8.6                                                                                                                                                 | 11.3                                                                                                                                                | 13.1                                                                                                                                                |
| Confirmed after twice the time interest takes to reach 0.1% | after 17.2 days, stopped: "This withdrawal now pays about 300.599999 USDC, more than 0.1% above the 300.000000 USDC you reviewed. Review it again." | after 22.7 days, stopped: "This withdrawal now pays about 300.599999 USDT, more than 0.1% above the 300.000000 USDT you reviewed. Review it again." | after 26.1 days, stopped: "This withdrawal now pays about 300.600000 USDC, more than 0.1% above the 300.000000 USDC you reviewed. Review it again." |
| A fresh review of the same 300                              | burns fewer shares, pays exactly its quote                                                                                                          | the same                                                                                                                                            | the same                                                                                                                                            |

The supply rates had moved by the recent block. There, the days of interest to the 0.1% bound were 7.0 for USDC, 6.0 for USDT and 13.4 for institutional USDC. At these rates, interest alone stops a partial exit only when its review stays open for 6.0 days or more. A larger rise within a shorter time has another cause, such as a donation to the wrapper.

The suite sizes both waits from Comet's supply rate at the review's block. The shorter wait is a day, or a quarter of the time to the bound if that is less. The longer wait is twice the time to the bound. So the scenarios hold at other rates. At a supply rate of 0, no interest accrues, and the suite records `accrued-value` and both held-open scenarios as not exercised.

## Supply, allowance and accrual

| Figure, pinned-block run                                          | USDC                                                     | USDT                        | Institutional USDC  |
| ----------------------------------------------------------------- | -------------------------------------------------------- | --------------------------- | ------------------- |
| Steps for 1,000 from a zero allowance                             | approve, supply                                          | approve, supply             | approve, supply     |
| Steps for 1,000 with a 2,000 allowance                            | supply                                                   | supply                      | supply              |
| Steps for 1,500 with a 1,000 allowance                            | approve, supply                                          | reset to 0, approve, supply | approve, supply     |
| The token's own `approve` from 1,000 to 1,500, called directly    | succeeds                                                 | reverts without data        | succeeds            |
| Allowance after each supply                                       | 0 after an exact approval, and 1,000 after the 2,000 one | the same                    | the same            |
| Wallet change for each supply                                     | exactly the amount                                       | exactly the amount          | exactly the amount  |
| Comet's credit to the wrapper for the first 1,000,000,000         | 999,999,998                                              | 999,999,999                 | 999,999,999         |
| Panel value after that supply                                     | 999,999,997                                              | 999,999,998                 | 999,999,998         |
| Interest in 30 days on 3,500 supplied                             | 11,568,710                                               | 9,264,707                   | 8,039,327           |
| Panel value against the wrapper's `convertToAssets` after 30 days | equal                                                    | equal                       | equal               |
| Gas limit and gas used of a supply's `supplyAndWrap`              | 275,793 and 182,155                                      | 275,174 and 181,742         | 279,678 and 184,744 |
| Gas limit and gas used of a 1,000 partial exit                    | 193,012 and 136,009                                      | 192,814 and 135,844         | 197,524 and 139,769 |

Comet credits the wrapper 0 to 2 base units less than it supplies, and the share calculation rounds down once more. A supply and an immediate full exit therefore return the buffer of 3 plus up to 3 units of rounding less than the supply. The [direct-alongside](#direct-lending-beside-a-wrapped-position) run shows 999,999,995 back for 1,000,000,000 on each market.

The app sends each wrapper transaction with 120% of anvil's gas estimate. The gas limits above are 1.4 to 1.5 times the gas used.

## Injected failures

Each injection changes the fork only. Every one but the excessive debit is an ordinary transaction that a real account can send.

| Case                        | Injection on the fork                                                                                                                                                                                                          | What the app did                                                                                                                                                                                                                                                                                                                       | What the chain did                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Dust                        | 2 × 10^12 shares, worth 2 base units, sent to a fresh account                                                                                                                                                                  | Refused the review: "Your wrapped position is worth no more than the wrapper's rounding buffer of 0.000003 USDC, so the wrapper refuses to withdraw it (ZeroAssetsTransferred)." The panel showed 0 to withdraw.                                                                                                                       | `unwrapAndWithdraw` of those shares reverts with `ZeroAssetsTransferred`                                                 |
| Dust left by a partial exit | A partial exit of the whole position's cash                                                                                                                                                                                    | Paid exactly the quote, and flagged the leftover shares in the quote. Then refused a review of the leftover with the same message.                                                                                                                                                                                                     | The leftover's exit reverts with `ZeroAssetsTransferred`                                                                 |
| Pause                       | The pause guardian `0xbbf3f1421D886E9b2c5D716B5192aC998af2012c` calls `pause`                                                                                                                                                  | Stopped a reviewed exit before the signature (`withdraw-paused`) and a reviewed supply (`supply-paused`). Refused a fresh exit review. After the guardian lifted the pause, a fresh exit of 100 signed and paid exactly its check's quote, 100,000,000 on USDC.                                                                        | The exit and the supply revert with Comet's `Paused`                                                                     |
| Insufficient liquidity      | A borrower with WETH collateral borrows all but 50 base units of Comet's cash (46,298,721 USDC, 18,417,004 USDT and 4,870,528 institutional USDC)                                                                              | Stopped a reviewed full exit before the signature. Refused a fresh full exit, with "Withdraw at most 50.000000". Refused 50.000001. Paid exactly 50.000000 on chain.                                                                                                                                                                   | A full exit reverts: "ERC20: transfer amount exceeds balance" for USDC, and a revert without data for USDT               |
| Excessive debit             | A storage write moves Comet's `lastAccrualTime` back by 37.9 years (USDC) or 55.1 years (USDT). For institutional USDC, a borrow first raises its supply rate, and the write moves it back by 5.7 years.                       | Its check before the signature refused the exit: "... (ExcessiveAssetsDebited). Try again in a few minutes, or with a different amount. Your wallet was not asked to sign it." Nothing was sent.                                                                                                                                       | The exit reverts with `ExcessiveAssetsDebited(sharesRequired, sharesBurned)`, with `sharesRequired` above `sharesBurned` |
| Donation                    | A third party's `comet.supplyTo(wrapper, base, amount)` after a partial-exit review, and again after a full-exit review. The amount is 100 base units or 0.5% of the wrapper's assets, whichever is more: 100,000,000 on USDC. | Stopped the partial exit: "This withdrawal now pays about 523.693292 USDC, more than 0.1% above the 500.000000 USDC you reviewed. Review it again." A fresh review burned fewer shares and paid exactly its quote. The full exit went on and paid exactly the check's quote, 1,688,018,286 against the reviewed 1,594,773,164 on USDC. | -                                                                                                                        |
| Shares moved                | The account sends shares away after the review                                                                                                                                                                                 | Stopped the exit: "Your wrapped balance is now below the shares this withdrawal burns."                                                                                                                                                                                                                                                | -                                                                                                                        |
| Shares added                | The account supplies 10 more after a full-exit review                                                                                                                                                                          | Stopped the exit: "... this full exit no longer burns exactly all your shares."                                                                                                                                                                                                                                                        | -                                                                                                                        |
| Cash fell                   | A third party calls `comet.transfer(wrapper, 0)` three times, in blocks with the review's timestamp                                                                                                                            | Stopped the exit: "This withdrawal now pays about 499.999999 USDC, less than the 500.000000 USDC you reviewed."                                                                                                                                                                                                                        | The three transfers took 3 units of the wrapper's Comet principal, and its balance fell by 3 base units                  |
| Allowance changed           | The account approves 123 outside the app after the review                                                                                                                                                                      | Stopped the approval: "The wrapper's allowance is now 123.000000 USDC, not what this review expected."                                                                                                                                                                                                                                 | -                                                                                                                        |
| Wallet balance fell         | The account sends its wallet down to 100 after the review                                                                                                                                                                      | Stopped the approval: "Your wallet now holds 100.000000 USDC, less than this supply."                                                                                                                                                                                                                                                  | -                                                                                                                        |

In each "Stopped" case above, the suite checked that the account's nonce and the fork's block number did not change.

`ExcessiveAssetsDebited` needs Comet to accrue to an index at least two whole units (2 × 10^15) above the stored index that sets the wrapper's buffer. A live market accrues on every interaction, so its stored index trails by far less. The fork reaches the revert only through the storage write. The revert also depends on the block's timestamp. The suite sent the refused exit outside the app in a block with the simulated block's timestamp, and it reverted. In a later block, Comet accrues further and the same shares can pay. The app's message, "Try again in a few minutes", matches that.

## Direct lending beside a wrapped position

On each market, the same account ran the standard route's own transactions through `useWriteCometState` and the transaction manager. First came `comet.allow(bulker, true)`, then a Bulker call that supplies 10 ETH as collateral and borrows 2,000. It then supplied 1,000 through the wrapper, exited the wrapper in full, and finally repaid the debt and withdrew the ETH through the Bulker. Every block in this scenario has one timestamp, so the debt accrues no interest between readings, and the wrapped exit pays exactly its reviewed quote.

| Figure, pinned-block run                                              | USDC               | USDT               | Institutional USDC |
| --------------------------------------------------------------------- | ------------------ | ------------------ | ------------------ |
| Direct debt, before and after the wrapped supply and the wrapped exit | 2,000,000,000      | 2,000,000,000      | 2,000,000,000      |
| Dashboard borrow capacity, unchanged by the wrapped supply and exit   | 20,371,666,168     | 20,514,584,541     | 21,482,847,959     |
| Dashboard base balance, unchanged                                     | -2,000,000,000     | -2,000,000,000     | -2,000,000,000     |
| Comet's credit to the wrapper                                         | 999,999,999        | 999,999,999        | 999,999,999        |
| Change in Comet's `totalSupply()`                                     | 999,999,999        | 999,999,999        | 999,999,999        |
| Change in the dashboard's market supply, in dollars with 8 decimals   | 99,981,254,900     | 99,886,443,900     | 99,981,254,900     |
| The credit's value at the dashboard's price                           | 99,981,254,900     | 99,886,443,900     | 99,981,254,900     |
| `getAssetInfoByAddress(wrapper)`                                      | reverts `BadAsset` | reverts `BadAsset` | reverts `BadAsset` |
| Wrapped exit paid to the wallet                                       | 999,999,995        | 999,999,995        | 999,999,995        |
| Debt and ETH collateral after the Bulker repay and withdrawal         | 0 and 0            | 0 and 0            | 0 and 0            |

From these figures:

- The wrapped supply and exit changed none of the account's direct figures, on chain or on the dashboard. Those figures are principal, debt, ETH collateral, borrow capacity, liquidation capacity, collateral value and base balance.
- Comet counts the wrapped supply once, as the wrapper's own balance. The market total grew by the credit, and the dashboard's market supply grew by exactly the credit's value.
- Comet lists no wrapper as an asset, so wrapper shares add no borrowing capacity.
- The read-only account view, rendered with no wallet, showed the same direct figures as the connected view.
- On this route, `isSubmissionRefused` refused a direct base supply and a repay above the debt. It allowed a borrow, a repay within the debt and a full repay.
- `planExecution` refused a request that held the wrapped draft and a direct borrow (`mixed-execution`). `submitExecution` called neither path, and `getBulkerTrxData` refused the draft. Nothing was sent.
- Mainnet USDT is the one wrapped market the app flags with `getIsDeprecatedwUSDMMarket`, which selects its deprecated price-feed handling. Its Comet state loaded and behaved as the other two markets did.

On each market, a MetaMask session on the standard route also supplied 1,000 of the base token directly to Comet through the Bulker and withdrew all of it. `isSubmissionRefused` allowed that supply. Comet credited 999,999,999, the dashboard showed the same balance, and the withdrawal left 0 in Comet and 9,999,999,999 in the wallet.

## Sessions and connectors

For each market, the suite reviewed a supply and a withdrawal, kept the confirmation handler from that render, and then changed the session. Each of these changes discarded the draft with `identity-changed`:

- the account
- the chain, to 5
- the market
- screening, to `blocked`
- the connector, to MetaMask
- the release controls, to the committed `false`

The kept handler then sent nothing, and a return to the reviewed session did not bring the draft back. Three seconds later, the app's wallet had received no request to send a transaction, and the account's nonce and the fork's block number were unchanged.

On a wrapped market, MetaMask, WalletConnect, Coinbase, a generic injected wallet and a watch-only session each stayed on the standard route. There, `supply` and `withdraw` returned `not-wrapped` and the position read returned `not-applicable`. With the Anchorage connector and screening `checking` or `blocked`, `supply` returned `screening`. No session sent a transaction.

## Deployed bytecode and source

The suite and the steps above checked the deployment as follows:

- **Code hashes.** At both fork blocks, each wrapper's runtime code hash equals the hash the registry records. Each runtime is 10,422 bytes.
- **Code from four providers.** The bytecode comparison runs on code that the upstream served. So the code was also read at block 26244888 from four independent public providers: dRPC, Tenderly, Blast and MEV Blocker. All four served the same block hash, `0x440c51a6…883839`, and the same code for the three wrappers and the factory. The factory's code hash is `0x2cca1afe49da06952734d234fb179bab07963c0d602fd1b7275b5c10b4769864`, for 17,101 bytes. No provider's state was proved against the block's state root.
- **Wrapper check.** The app's `validateWrappedMarket` returned `matched` for all three wrappers through the fork.
- **Bytecode.** The deployed runtime of each wrapper equals the compiled runtime of `WrappedCometERC4626` in the build input, outside its 22 immutable ranges. The factory's runtime, 17,101 bytes, equals the compiled `WrappedCometERC4626Factory`, outside its 3 ranges. Each immutable holds one value across its ranges:

  | Immutable             | USDC wrapper                | USDT wrapper        | Institutional USDC wrapper | Factory  |
  | --------------------- | --------------------------- | ------------------- | -------------------------- | -------- |
  | `_asset`              | `0xc3d688B6…84cdc3`         | `0x3Afdc9BC…AB0840` | `0x207158a2…709F2F8C`      | -        |
  | `_underlyingDecimals` | 6                           | 6                   | 6                          | -        |
  | `PERMIT2`             | `0x000000000022D473…C78BA3` | the same            | the same                   | the same |
  | `DECIMALS_OFFSET`     | 12                          | 12                  | 12                         | -        |
  | `VIRTUAL_SHARES`      | 10^12                       | 10^12               | 10^12                      | -        |

- **Build input.** The build input's five project sources are byte-identical to `src/` at `1152de2`. Its 21 OpenZeppelin sources are byte-identical to the published `@openzeppelin/contracts` 5.7.0 package, whose tarball has sha256 `ab2a1b476b9e2d84225454eca21783805db5754b5f8dfb3d6fca05341b00b8ea`. To repeat the comparison, unpack `npm pack @openzeppelin/contracts@5.7.0`. Compare each `npm/@openzeppelin/contracts@5.7.0/<path>` source in the build input's `input.sources` with `package/<path>`, and each `project/src/<path>` source with the repository's `src/<path>`.
- **Post-audit changes.** From the audited `f0dcf4a` to `1152de2`, four commits change `src/`. Two of them, `97265b9` and `7f60b8a`, change executable code: `previewDeposit`, `previewMint` and `previewRedeem` now revert where the action they preview reverts. The other two change comments only. The frontend calls none of the three preview functions, and neither `supplyAndWrap` nor `unwrapAndWithdraw` calls them.

The bytecode result answers release check 2: the runtime is reproduced from the `1152de2` build input with the immutables masked. Release check 1, audit coverage of the post-audit preview changes, stays open. A matching build shows which source is deployed, not that the source is safe.

## Standard flows in the unit suites

The unit suites cover the standard flows that need no chain. `yarn test` ran them on the same commit as the fork runs: 1,260 passed and 1 failed, in 60 suites. The failure is `useMarketsOverviewState.test.tsx` ("should return MarketOverviewState after fetch"). It fails the same way at the base `4285316`, COM-288's head, which gives the same counts, 1,260 passed and 1 failed, in 60 suites.

| Area                                        | Suites and passing tests                                                                                                                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Other wallets and connectors                | `walletConnectors` 96, `eip6963Security` 15, `ConnectWalletModal` 18, `safe` 9, `lendingRoute` 60, `useLendingRoute` 32                                                                                                                                                |
| Ordinary supply, withdraw, borrow and repay | `actions` 39, `bulkerActions` 15, `ActionInputView` 18, `Masthead/actionButtons` 31, `useActionQueue` 23, `useGasEstimates` 8, `useTransactionManager` 43, `numbers` 42                                                                                                |
| Screening                                   | `screening` 7, `sanctions` 2, `useAddressScreening` 5, `useAddressScreeningDevBypass` 3, `useDisconnectBlockedWallet` 3, `ScreeningErrorOverlay` 6                                                                                                                     |
| Deprecated markets and legacy collateral    | `legacyCollateral` 29, `markets` 22, and the deprecated-market case in `lendingRoute`                                                                                                                                                                                  |
| Watch mode and read-only views              | the watch-only cases in `useLendingRoute`, `useCometState` 3, `useSelectedMarket` 9, `useWrappedPosition` 16                                                                                                                                                           |
| Queue races and mixed requests              | `useActionQueue` 23, `wrappedActions` 71, `wrappedRouteWiring` 13, `reviewInvalidation` 34                                                                                                                                                                             |
| Wrapped lending                             | `wrappedMarkets` 2, `wrappedPositions` 29, `wrappedWithdrawals` 52, `useWrappedAction` 113, `useWriteWrappedState` 164, `WrappedPositionPanel` 15, `WrappedSupply` 52, `WrappedWithdraw` 56, `Masthead/wrappedRoute` 4, `MarketWrappedRoute` 2, `WrappedRouteNotice` 1 |

## Limitations

- **No Porto signing.** anvil signs for impersonated accounts. The suite does not exercise Porto's display of the calls, its `chainId` handling, its gas limit or its delays. COM-290 covers those.
- **State from a public endpoint.** The runs forked from `eth.drpc.org`. The runner checks the fork block's hash against the upstream and the registry, but anvil does not prove the state it fetches against the block's state root.
- **Controlled timestamps.** The exact comparisons mine an exit in a block with its quote block's timestamp, which mainnet never does. The one-slot and held-open runs measure the realistic cases. The suite does not model other transactions between the quote and the exit.
- **Fork-only injections.** The excessive-debit case needs a storage write that no transaction can make. The dust, pause, liquidity, donation and stale cases use ordinary transactions, from impersonated accounts. The donation and the review's waits are sized from the chain at the review's block.
- **Release controls.** The suite opens both release controls in its own registry fixture. The committed configuration keeps them `false` on all three markets.
- **Hooks, not screens.** The suite renders the app's hooks, not the panel or the dialogs. The unit suites cover the components (`WrappedSupply`, `WrappedWithdraw`, `WrappedPositionPanel`, `wrappedRouteWiring`).
- **Fresh state on each run.** Each run fetches state again, because the runner disables anvil's cache. So anvil writes nothing outside the runner's log and temporary directories.
- **Local processes during a run.** While the suite runs, any process on the machine can call the fork and the proxy on 127.0.0.1. Such a process can change the fork's state, and so a run's results. Through the proxy, it can make only the reads that anvil makes, and they spend the upstream's quota. Neither the fork nor the proxy gives it the upstream URL. On Linux and macOS, a process of the same user can read the runner's environment, which holds the URL. Set `WRAPPED_FORK_RPC_URL` only on a machine you control.
- **Web pages during a run.** A browser sends an Origin header with each POST, so the proxy refuses every request from a web page. The fork's anvil checks no Host header, so a web page open during a run can reach the fork through DNS rebinding. Such a page can change the fork's state and so a run's results. It cannot read the upstream URL, which anvil does not hold. Run the suite with no untrusted page open.
- **A killed runner.** If the runner itself is killed with SIGKILL, anvil keeps running until you stop it, with `pkill -f 'anvil --fork-url http://127.0.0.1'`. It holds no secret, and its upstream, the proxy, stopped with the runner.
- **Prague rules.** anvil 1.2.3 runs the fork under Prague, the latest hardfork it implements. Its default for a fork was Cancun. Mainnet runs at least Osaka's rules at these blocks, so the fork trails mainnet. Osaka adds the CLZ opcode and a P-256 precompile, reprices MODEXP and caps a transaction's gas at 2^24. The wrappers and Comet use none of the three, and each suite transaction stays far below the cap. A later hardfork can change gas costs, so the recorded gas figures can differ from mainnet's.

## Findings

- The fork found no difference between the app's quotes and the chain. Every exit at its quote's state paid exactly the quote, and every exit held to the check's quote paid exactly that quote. The app's simulation check passed for every signed exit.
- The fork found no gap in the COM-287 or COM-288 code, so no unit test changed. The excessive-debit check, the USDT reset, the liquidity limit and the 0.1% bound each behaved as their unit tests assume, against the deployed contracts.
- A third party can lower a wrapped position's cash by a few base units with `comet.transfer(wrapper, 0)`, as the wrapper's own documentation describes. Each such transfer took one unit of principal from the wrapper. If the transfers land before the app's check reads the chain, the app stops the exit for a fresh review. Transfers between that check and the exit's inclusion still lower the payout, because `unwrapAndWithdraw` has no minimum amount. The third party can repeat the transfers to delay an exit, at its own gas cost.
- A third party can raise every share's value with `comet.supplyTo(wrapper, …)`. The app stops a partial exit whose payout rose more than 0.1% by the time of its check. It lets a full exit go on and pay the higher amount the check quoted.
- These release checks in the registry stay open:
  - 1, audit coverage of the post-audit changes
  - 3, the factory owner's signers
  - 4, live reads on release day
  - the Porto part of 5 (COM-290)
  - 6, the rollout decision (COM-292)

# Anchorage wrapped lending: Porto validation checklist (COM-290)

This checklist is the manual acceptance run of wrapped lending with the Anchorage Digital extension and the Porto mobile app. Its status on 2026-10-26 is: not executed. Two attempts, on 2026-10-23 and 2026-10-26, each stopped at its first request, the USDC approval of step M1. At the last chain reads of each attempt, the approval had not landed. [Findings for Anchorage](#findings-for-anchorage) records what the extension answered. Every other result slot below is empty.

Only Adam can run it. The wrappers exist on Ethereum mainnet only, and Porto cannot sign on a fork. So each signature is a real-value mainnet transaction, and each one needs his explicit authorization first. The mainnet-fork suite (COM-289, [`anchorage-wrapper-verification.md`](anchorage-wrapper-verification.md)) and the unit suites signed with impersonated accounts and fakes, so they do not replace this run.

Sources:

- COM-284's Porto findings, in the [COM-284 comment of 2026-10-21](https://linear.app/compoundfoundation/issue/COM-284#comment-a7c2bf6d-9fdd-4f67-8c30-256847e70a59).
- The deployment record in [`anchorage-wrapper-registry.md`](anchorage-wrapper-registry.md).
- The code of PRs #60, #61, #64, #65, #66 and #67, cited by file and line.

The run's record goes to COM-290. Its history captures feed [`anchorage-history-decision.md`](anchorage-history-decision.md) (COM-291).

## Where each COM-290 criterion is checked

| COM-290 acceptance criterion                                                                            | Checked in                                                                                          |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Approvals, supply, partial and full exits on all three markets, with authorized real-value tests        | [Authorization](#authorization-fill-in-before-any-signature), [Per-market run](#per-market-run)     |
| Refresh, reconnect, chain switching, mobile delays, rejection and pending recovery, no stale submission | [Session scenarios](#session-scenarios)                                                             |
| Wrapped balances and USD values in Compound and Porto, with display findings sent to Anchorage          | [Per-market run](#per-market-run) step M2, [Findings for Anchorage](#findings-for-anchorage)        |
| Familiar supply and withdraw, with accurate amounts and approvals                                       | [Mobile preview](#check-every-mobile-preview-before-you-approve), [Per-market run](#per-market-run) |
| Wallet switching, Anchorage-only holder visibility and exits, read-only views                           | [Session scenarios](#session-scenarios) S9, S11 and S12                                             |
| Compound and Porto history before and after reload, for COM-291                                         | [Capture for COM-291](#capture-for-com-291)                                                         |
| Release-blocking failures fixed, product limitations listed                                             | [Results](#results)                                                                                 |
| A successful `wallet_switchEthereumChain` is not proof of a usable provider                             | [Session scenarios](#session-scenarios) S6 and S7                                                   |
| Awaiting approval, broadcast, confirmation, rejection and provider failure told apart                   | [Telling the states apart](#telling-the-states-apart)                                               |
| The COM-284 wallet's direct position is not reset, migrated or liquidated                               | [Authorization](#authorization-fill-in-before-any-signature)                                        |

## Authorization (fill in before any signature)

Do not request any signature until Adam has filled in this block and posted it as a COM-290 comment. A request outside the block is unauthorized. Reject it on mobile and record it under [Results](#results).

| Field                                                 | Value                                                                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Authorized by                                         |                                                                                                                              |
| Date and time (UTC)                                   |                                                                                                                              |
| Link to the COM-290 comment that records it           |                                                                                                                              |
| Test wallet                                           | Default: the COM-284 test wallet. The COM-284 comment names its address and vault. Any other account needs its own approval. |
| Network                                               | Ethereum mainnet, chain ID 1, and no other network                                                                           |
| Markets in scope                                      | [ ] USDC [ ] USDT [ ] Institutional USDC                                                                                     |
| Funding: token, amount, source and sender             |                                                                                                                              |
| Most base units supplied in total, per market         |                                                                                                                              |
| Most ETH spent on gas in total                        |                                                                                                                              |
| Second wallet for scenario S9: wallet app and address |                                                                                                                              |
| Account for an empty-account run, if any              |                                                                                                                              |

List every request here before it is made, a request that the run rejects on mobile included. Fill in the amounts in raw base units (6 decimals) and the shares as the dialog shows them.

| Row | Market             | Step                                                   | Target                                                                  | Call and raw arguments                                            | Authorized (initials) |
| --- | ------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------- |
| T1  | USDC               | Exact approval                                         | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`                       | `approve(0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73, <amount>)`   |                       |
| T2  | USDC               | Supply                                                 | USDC wrapper `0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73`               | `supplyAndWrap(<amount>)`                                         |                       |
| T3  | USDC               | Partial exit                                           | USDC wrapper                                                            | `unwrapAndWithdraw(<shares>)`                                     |                       |
| T4  | USDC               | Full exit                                              | USDC wrapper                                                            | `unwrapAndWithdraw(<all shares>)`                                 |                       |
| T5  | Institutional USDC | Exact approval                                         | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`                       | `approve(0xc7Eb9aA5B9ae154C1bAb08872E90fC44e522E463, <amount>)`   |                       |
| T6  | Institutional USDC | Supply                                                 | Institutional USDC wrapper `0xc7Eb9aA5B9ae154C1bAb08872E90fC44e522E463` | `supplyAndWrap(<amount>)`                                         |                       |
| T7  | Institutional USDC | Partial exit                                           | Institutional USDC wrapper                                              | `unwrapAndWithdraw(<shares>)`                                     |                       |
| T8  | Institutional USDC | Full exit                                              | Institutional USDC wrapper                                              | `unwrapAndWithdraw(<all shares>)`                                 |                       |
| T9  | USDT               | Exact approval, then stop before the supply            | USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`                       | `approve(0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf, <amount A>)` |                       |
| T10 | USDT               | Allowance reset                                        | USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`                       | `approve(0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf, 0)`          |                       |
| T11 | USDT               | Exact approval                                         | USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7`                       | `approve(0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf, <amount B>)` |                       |
| T12 | USDT               | Supply                                                 | USDT wrapper `0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf`               | `supplyAndWrap(<amount B>)`                                       |                       |
| T13 | USDT               | Partial exit                                           | USDT wrapper                                                            | `unwrapAndWithdraw(<shares>)`                                     |                       |
| T14 | USDT               | Full exit                                              | USDT wrapper                                                            | `unwrapAndWithdraw(<all shares>)`                                 |                       |
| R1  |                    | A request that the run rejects on mobile (scenario S2) |                                                                         |                                                                   |                       |

Rules for the run:

1. Earlier approvals do not carry over. Leo's approval of onboarding and access, and COM-284's withdrawal of 1 USDC, authorize no wrapper transaction.
2. Keep the test wallet's direct position: a direct cUSDCv3 supply of about 3.9992 USDC after COM-284, which grows with interest. Do not withdraw, reset, migrate or liquidate it to make an empty account. An empty-account run needs a separately authorized account.
3. Keep out of the run the production organisation wallets that the same Porto login lists (COM-284).
4. Before you approve a request on mobile, compare its preview with its row. Compare the sender, the network, the target, the function, each argument and the value. An approval's spender is an argument. Reject the request on mobile and stop the run in each of these cases:

   - A field on the preview differs from the row.
   - The preview leaves out a field, such as an approval's spender.
   - The preview cannot decode the function or an argument.
   - The preview shortens an address or rounds an amount, and no screen of the preview shows that field in full.
   - You cannot compare a field with the row for another reason.

   This checklist does not accept a comparison of the raw calldata in place of a decoded field. If you approve a request in one of these cases, the wallet can sign a call that its row does not authorize.

5. If the next request takes the run over a budget above, stop the run.
6. Sign only in a Chrome profile that holds the Anchorage Digital extension alone. Add the second wallet for S9 after the last signing row.
7. If you log into the Anchorage Digital extension again during the run, disconnect the wallet in the dApp and connect it again before the next request. The new login drops the tab's session in the extension, while the page still shows the account connected. Otherwise the next request fails with `4100` "Unauthorized" ([finding 2](#findings-for-anchorage)).

Reference figures, as facts from earlier runs. COM-284's 1 USDC withdrawal used 106,504 gas for about 0.0000045 ETH, with a 4,670 wei priority fee that Porto set. On the COM-289 fork, a `supplyAndWrap` used 181,742 to 184,744 gas and a partial exit 135,844 to 139,769 gas. Gas prices on the day of the run decide the cost.

## Build under test

These facts decide how the run is built:

- Porto cannot connect to a fork or a local RPC. Custom chains fail, and it refuses `wallet_addEthereumChain` (COM-284). So every signature in the run is a real-value mainnet transaction.
- The committed release controls are `false` on all three markets (`src/constants/wrappedMarkets.ts:89-90`, `:99-100` and `:110-111`). So every committed build keeps the wrapped supply and withdraw controls disabled.
- `build.yaml` runs on every push to any branch of this repository, and it publishes the build to IPFS through Pinata (`.github/workflows/build.yaml:1-2` and `:55-62`).

Build the app locally with the controls open:

1. Choose the commit under test: the newest head of the stack that holds the reviewed code. Fetch it into a worktree beside the main checkout, with a detached head:

   ```bash
   git fetch origin
   git worktree add --detach ../webb3-frontend-porto-run <commit>
   cd ../webb3-frontend-porto-run && yarn install --frozen-lockfile
   git rev-parse HEAD
   git status --porcelain   # expect no output
   ```

2. Copy `.env.local` from the main checkout if you use one. Reads need `VITE_V3_RPC_PROVIDER_HOST`, and history needs `VITE_V3_API_HOST` (README, "Required Environment Variables").
3. Open the release controls in this working copy only:

   ```bash
   perl -pi -e 's/(isDepositEnabled|isExitEnabled): false/$1: true/' src/constants/wrappedMarkets.ts
   git diff --stat   # expect: 1 file changed, 6 insertions(+), 6 deletions(-)
   ```

   If fewer markets are authorized, edit only their entries by hand.

4. Build and serve the app, and record the choice. Both servers bind to loopback only (`vite.config.js:18-26`).
   - Preferred: run `yarn build && yarn preview`, then open `http://127.0.0.1:4173`. This is the production build. It screens every address and fails closed, so set `VITE_SCREENING_ENDPOINT` to a worker that allows that origin (README).
   - Fallback: run `yarn dev`, then open `http://127.0.0.1:5173`. With no `VITE_SCREENING_ENDPOINT`, it skips screening and treats the address as allowed (`envVars.ts:38`, `src/hooks/useAddressScreening.ts:36-42`). It also runs React's development build and the dev-only code in `src/init.ts:12-17`. Record "dev build, screening bypassed". The run is then no evidence for screening or for the production build.
5. After the run, restore the file and check the working copy:

   ```bash
   git checkout -- src/constants/wrappedMarkets.ts
   git status --porcelain   # expect no output
   ```

   Then remove the worktree with `git worktree remove ../webb3-frontend-porto-run`.

Do not commit the opened controls, and do not push them on any branch. Otherwise `build.yaml` publishes a public build with wrapped deposits and exits open. For the same reason, do not run the "Preview PR" workflow on a PR that holds them.

| Build identity                                                   | Value                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| Commit (`git rev-parse HEAD`)                                    |                                                         |
| `git diff src/constants/wrappedMarkets.ts`                       |                                                         |
| Server (`yarn preview` or `yarn dev`) and URL                    |                                                         |
| Screening: bypassed, or the endpoint used                        |                                                         |
| Node version                                                     |                                                         |
| Chrome version                                                   |                                                         |
| Anchorage Digital extension version (from `chrome://extensions`) |                                                         |
| Porto mobile app version                                         |                                                         |
| CID                                                              | None. A local build has no CID. COM-292 releases a CID. |

Open question, owner Adam: COM-284 ran against `app.compound.xyz`. Nobody has checked whether the extension announces itself on a loopback origin such as `http://127.0.0.1:4173`. Step P1 checks it before any signature. If it does not, stop the run. Another origin, such as a private staging host that screening allows, is Adam's and Leo's decision.

## Before the first signature

These steps sign nothing.

1. P1. Open the connect list. Expected: "Anchorage Digital" appears, announced over EIP-6963 as `com.anchorage.connect`. Connect it, and check that the wallet button shows the test wallet.
2. P2. Select the Ethereum USDC market. Expected from code: the "Wrapped USDC" panel, with "Supply USDC through the wrapper" and "Withdraw USDC from the wrapper". The direct position card still shows the direct supply, about 3.9992 USDC plus interest. The direct Supply button is absent, because Home blocks a direct base supply on the wrapped route (`src/pages/home/index.tsx:104-105`).
3. P3. Record the starting figures: the direct supply, the wallet's USDC, USDT and ETH, and the wrapped shares and allowance on each market (expected: 0 and 0).
4. P4. Read each allowance on chain as well. Set the RPC once with `read -rs ETH_RPC_URL && export ETH_RPC_URL`, so its URL stays out of the shell history:

   ```bash
   cast call <base token> "allowance(address,address)(uint256)" <test wallet> <wrapper>
   ```

## Check every mobile preview before you approve

COM-284 recorded what the mobile app shows for a contract call:

- a banner for requests from an external app, and a risk check
- a simulated result, marked as not guaranteed
- decoded details: network, sender, contract, value, maximum fee, function and arguments

It showed the amount raw, for example `1000000` for 1 USDC. The app's dialogs print the same raw figure. The supply dialog says "Your wallet may show this amount in the token's base units: …" (`src/pages/home/components/ActionModal/WrappedSupplyModal.tsx:180`). The withdrawal dialog says "Your wallet may show the shares in their base units: …" (`WrappedWithdrawModal.tsx:237`).

| Preview field           | Approval or USDT reset                                                                                                 | Supply                                   | Exit                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| Network                 | Ethereum                                                                                                               | Ethereum                                 | Ethereum                                              |
| From                    | the test wallet                                                                                                        | the test wallet                          | the test wallet                                       |
| Contract                | the base token: USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` or USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7` | the market's wrapper                     | the market's wrapper                                  |
| Function                | `approve`                                                                                                              | `supplyAndWrap`                          | `unwrapAndWithdraw`                                   |
| Raw arguments           | spender: the market's wrapper. Amount: the supply's base units, or 0 for the reset                                     | amount: the supply's base units          | shares: the dialog's raw shares, 18 decimals          |
| Value                   | 0 ETH                                                                                                                  | 0 ETH                                    | 0 ETH                                                 |
| Expected balance change | none, only the allowance                                                                                               | base token down by the amount, shares up | shares down, base token up by about the dialog's cash |

| Market             | Comet                                        | Wrapper                                      |
| ------------------ | -------------------------------------------- | -------------------------------------------- |
| USDC               | `0xc3d688B66703497DAA19211EEdff47f25384cdc3` | `0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73` |
| USDT               | `0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840` | `0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf` |
| Institutional USDC | `0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C` | `0xc7Eb9aA5B9ae154C1bAb08872E90fC44e522E463` |

Rule 4 applies to the first six fields of the preview table. A preview that cannot decode the call fails rule 4, so reject the request on mobile and stop the run. Record a finding for Anchorage in the [findings table](#findings-for-anchorage) for each preview that fails rule 4. Record a finding as well for a preview that values the shares or the base token wrongly.

## Per-market run

Approve each request on mobile within about 4 minutes of pressing its Confirm. The Anchorage Digital extension 1.1.16 stops waiting for a mobile approval about 4 minutes 47 seconds after the request. It then answers the page with `-32005`, and the step reads "Your wallet still has this request open." ([Telling the states apart](#telling-the-states-apart)). The request stays open on mobile and in the extension. If a step reads that text, follow these steps before any retry:

1. Do not press Confirm again, and do not start a new review.
2. Find the open request on mobile and in the extension.
3. If the request still matches its row under rule 4, approve it on mobile. Otherwise reject it.
4. Wait until mobile and the extension show the request done.
5. Reload the page. The panel then shows the result.
6. Record the transaction from the explorer and the chain reads. The page never receives its hash.
7. Press "Stop waiting" on the panel.
8. Start a new review. It reads the new allowance and balances. After an approval that landed this way, a supply review of the same amount has only the supply step.

If a step reads "Your wallet refused this request before handling it", nothing was sent ([Telling the states apart](#telling-the-states-apart)). Disconnect the wallet in the dApp and connect Anchorage again. Check that the wallet button shows the test wallet, then start a new review.

Run USDC first, then institutional USDC, then USDT. USDT goes last because its run adds the allowance reset. For each market:

1. M1, supply from a zero allowance.
   1. Open "Supply <symbol> through the wrapper", enter the row's amount and press review.
   2. Expected review: "Approve <amount> for the wrapper", then "Supply <amount> through the wrapper" (`src/hooks/useWriteWrappedState.ts:453` and `:461`). The test wallet has no borrow, so the dialog states only that the supply does not repay a borrow (`WrappedSupplyModal.tsx:85`).
   3. Confirm the approval step. Check the mobile preview against its row, then approve it on mobile.
   4. When the approval reads "Confirmed.", confirm the supply step, and approve it on mobile after the same check.
   5. Record each hash, and the times of the request, the mobile approval, the broadcast and the confirmation.
2. M2, check the balances after the supply.
   - Compound: the panel's shares, value, USD value, wallet balance and allowance to the wrapper. An exact approval leaves an allowance of 0, as on the fork ([verification](anchorage-wrapper-verification.md#supply-allowance-and-accrual)). The direct position card must not change.
   - Porto, mobile and extension: whether the wrapper's share token appears, with which name, amount and USD value.
   - Chain: `cast call <wrapper> "balanceOf(address)(uint256)" <test wallet>`.
3. M3, partial exit.
   1. Open "Withdraw <symbol> from the wrapper", keep "An amount", enter less than the position's cash and press review.
   2. Expected review: the estimated cash, the gross value, the buffer, the shares burned, and the statement that the transaction has no minimum amount and no deadline.
   3. Confirm, check the preview against its row, and approve on mobile.
   4. Record the cash the receipt paid next to the cash the dialog showed at the signature.
4. M4, full exit. Choose "Everything (full exit)", review, confirm and approve on mobile. Expected afterwards: 0 shares, and the wallet balance up by the cash paid.
5. M5, transaction links. Open each dialog's "View on Explorer" link and each row under Pending in the wallet menu. Each must open its own hash.

On USDT only, run M6 in place of M1. It covers an approval from a zero allowance and a nonzero allowance that is short of the supply (rows T9 to T12):

1. Review a USDT supply of amount A. Confirm only the approval step (T9). When it is confirmed, close the dialog. Expected: the closed review says that nothing more is sent from it, and an allowance of A remains.
2. Review a supply of amount B, larger than A. Expected review: "Reset the USDT allowance for the wrapper to 0", "Approve B for the wrapper", then "Supply B through the wrapper" (`src/hooks/useWriteWrappedState.ts:443-464`).
3. Confirm each of the three steps, with its own mobile approval (T10 to T12).

M6 also exercises a dialog closed in the middle of a supply, one of Adam's open product questions on #65.

## Session scenarios

Each "Expected" below is expected from code until the run observes it.

| ID  | Scenario                                            | How to run it                                                                                                                                                                                                       | Expected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Delayed mobile approval                             | Leave an authorized request open on mobile for 3 to 4 minutes, then approve it. Do not wait longer: the extension answers `-32005` after about 4 minutes 47 seconds.                                                | The step reads "Confirm the request in your wallet. Approval on a mobile device can take a few minutes.", the button "Waiting for Your Wallet", and the wallet button "1 Pending". After approval: "Broadcast. Waiting for the network to confirm it.", "Waiting for the Network" and "View on Explorer", then "Confirmed." (`WrappedActionDialog.tsx:84-133`, `src/components/WalletButton.tsx:19-35`).                                                                                    |
| S2  | Mobile rejection                                    | Reject an authorized request (row R1) on mobile.                                                                                                                                                                    | One of three, depending on what Porto returns: "You rejected the request in your wallet. Nothing was sent." for code 4001 or another explicit rejection (`src/helpers/walletErrors.ts:3-5` and `:66`). "Your wallet reported an error (…). The request may still go through, so check your wallet before you try again." for a bare `-32603` or another error. An unchanged "Confirm the request in your wallet…" if Porto never answers. Record which. The wallet's nonce must not change. |
| S3  | Reload while a request waits on mobile              | Reload the page before approving a request. Then reject the request on mobile, unless its row is authorized to be sent this way.                                                                                    | The dialog is gone. The panel says that "A wallet request for an earlier wrapped transaction from this account was left open, and this page cannot follow it", and offers "Stop waiting". New wrapped reviews wait. Press "Stop waiting" only after mobile shows no open request (`WrappedPositionPanel.tsx:600-621`).                                                                                                                                                                      |
| S4  | Reload after the broadcast, before the confirmation | Reload while a step reads "Broadcast…".                                                                                                                                                                             | The wallet menu still lists the transaction under Pending, and it settles when mined. A new review waits until then: "Waiting for this account's earlier wrapped transactions to be checked and to settle." (`WrappedPositionPanel.tsx:106-107`).                                                                                                                                                                                                                                           |
| S5  | Disconnect and reconnect during a review            | With a review open, disconnect in the dApp, then reconnect Anchorage.                                                                                                                                               | The review closes with "Your wallet, network or market changed, so this supply was closed." (or "withdrawal"), and nothing is sent. The reconnected session shows the same account and no earlier review. After an approval that was confirmed before the disconnect, a new review only supplies.                                                                                                                                                                                           |
| S6  | Wrong chain                                         | Switch the wallet to Base, a network Porto serves (COM-284). Switch back afterwards.                                                                                                                                | The wrapped controls read "Switch your wallet to this market's network to use wrapped deposits." and "…withdrawals." (`WrappedPositionPanel.tsx:100-101`). An open review closes and sends nothing.                                                                                                                                                                                                                                                                                         |
| S7  | Failed reads after a reported successful switch     | Switch the wallet to Mantle with the console snippet below. Mantle is a network the app configures and Porto cannot read (COM-284). Switch back to `0x1` and reload afterwards.                                     | The panel shows "Your wallet cannot read this network, although it reported switching to it. Reload the page and reconnect your wallet, or switch it to a network it supports." with Reload (`src/hooks/useWrappedAction.ts:54-55`). No wrapped review can start.                                                                                                                                                                                                                           |
| S8  | Broken provider after an extension update           | Wait for an extension update with the tab open, or turn the extension off and on in `chrome://extensions` with the tab open. The second way is an assumption: COM-284 saw the break only after an automatic update. | The panel shows "Your wallet extension stopped responding, which can happen after it updates. Reload the page and reconnect your wallet before you continue." (`useWrappedAction.ts:52-53`). A reload fixes it (COM-284). Record the console's error text. Only messages that match `src/helpers/walletErrors.ts:33` count as a broken extension.                                                                                                                                           |
| S9  | Wallet switching with a second unlocked wallet      | After the last signing row, unlock Rabby or install MetaMask in the same profile. COM-284 found Rabby installed and locked. With a review open, use "Change Wallet" to connect it, then switch back to Anchorage.   | With the second wallet: no wrapped panel, the direct Supply button returns, an open wrapped review closes and the action queue empties. The route keys on the selected connector's id alone (`src/helpers/lendingRoute.ts:175`). Back on Anchorage: the panel returns after the wrapper check, and no earlier review returns.                                                                                                                                                               |
| S10 | Stale state                                         | With a review open, select another market.                                                                                                                                                                          | The review closes, and a confirm kept from it signs nothing. After each confirmed step, the panel's figures read again from a block that holds the step.                                                                                                                                                                                                                                                                                                                                    |
| S11 | Anchorage-only holder visibility                    | While the test wallet holds shares, open the watch-only view of its address (S12).                                                                                                                                  | The view shows no wrapped position, because COM-285 limits it to the Anchorage route. A second wallet holds another address, and S9 checks its route. Record what the view shows.                                                                                                                                                                                                                                                                                                           |
| S12 | Watch-only session                                  | Open `<local URL>/?account=<test wallet address>`.                                                                                                                                                                  | The standard route: no wrapped panel and no write control (`src/contexts/Web3Context.tsx:155-163`). The direct figures match the connected view. Transaction history shows the watched account's history, a COM-291 capture.                                                                                                                                                                                                                                                                |
| S13 | Pending recovery without stale submission           | Right after an exit's broadcast, before it is mined, try to open a new wrapped review.                                                                                                                              | The controls refuse it with "Waiting for this account's earlier wrapped transactions to be checked and to settle."                                                                                                                                                                                                                                                                                                                                                                          |

The console snippet for S7 asks the Anchorage provider directly. It requests the EIP-6963 announcements again. EIP-6963 asks a wallet to keep its uuid for the page's lifetime, and the app's conflict check ignores a repeated announcement with the same uuid (`src/helpers/eip6963Security.ts:66-77`).

```js
const anchorage = await new Promise((resolve) => {
  window.addEventListener('eip6963:announceProvider', (event) => {
    if (event.detail.info.rdns === 'com.anchorage.connect') resolve(event.detail.provider);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
});
await anchorage.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1388' }] });
// Afterwards: await anchorage.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
```

## Checks that COM-286 left for a real session

| ID  | Check                                 | How to record it                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | The `chainId` field                   | The app sends `chainId` in `eth_estimateGas` and `eth_sendTransaction` (`src/hooks/useWrappedAction.ts:360-377`). Record whether the first wrapper request reaches mobile. If the wallet refuses it, record the error text.                                                             |
| F2  | The gas limit of 120% of the estimate | The app sends a `gasLimit` of 120% of the wallet's own estimate (`useWrappedAction.ts:369`, `:376` and `:380`). Record each transaction's gas limit and gas used from the explorer, and whether Porto kept the app's limit. On the fork, the limits were 1.4 to 1.5 times the gas used. |
| F3  | Approval after a `-32603`             | Record this only if a wrapper request returns `-32603` during the run: does the request still appear on mobile, and does approving it there broadcast it? Do not cause a `-32603` with a request outside the authorization. Otherwise record "not exercised".                           |
| F4  | The sender of each transaction        | Record each transaction's `from` and nonce from the explorer. Expected: `from` is the test wallet. #64 lists this as a check on a real session.                                                                                                                                         |
| F5  | Porto's display of the wrapper calls  | Record how Porto shows the exact approval, the USDT reset, `supplyAndWrap`, and `unwrapAndWithdraw` with its 18-decimal shares (COM-287 and COM-288 follow-ups). Record any review that stopped because the market's provider did not catch up within 30 s.                             |

## Telling the states apart

A bare `-32603`, or any generic internal error, proves neither success nor rejection. COM-284 saw requests that Anchorage's backend turned down reach the dApp as a bare `-32603`. Before you record success or rejection, check mobile and the explorer.

The Anchorage Digital extension 1.1.16 does not wait for a mobile approval indefinitely. On 2026-10-23 it rejected an exact USDC approval's `eth_sendTransaction` about 4 minutes 47 seconds after the request. Its answer was `-32005` and "This request is still pending and can still complete after this message. Check its status in the Anchorage extension before you try again." The request stayed open in the extension and on mobile. Approving it there still broadcasts the transaction, but the page never receives its hash.

The app classifies this answer as `pending-in-wallet` and handles it as a provider failure (`src/helpers/walletErrors.ts:73-79` and `:85-95`). It keeps the request as interrupted (`src/hooks/useTransactionManager.ts:582-603`) and stops the step with no retry and no next step (`src/hooks/useWrappedAction.ts:773-779`). The dialog shows the text of the "Still open in the wallet" row (`WrappedActionDialog.tsx:69-78`). The panel says "Your wallet reported that it still has a request open for an earlier wrapped transaction from this account." and offers "Stop waiting" (`WrappedPositionPanel.tsx:600-621`). After `-32005`, check mobile and the extension before any retry. A later approval lands as a transaction the app did not see, so the next review reads the new allowance and balances.

The extension can also refuse a request before it handles it. On 2026-10-26 the user had logged into the extension again, and the page still showed the account connected. About 5 seconds after Confirm, the extension answered an exact USDC approval's `eth_sendTransaction` with EIP-1193 code `4100` "Unauthorized". The new login had dropped the tab's session in the extension. Nothing was created on the wallet side, nothing reached mobile, and the chain showed no transaction.

The app classifies EIP-1193 codes `4100` (Unauthorized), `4200` (Unsupported Method), `4900` (Disconnected) and `4901` (Chain Disconnected) as `refused` (`src/helpers/walletErrors.ts:18-24`, `:81-83` and `:91-93`). It removes the request's record, as for a rejection (`src/hooks/useTransactionManager.ts:587-591`). It stops the step with nothing sent and no next step, and a new review can start at once (`src/hooks/useWrappedAction.ts:765-768`).

The dialog shows the text of the "Refused before the wallet handled it" row (`WrappedActionDialog.tsx:110-111`). Until the next review starts, the panel says "Your wallet refused the last wrapped request from this account before handling it (…)" (`WrappedPositionPanel.tsx:623-630`). Disconnect and reconnect the wallet in the dApp before that review. Otherwise its request can fail the same way.

| State                                | Dialog text                                                                                                                                                                                  | Dialog button             | Wallet menu                                                            | Independent check                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| Awaiting mobile approval             | "Confirm the request in your wallet. Approval on a mobile device can take a few minutes."                                                                                                    | "Waiting for Your Wallet" | "1 Pending", and no row under Pending, because the request has no hash | Mobile shows the request. Nonce unchanged                 |
| Broadcast                            | "Broadcast. Waiting for the network to confirm it." and "View on Explorer"                                                                                                                   | "Waiting for the Network" | "1 Pending", and a row under Pending with the step's description       | The explorer shows the hash                               |
| Confirmed                            | "Confirmed."                                                                                                                                                                                 |                           | The row leaves Pending                                                 | Receipt status 1                                          |
| Rejected                             | "You rejected the request in your wallet. Nothing was sent."                                                                                                                                 |                           | Nothing pending                                                        | Nonce unchanged                                           |
| Refused before the wallet handled it | "Your wallet refused this request before handling it (…), so nothing was sent. Disconnect and reconnect your wallet on this page, then start a new review." (`4100`, `4200`, `4900`, `4901`) |                           | Nothing pending                                                        | Nonce unchanged. Mobile and the extension show no request |
| Provider failure                     | "Your wallet reported an error (…). The request may still go through, so check your wallet before you try again."                                                                            |                           | Counted as pending until "Stop waiting" on the panel                   | Mobile, the explorer and the nonce                        |
| Still open in the wallet             | "Your wallet still has this request open. Approve or reject it in the Anchorage app on your phone. …" (`-32005`)                                                                             |                           | Counted as pending until "Stop waiting" on the panel                   | Mobile and the extension show the request                 |
| Stopped before the wallet            | "Stopped before your wallet was asked, so nothing was sent: …"                                                                                                                               |                           | Nothing pending                                                        | Nonce unchanged                                           |
| Reverted                             | "This transaction failed on chain."                                                                                                                                                          |                           | The row leaves Pending                                                 | Receipt status 0                                          |
| Replaced or dropped                  | "This transaction was replaced or dropped: the network used its nonce for another transaction."                                                                                              |                           | The row leaves Pending                                                 | Another transaction holds the nonce                       |
| Unresolved                           | "This transaction was sent, but this page can no longer follow it. Check it on the explorer."                                                                                                |                           | Its row stays under Pending until the page reads its receipt           | The explorer                                              |

The texts come from `src/pages/home/components/ActionModal/WrappedActionDialog.tsx:69-133` and the wallet menu from `src/components/WalletButton.tsx:19-35` and `:132-158`.

## Capture for COM-291

Capture each surface at four times:

- right after each wrapped transaction is confirmed
- after a page reload
- after a disconnect and reconnect in the dApp
- in a later session, on another day in a new browser session

The surfaces:

1. the Compound dashboard: the wrapped panel and the direct position card
2. the wallet menu: the "N Pending" button and its Pending list
3. the wallet menu: Recent Transactions
4. the Transactions page, `/transactions`
5. Porto mobile activity
6. the Porto extension: its popup and its notifications
7. the block explorer

For each sample, record these fields. Read the chain fields from the explorer's logs or from `cast receipt <hash> --json`. [`anchorage-history-decision.md`](anchorage-history-decision.md#what-a-wrapped-supply-and-exit-emit-on-chain) lists the logs each kind of transaction emits.

| Field                                | How to read it                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| Sample ID, market and kind           | for example "S-USDC-2, USDC, partial exit"                                                   |
| Chain and transaction hash           | the explorer                                                                                 |
| Log index                            | Comet's event that names the wallet, if any, and the wrapper's `Deposit` or `Withdraw` event |
| Wrapper and Comet                    | the transaction's `to`, and the Comet that emitted the event                                 |
| Raw shares                           | the `shares` field of the wrapper's `Deposit` or `Withdraw` event                            |
| Gross Comet assets                   | the `assets` field of the same event: the wrapper's measured Comet credit or debit           |
| Actual base cash                     | the base token's `Transfer` from the wallet, or to it                                        |
| Displayed account, action and amount | per surface, as shown, with a screenshot name                                                |

Store screenshots outside the repository and record their names here.

## Results

Each cell holds "pass", "fail" or "not exercised", with its evidence: a hash, a screenshot name or a note.

| Check                                               | USDC | USDT | Institutional USDC |
| --------------------------------------------------- | ---- | ---- | ------------------ |
| M1 exact approval: spender and amount on mobile     |      |      |                    |
| M1 supply                                           |      |      |                    |
| M6 reset of a nonzero allowance short of the supply | n/a  |      | n/a                |
| M2 balances refreshed in Compound                   |      |      |                    |
| M2 wrapped balance and USD value in Porto           |      |      |                    |
| M3 partial exit                                     |      |      |                    |
| M4 full exit                                        |      |      |                    |
| M5 transaction links                                |      |      |                    |
| Mobile preview fields match the row                 |      |      |                    |

| Scenario or check | Result | Evidence |
| ----------------- | ------ | -------- |
| P1 to P4          |        |          |
| S1                |        |          |
| S2                |        |          |
| S3                |        |          |
| S4                |        |          |
| S5                |        |          |
| S6                |        |          |
| S7                |        |          |
| S8                |        |          |
| S9                |        |          |
| S10               |        |          |
| S11               |        |          |
| S12               |        |          |
| S13               |        |          |
| F1                |        |          |
| F2                |        |          |
| F3                |        |          |
| F4                |        |          |
| F5                |        |          |

| Row | Hash | Block | From | Nonce | Gas limit | Gas used | Fee (ETH) | Requested (UTC) | Approved on mobile (UTC) | Broadcast (UTC) | Confirmed (UTC) |
| --- | ---- | ----- | ---- | ----- | --------- | -------- | --------- | --------------- | ------------------------ | --------------- | --------------- |
|     |      |       |      |       |           |          |           |                 |                          |                 |                 |

### Findings for Anchorage

| #   | What Porto showed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | What the chain shows                                                                                                 | Hash | Porto version                                               | Screenshot                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Product observation: the extension's pending timeout is shorter than a realistic custody approval. The Anchorage Digital extension answered an exact USDC approval's `eth_sendTransaction` with `-32005` about 4 minutes 47 seconds after the request, while the request waited for approval on mobile: "This request is still pending and can still complete after this message. Check its status in the Anchorage extension before you try again." The request stayed open in the extension and on mobile. If it is approved later, the dApp never receives the transaction's hash. | No approval at the last reads, 22:33 UTC on 2026-10-23: the allowance was 0 and the balances were unchanged          | None | Extension 1.1.16. The mobile app's version was not recorded | The dialog and panel captures of the 2026-10-23 run, kept outside the repository |
| 2   | Product observation: logging into the Anchorage Digital extension again drops the tab's dApp session, while the page still shows the account connected. The next request, an exact USDC approval's `eth_sendTransaction`, failed about 5 seconds after Confirm with EIP-1193 `4100` "Unauthorized". Nothing was created on the wallet side, and nothing reached mobile. The user must disconnect and reconnect the wallet in the dApp before the next request.                                                                                                                        | No transaction at the last reads, 16:26 UTC on 2026-10-26: the nonce, the allowances and the balances were unchanged | None | Not recorded                                                | The dialog and panel captures of the 2026-10-26 run, kept outside the repository |
|     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |                                                                                                                      |      |                                                             |                                                                                  |

### Release-blocking failures

Link each failure to a scoped fix and a regression test. Then run the failure's rows again on the real wallet, before COM-290 is accepted. Record the commit of the accepted run: COM-292 compares it with the release commit.

| #   | Failure | Fix (PR) | Regression test | Status |
| --- | ------- | -------- | --------------- | ------ |
|     |         |          |                 |        |

### Product limitations

The PRs below this one already record these limitations. The run confirms, corrects or extends the list:

- `unwrapAndWithdraw` has no minimum amount and no deadline, so the payout can change after the check before the signature (#66).
- A broadcast wrapper transaction that is dropped, and whose nonce is never used again, holds back new wrapped actions with no way out (#64, #65).
- A second tab does not see the wrapper transactions of the first (#64).
- The Extensions page can send any transaction for an Anchorage session. #64 asks to close that path before wrapped deposits are released.
- A USDT supply over a nonzero allowance needs three mobile approvals (#65).
- The wallet button counts an interrupted request as "1 Pending" on every page. Only the wrapped panel of its own market offers "Stop waiting" (#64).
- Transaction history is expected to leave out wrapped deposits and to show wrapped exits as ordinary withdrawals ([COM-291](anchorage-history-decision.md)).

## Cases this run cannot exercise

Record each of these as "not exercised" on the real wallet, with the coverage named here. Do not mark a real-wallet cell as passed from fork or mock evidence.

- **A replaced or dropped transaction.** Porto sets the nonce and the fees, and the app has no speed-up or cancel action (COM-284). Coverage: the `useTransactionManager` and `useWrappedAction` unit suites (#64) and the outcome tests of `useWriteWrappedState` (#65).
- **A revert.** The app simulates each supply and exit before the signature, so an authorized request is unlikely to revert. Coverage: the COM-289 fork scenarios `excessive-debit`, `pause` and `insufficient-liquidity`, and the unit tests of the reverted state.
- **A pause or a lack of liquidity.** A test cannot cause either on mainnet. Coverage: the same fork scenarios.
- **A dropped broadcast transaction with no way out.** It is an open follow-up of #64 and #65, with no fix to test.
- **Check F3,** unless a `-32603` happens during the run.

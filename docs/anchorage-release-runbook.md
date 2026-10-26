# Anchorage wrapped lending: release runbook (COM-292)

Release status on 2026-10-22: not approved and not scheduled. No launch date is assumed. The committed configuration keeps wrapped deposits and exits off on all three markets.

This runbook takes the release from that state in reviewed steps. Stage 0 is the first production release that contains the code. Stage 1 opens exits with deposits off. Stage 2 opens deposits after the signoffs. Stages 1 and 2 and the rollbacks R1 and R2 each change only the two release controls in `src/constants/wrappedMarkets.ts`, each in its own reviewed PR. Stage 0 releases the code itself, and R3 reverts it or releases an earlier build. Every release goes through the existing IPFS build and release workflows, with no workflow or credential change. Nothing in this runbook approves a release or a real-value transaction.

## What the release controls change, and what they never change

Facts from code:

- **Only the Anchorage connector takes the wrapped route.** The route is wrapped only for the selected connector `com.anchorage.connect` on the three configured markets (`src/helpers/lendingRoute.ts:165-210`). Other wallets and watch-only sessions stay on the standard route under every setting of the controls. The rehearsal tests pin this (see [Rollback rehearsal](#rollback-rehearsal)).
- **The controls are per market and independent.** `isDepositEnabled` gates the route's `deposit`, and `isExitEnabled` gates its `exit`. Reads depend on neither (`lendingRoute.ts:206-208`).
- **The wrapped route refuses a direct base supply whatever the controls say.** The home page blocks it whenever the route is wrapped (`src/pages/home/index.tsx:104-105` and `:426`). Borrow, a repay up to the debt, collateral and the direct withdrawal stay available (#61).
- **No wrapper failure falls back to Comet.** `checkWrappedStep` allows a wrapped step only as the base token's `approve` to the wrapper, or the wrapper's `supplyAndWrap` or `unwrapAndWithdraw`, with targets from the route (`src/helpers/wrappedActions.ts:348`, #64).

So the first production release that contains this stack changes Anchorage sessions on the three markets, even with both controls off. Their home page offers no direct base supply, and no wrapped supply in its place. The Extensions page can still send any transaction for an Anchorage session (#64).

Do not merge the stack to `main` before Adam and Leo sign off Stage 0. The merge puts the stack into the next production release, whoever runs that release. Without a `cid` input, "Release Production" releases the newest successful `main` build (`.github/workflows/release-prod.yaml:41-49`).

| Setting               | `isDepositEnabled` | `isExitEnabled` | Anchorage session on the market                                    | Other wallets and watch-only |
| --------------------- | ------------------ | --------------- | ------------------------------------------------------------------ | ---------------------------- |
| Stage 0, as committed | `false`            | `false`         | Holdings shown. No wrapped supply or exit. No direct base supply.  | unchanged                    |
| Stage 1               | `false`            | `true`          | Holdings shown and exits open                                      | unchanged                    |
| Stage 2               | `true`             | `true`          | Holdings shown, supply and exits open                              | unchanged                    |
| Rollback R1           | `false`            | `true`          | the same as Stage 1                                                | unchanged                    |
| Rollback R2           | `false`            | `false`         | the same as Stage 0. Holders exit [directly](#direct-wrapper-exit) | unchanged                    |

Do not ship deposits on with exits off. Otherwise holders can enter through the app but cannot leave through it. The registry accepts that combination (`src/constants/wrappedMarkets.ts:157`), so the review of each release-control PR must refuse it.

| Market             | Comet                                        | Wrapper                                      | Base token                                        |
| ------------------ | -------------------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| USDC               | `0xc3d688B66703497DAA19211EEdff47f25384cdc3` | `0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73` | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| USDT               | `0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840` | `0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf` | USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| Institutional USDC | `0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C` | `0xc7Eb9aA5B9ae154C1bAb08872E90fC44e522E463` | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |

The factory is `0xf77f675a383eB43fa032ea3c6d1dd4dC56B69BF6` on Ethereum mainnet (chain ID 1). [`anchorage-wrapper-registry.md`](anchorage-wrapper-registry.md) records the evidence for every address.

The commands below read the RPC URL from `ETH_RPC_URL`. Set it once with `read -rs ETH_RPC_URL && export ETH_RPC_URL` and paste the URL at the prompt. Then the URL stays out of the shell history, and an RPC key in it stays private.

## Owners and signoff

| Role or decision                         | Name | Date and link |
| ---------------------------------------- | ---- | ------------- |
| Release owner                            |      |               |
| Adam's signoff, per stage                |      |               |
| Leo's signoff, per stage                 |      |               |
| Agreed timing, per stage                 |      |               |
| Two approvals on each release-control PR |      |               |

A readiness review does not approve a launch or a real-value transaction. Record Adam's and Leo's signoff before each stage's release, Stage 0 included, and before each change of a control.

## Preflight

Close every item before Stage 1, except those marked for Stage 2. Items 1 and 10 also come before Stage 0.

1. **Protect the release path, or accept the risk in writing.** These are facts from 2026-10-22, read with the commands below. `main` has no branch protection and no ruleset. The `production` environment has no protection rule and no deployment branch policy. `.github/CODEOWNERS` names no owner for its security-sensitive paths. So nothing enforces the two approvals: anyone with write access can put a control change on `main`. The deployer's Seacrest signature in "Release Production" is the one enforced gate (`scripts/release.js:65-68`). Before Stage 0, do one of these:

   - Protect `main`: require two approvals, dismiss stale approvals, and require code-owner review, with named owners for `src/constants/`. Make the `production` environment require a reviewer and deploy from `main` only.
   - Record Adam's and Leo's explicit acceptance of the unprotected path.

   ```bash
   gh api repos/Compound-Foundation/webb3-frontend/branches/main/protection
   gh api repos/Compound-Foundation/webb3-frontend/rulesets
   gh api repos/Compound-Foundation/webb3-frontend/environments --jq '.environments[] | {name, protection_rules, deployment_branch_policy}'
   ```

2. **Reconcile the registry's release checks** ([`anchorage-wrapper-registry.md`](anchorage-wrapper-registry.md#unresolved-release-checks)):

   - Check 1, the post-audit changes `f0dcf4a...1152de2` to `previewDeposit`, `previewMint` and `previewRedeem`: a reviewer's sign-off, or an explicit risk acceptance that names who accepts it.
   - Check 2, the runtime reproduction: COM-289 reproduced each runtime from the `1152de2` build input (#67). The release owner records whether that closes the check.
   - Check 3, the factory owner: record the owner, its signers and threshold, and who controls the signers:

     ```bash
     OWNER=$(cast call 0xf77f675a383eB43fa032ea3c6d1dd4dC56B69BF6 "owner()(address)")
     cast call "$OWNER" "getOwners()(address[])"
     cast call "$OWNER" "getThreshold()(uint256)"
     ```

   - Check 4, fresh reads: repeat the registry's [on-chain reads](anchorage-wrapper-registry.md#on-chain-reads) at a fresh block on the release day. Read each Comet's pause flags and its implementation too, from the EIP-1967 implementation slot:

     ```bash
     FACTORY=0xf77f675a383eB43fa032ea3c6d1dd4dC56B69BF6
     for PAIR in 0xc3d688B66703497DAA19211EEdff47f25384cdc3:0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73 \
                 0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840:0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf \
                 0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C:0xc7Eb9aA5B9ae154C1bAb08872E90fC44e522E463; do
       COMET=${PAIR%%:*}
       WRAPPER=${PAIR##*:}
       BASE=$(cast call "$COMET" "baseToken()(address)")
       echo "Comet $COMET, wrapper $WRAPPER, base token $BASE"
       cast call "$FACTORY" "getWrapper(address)(address)" "$COMET"   # expect $WRAPPER
       cast call "$WRAPPER" "asset()(address)"                        # expect $COMET
       cast call "$WRAPPER" "decimals()(uint8)"                       # expect 18
       cast call "$COMET" "decimals()(uint8)"                         # expect 6
       cast call "$BASE" "decimals()(uint8)"                          # expect 6
       cast keccak "$(cast code "$WRAPPER")"                          # expect the registry's code hash
       cast call "$COMET" "isSupplyPaused()(bool)"
       cast call "$COMET" "isWithdrawPaused()(bool)"
       cast call "$COMET" "isTransferPaused()(bool)"
       cast storage "$COMET" 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
     done
     ```

     Stop every stage if a read differs from the market table or the registry: another wrapper, asset, base token, decimals or code hash. `isWithdrawPaused() == true` on a market blocks Stage 1 there, and `isSupplyPaused() == true` blocks Stage 2 there. Record each implementation address. On 2026-10-22 they were `0x63e749153baf1838f63ca22c275370bd2b1ceb15` (USDC), `0xabc1195c5d34ddebc36885a980a3009bb6f6db9e` (USDT) and `0x3e0ba1b3a97ba7f97002a20c243d7c1cec34c4e5` (institutional USDC). Then run the fork suite at a recent block on the release commit, and record its summary:

     ```bash
     node scripts/test-wrapped-lending-fork.js --block recent --solc-output <solc output>
     ```

   - Check 5, the transaction paths: the fork part passed (COM-289). The Porto part is COM-290's per-market acceptance. COM-290's runs of 2026-10-26 cover USDC, and institutional USDC except its partial exit. USDT is not run, and COM-290 has not accepted the runs ([results](anchorage-porto-validation.md#results)).
   - Check 6, the rollout decision: this runbook, with the signoffs above.

   The registry keeps both controls off until each closure is recorded in it (`docs/anchorage-wrapper-registry.md`, its introduction and "Unresolved release checks"). Record each closure under its check there, in a docs PR merged before Stage 1.

3. **Record COM-290's acceptance** for each market to open ([`anchorage-porto-validation.md`](anchorage-porto-validation.md)). Record the commit the run accepted. Then list the wrapped code that changed between that commit and the release commit:

   ```bash
   git diff --stat <accepted commit> <release commit> -- src/App.tsx src/constants src/contexts src/helpers src/hooks src/pages/home
   ```

   Run the affected COM-290 rows again on the real wallet for any change other than the control lines.

4. **Record COM-291's Product decision** ([`anchorage-history-decision.md`](anchorage-history-decision.md#decision)). Deliver and verify any history work that the decision requires before the stage it blocks.
5. **Answer or accept the open product questions:**
   - the wallet-network boundary of the standard queue (#64)
   - the 0.1% (10 basis points) tolerance for a partial exit's payout (#66, #67)
   - an acknowledgment of the debt warning before the first signature (#65)
   - a dialog closed in the middle of a supply, which stops the supply (#65). While a step is checked, waits in the wallet or waits for the network, only the close control and the Close button close the dialog. A click on the backdrop then does nothing (#65, #66, [COM-290 failure 1](anchorage-porto-validation.md#release-blocking-failures)). M1 on USDC ran again on `8e7d022` and passed
   - up to three mobile approvals for a USDT supply (#65)
   - the Anchorage extension's pending timeout of about 4 minutes 47 seconds, shorter than a realistic custody approval. A request approved after the timeout lands as a transaction the app does not see, and new wrapped actions wait until the holder presses "Stop waiting" (#64, [COM-290 finding 1](anchorage-porto-validation.md#findings-for-anchorage)). Read from the source of extension 1.1.16, the extension also stops waiting, with `4900` "… The request can still complete …", when the holder disconnects the wallet in the interface while a request waits. The app handles that answer the same way (#64, [Telling the states apart](anchorage-porto-validation.md#telling-the-states-apart))
   - the Anchorage extension's `4100` "Unauthorized" after a new login. On 2026-10-26 the page still showed the account connected, and the next request failed with `4100`. The chain showed no transaction. Read from the source of extension 1.1.16, the extension answers `4100` when the tab's session in the extension holds no wallet. That the new login dropped the session is inferred. The app classifies `4100` as a refusal, so its dialog and panel say that nothing was sent. Disconnecting and reconnecting the wallet is the recommended recovery, which the run did not verify (#64, [COM-290 finding 2](anchorage-porto-validation.md#findings-for-anchorage))
   - the Anchorage extension's late hash. In the runs of 2026-10-26, the dialog still said "Waiting for Your Wallet" after the transaction was in a block. The hash first appeared 24 to 43 seconds after the block, and no read of the dialog showed the Broadcast state. Read from the source of extension 1.1.16, the extension returns a transaction's hash only after Anchorage's backend marks the operation complete ([COM-290 finding 3](anchorage-porto-validation.md#findings-for-anchorage))
   - the Anchorage extension's asset list, which shows no wrapper share token. The extension gives a holder no view of the wrapped position ([COM-290 finding 4](anchorage-porto-validation.md#findings-for-anchorage))
   - routing the wrapped dialogs and the panel to the security review in CODEOWNERS (#66)
   - a contract variant whose exit takes a minimum amount or a deadline (#66), which is out of this release's scope
6. **For Stage 2: close the Extensions page's path.** #64 asks to stop the Extensions page's direct `eth_sendTransaction` for Anchorage sessions before wrapped deposits are released.
7. **For Stage 2: decide on a dropped broadcast transaction.** #64 and #65 leave no way out for a broadcast wrapper transaction that is dropped and whose nonce is never used again. Fix it, or accept it as a limitation.
8. **For Stage 2, and preferably for Stage 1: verify a direct exit for a custody account.** Every position that the app opens belongs to an Anchorage custody account, because only the Anchorage connector takes the wrapped route. `cast` cannot sign for such an account. With a small authorized position, send `unwrapAndWithdraw(shares)` from an Anchorage account through an interface other than this app, as in [Direct wrapper exit](#direct-wrapper-exit). Record the interface and the transaction. Until this passes, R2 and R3 leave app-made holders with no verified way out.
9. **For Stage 2: exercise an exit through the production app in Stage 1.** An authorized Anchorage account must hold shares for it, for example a small position that the COM-290 run leaves on one market on purpose. Decide that in COM-290's authorization.
10. **Merge the stack after the Stage 0 signoff:** #60, #61, #64, #65, #66, #67 and this PR, each after its review. Before the first merge, record the CID and the commit that production serves: R3b releases that CID. Until Stage 0 ships, pin every production release's `cid` to that CID, because each merge builds a `main` that holds part of the stack. Merge the seven PRs in one sitting to keep that window short.

The exit-specific safety checks that Stage 1 needs are items 1 to 5 for exits, and these:

- COM-290's partial and full exits passed on each market to open.
- The fork suite at a recent block passed every exit scenario: `partial-exit*`, `full-exit`, `dust`, `pause`, `insufficient-liquidity`, `excessive-debit`, `estimate-rose` and `stale-state`.
- No exit-blocking failure is open.

## Ship a release-control change

Stages 1 and 2, R1 and R2 are each one PR that changes only the release controls of the markets it names. Each release also ships everything else that `main` holds and production does not. Steps 6 and 7 check that.

1. Open the PR from a branch of this repository. Change only `isDepositEnabled` or `isExitEnabled` lines in `src/constants/wrappedMarkets.ts`, the comment above them that says the release checks keep both controls off (`:75-79`), and the tests that pin the committed controls ([list](#tests-that-pin-the-committed-controls)). Never set deposits on with exits off.
2. Get two approvals. If preflight item 1 accepted the risk instead of protecting `main`, nothing enforces this, so the person who merges checks it.
3. Run `npx tsc`, `yarn lint`, `yarn test` and `yarn build` on the PR's head. CI runs the types, the lint and the build. CI does not run `yarn test` (AGENTS.md).
4. Before you merge, check the PR for commits pushed after the approvals. The PR-agent service can push to a PR branch after its review (AGENTS.md). If a commit arrived, review it and approve again.
5. Merge the PR to `main`, and record the merge commit.
6. Find the commit that production serves: the last release record's commit, or the `build.yaml` run whose CID production released. Compare it with the merge commit:

   ```bash
   git diff --stat <production commit> <merge commit>
   ```

7. If the diff holds anything but the control lines and their tests, stop, and agree with the release owner whether to ship it. For an urgent R1, release only the control change instead:
   - Cut a branch from the production commit.
   - Apply the reviewed control change.
   - Push the branch, then repeat step 6 against its head.
8. Wait for `build.yaml` on the commit to release. Record its run, its head SHA and its CID. The "Echo" step prints the CID, and the `.release` artifact holds it (`.github/workflows/build.yaml:55-74`). Check that the head SHA is the commit to release.
9. Dispatch "Release Production" from `main`, with the `cid` input set to that CID. Without the input, the workflow releases the newest successful `main` build, which can be another commit (`release-prod.yaml:41-49`). Seacrest asks the deployer's wallet to sign the payload `{cid, timestamp, deployer}` (`release-prod.yaml:51-56`, `scripts/release.js:55-71`). The deployer compares the payload's CID with the recorded CID before signing, and refuses a mismatch.
10. Check the release run's log. Its `Release payload=` line and its `Successfully released:` line must both carry the recorded CID (`scripts/release.js:12` and `:31`). Record the run, the timestamp and the deployer address.
11. Run the [verification](#verify-after-each-release) for the stage.

Every push to a branch of this repository publishes that branch's build to IPFS (`build.yaml:1-2` and `:55-62`). So a release-control PR's preview CID serves the new controls before the PR merges. Open such a PR only when its stage is approved. Fork PRs build without the publishing credentials, and that separation must hold.

## Stages

### Stage 0: the first release with the stack

Preconditions: preflight items 1 and 10, and Adam's and Leo's signoff of Stage 0 and its timing.

The controls are as committed: both off on every market. Release the stack's merge commit with steps 8 to 11 of [Ship a release-control change](#ship-a-release-control-change). Verify the [standard checks](#verify-after-each-release), and check the Anchorage session on each market:

- The wrapped panel shows the holdings.
- The supply control reads "Wrapped deposits are not open yet.", and the withdraw control "Wrapped withdrawals are not open yet." (`src/pages/home/components/WrappedPositionPanel.tsx:97-99`).
- The direct Supply button is absent.

### Stage 1: exits on, deposits off

Preconditions: the preflight items for exits and the exit-specific safety checks.

Change: `isExitEnabled: true` on each market to open. `isDepositEnabled` stays `false`.

Verify the standard checks, and on each opened market:

- The panel shows the holdings, and the supply control still reads "Wrapped deposits are not open yet.".
- The withdraw control opens its form for a position worth more than the buffer.
- The authorized holder's exit through the production app completes (preflight item 9). Without it, Stage 2 waits.

### Stage 2: deposits on

Preconditions: every preflight item, the Stage 1 exit, Adam's and Leo's signoff, and the agreed timing.

Change: `isDepositEnabled: true` on each market to open.

Verify the standard checks, and on each opened market:

- The supply control opens its form.
- An authorized small supply and its full exit complete. Each is a real-value transaction that needs authorization, as in COM-290.

## Verify after each release

Check the three wrapped markets as each stage describes, and these standard-market regressions:

1. Another wallet on each of the three markets: direct supply, withdraw, borrow and repay work as before.
2. Anchorage on a market without a wrapper: the standard route, with direct actions as before.
3. A watch-only `?account=` view: read-only, with no write control.
4. Screening: a deployed build screens each connected address and fails closed. An unscreened or blocked address reaches no signing flow.
5. Recent Transactions and the Transactions page load.
6. The direct Supply button stays absent for Anchorage on the three markets, at every stage.

## Stop conditions

If any of these happens, stop the rollout, record it, and decide on [R1](#r1-deposit-disable-rollback) or [R2](#r2-exits-off-as-well):

- A wrapped transaction from the app pays or burns other amounts than its dialog showed, beyond the bounds in [`anchorage-wrapper-verification.md`](anchorage-wrapper-verification.md).
- A wrapped request targets a contract other than the market's base token or wrapper, or calls another function.
- A fresh read finds another wrapper, asset, decimals or pause state than the registry records.
- A Comet's implementation address differs from the one recorded at check 4. The fork evidence covers the recorded implementation only.
- A build with the release controls open is published outside an approved stage, for example from a pushed branch.
- A screening, session or identity check lets through a write that it must refuse.
- Porto misstates a wrapped request's amount, spender or target.
- A holder reports an exit that is lost or stuck, until it is understood.
- A standard-market regression appears.

## Rollback

### Contract safety checks are not the rollback

The rollback changes release controls only. These checks can still block an exit at every setting, and the rollback does not and must not turn them off:

- the wrapper check: a mapping, asset or decimals mismatch disables the route's reads, deposits and exits (`validateWrappedMarket`, #60)
- screening: an address that screening has not allowed cannot write (`lendingRoute.ts:127`)
- Comet's withdraw pause: the app stops an exit before the signature, and the chain reverts it with `Paused()`
- liquidity: the app refuses an exit above Comet's cash, and the chain reverts it
- dust: shares worth no more than the buffer revert with `ZeroAssetsTransferred()`
- an excessive debit: the chain reverts with `ExcessiveAssetsDebited(uint256,uint256)`

### R1: deposit-disable rollback

Use R1 for a fault in deposits, or for any stop condition that leaves exits safe.

Change: one PR that sets `isDepositEnabled: false` on the affected markets and leaves `isExitEnabled: true`. Ship it as in [Ship a release-control change](#ship-a-release-control-change), through a release branch if `main` holds other unreleased work.

What R1 changes: the route's `deposit` becomes `deposits-disabled`, so the supply control reads "Wrapped deposits are not open yet.".

What R1 must not change, each pinned by a [rehearsal test](#rollback-rehearsal) unless noted:

- the wrapper identity: the mapping's wrapper, base token and units, and the validation key
- the holdings reads: `reads` stays eligible
- the exits: `exit` stays eligible, and the lifecycle still reviews and signs a withdrawal
- the refusal of a direct-Comet fallback: the route stays wrapped, and the home page refuses a direct base supply on a wrapped route (#61's `wrappedRouteWiring` tests)
- other wallets and watch-only sessions: they stay on the standard route
- the safety checks: a screening, network, wrapper-check or mapping failure still closes exits

Limits of R1:

- A tab keeps the build it loaded until it reloads. An open tab of the earlier release can still supply until then.
- Every build stays reachable by its CID on two gateways, Pinata's and `ipfs.io`. Each gateway serves every CID from one origin (`scripts/ipfs.js:62-63`). If the screening service allows the gateway's origin, a deposit-open build stays usable there after R1. Record whether it does. Ask the Pinata account's owner to unpin each deposit-open CID: every Stage 2 build and the preview builds of its PRs. Unpinning does not remove the copies that other IPFS nodes keep.
- The wrappers are public contracts. R1 closes the app's supply path, not `supplyAndWrap` itself.

### R2: exits off as well

Use R2 only for a fault in exits, such as an exit that pays other than its quote. It sets both controls to `false`. Holders then have no exit in the app. Tell them through Anchorage (Leo) how to [exit directly](#direct-wrapper-exit), with the custody path that preflight item 8 verified.

### R3: full-frontend rollback

Choose one of two forms:

- **R3a: revert the stack on `main`** in a reviewed PR, and release that build. Later fixes on `main` stay.
- **R3b: release the pre-stack CID** that preflight item 10 recorded. "Release Production" accepts any CID as its `cid` input. This also removes every change merged after that CID's commit, fixes included. List them first with `git log --oneline <that CID's commit>..<production commit>`.

Expected from code, as nobody has run R3: the app then knows no wrapper, so it shows no wrapped position and offers no wrapped exit. Anchorage sessions get the standard route back, the direct base supply included. Holders exit directly, with the custody path that preflight item 8 verified.

### Direct wrapper exit

The full-frontend-rollback exit is `unwrapAndWithdraw(balanceOf(account))` on the account's wrapper, on Ethereum mainnet. `unwrapAndWithdraw(shares)` burns exactly `shares` from the caller and pays the caller `floor(shares × (totalAssets + 1) ÷ (totalSupply + 10^12)) − (floor(baseSupplyIndex ÷ 10^15) + 2)` base units on these 6-decimal markets (`WrappedCometERC4626.sol:628-648` and `:1015-1017`).

Limitations:

- **Chain:** the wrappers exist only on Ethereum mainnet, chain ID 1.
- **Signing:** `cast send` signs with a local key, a keystore, a Ledger or a Trezor. It cannot sign for an Anchorage custody account, which signs through Porto. A custody holder needs an interface that connects to the Anchorage extension and sends the exact call data of step 6. Preflight item 8 verifies one. COM-284 saw the mobile app show raw amounts, so expect it to show the shares as a raw 18-decimal integer.
- **Keys:** do not pass `--private-key` on the command line. The shell history and the process list keep it. Use `--ledger`, `--trezor`, `--account <keystore>` or `--interactive`.
- **Dust:** shares worth no more than the buffer cannot leave this way. The call reverts with `ZeroAssetsTransferred()`, selector `0xba4c7afc` (`WrappedCometERC4626.sol:639-641`).
- **Pause:** while Comet's withdrawals are paused, the call reverts with Comet's `Paused()`, selector `0x9e87fac8`.
- **Liquidity:** when Comet holds less base token than the payout, the call reverts. On the fork, USDC reverted with "ERC20: transfer amount exceeds balance" and USDT without data.
- **Excessive debit:** the call reverts with `ExcessiveAssetsDebited(uint256,uint256)`, selector `0x79a1ccf6`, when Comet's accrual makes the debit exceed the shares. On the fork the revert depended on the block's timestamp, and in a later block the same shares paid.
- **Fees:** the holder pays the gas, and a reverted call costs gas too. On the fork a partial exit used 135,844 to 139,769 gas. The wrapper also holds back the buffer on every exit.
- **No minimum amount and no deadline:** the wrapper computes the payout when the transaction runs. A long custody approval lets the market move, so the payout can differ from the simulation, or the call can revert.
- **Pending timeout:** the Anchorage extension answers `-32005` about 4 minutes 47 seconds after a request that waits for approval on mobile, and says that the request can still complete. Read from the source of extension 1.1.16, it answers `4900` "… The request can still complete …" when the interface's tab closes, or the interface disconnects the wallet, while a request waits. Check mobile and the extension before you send the call again. Otherwise both requests can be approved, and the second exit reverts and still costs gas.
- **Session after a new login:** after the holder logs into the Anchorage extension again, a request can fail with `4100` "Unauthorized" while the interface still shows the account connected. COM-290 saw this once, and the chain showed no transaction ([finding 2](anchorage-porto-validation.md#findings-for-anchorage)). Read from the source of extension 1.1.16, the extension answers `4100` when the tab's session in the extension holds no wallet. That the new login empties that session is inferred. Disconnect and reconnect the wallet in the interface, then send the call again.

Steps, from a shell with Foundry's `cast` and `ETH_RPC_URL` set as above:

1. Set the addresses, from the market table above:

   ```bash
   ACCOUNT=<holder address>
   COMET=<the market's Comet>
   WRAPPER=<the market's wrapper>
   BASE=<the market's base token>
   ```

2. Check the chain and the wrapper:

   ```bash
   cast chain-id                                                                                  # expect 1
   cast call 0xf77f675a383eB43fa032ea3c6d1dd4dC56B69BF6 "getWrapper(address)(address)" "$COMET"   # expect $WRAPPER
   cast call "$WRAPPER" "asset()(address)"                                                        # expect $COMET
   ```

3. Read the shares as a plain integer. With a `(uint256)` return type, `cast call` adds a bracketed approximation, which is not a valid argument.

   ```bash
   SHARES=$(cast call "$WRAPPER" "balanceOf(address)" "$ACCOUNT" | cast to-dec)
   echo "$SHARES"
   ```

4. Simulate the exit from the holder. The output is the base units the exit pays at the latest block, or the revert: an error selector, a message or no data.

   ```bash
   cast call "$WRAPPER" "unwrapAndWithdraw(uint256)(uint256)" "$SHARES" --from "$ACCOUNT"
   ```

5. Check the pause and the market's cash against step 4's payout:

   ```bash
   cast call "$COMET" "isWithdrawPaused()(bool)"              # expect false
   cast call "$BASE" "balanceOf(address)(uint256)" "$COMET"   # at least step 4's payout
   ```

6. For a custody signer, encode the call. Send it to `$WRAPPER` with a value of 0. The data starts with the selector `0x7614738f`.

   ```bash
   cast calldata "unwrapAndWithdraw(uint256)" "$SHARES"
   ```

7. For a local signer, sign and send. For a Ledger account other than the first, add `--mnemonic-derivation-path <the account's path>`. Check that the address the Ledger shows is `$ACCOUNT` before you approve.

   ```bash
   cast send "$WRAPPER" "unwrapAndWithdraw(uint256)" "$SHARES" --from "$ACCOUNT" --ledger
   ```

8. Check the result:

   ```bash
   cast receipt <transaction hash> status                           # expect: 1 (success)
   cast call "$WRAPPER" "balanceOf(address)(uint256)" "$ACCOUNT"   # expect 0
   cast call "$BASE" "balanceOf(address)(uint256)" "$ACCOUNT"      # up by the payout
   ```

Another exit, not rehearsed: `redeem(shares, account, account)` moves the shares' value to the holder's own Comet balance through `comet.transfer`, instead of paying the base token (`WrappedCometERC4626.sol:495-518`). It works while withdrawals are paused or Comet's cash is short. It fails while Comet's transfers are paused, because `maxRedeem` is then 0 (`:719-723`). It leaves the holder with a direct Comet position, which pays the base token only through a later direct withdrawal. Product decides whether to offer it.

Rehearsal, as facts from 2026-10-22:

- Steps 2 to 6 and 8 ran on a local anvil fork of block 26244888 for all three markets. In place of step 7, an impersonated holder sent the same call with `cast send --unlocked --async`, and anvil mined it. Each full exit paid exactly step 4's simulation, 999,996 base units, and left 0 shares. A simulated exit of 1 share reverted with `0xba4c7afc`.
- Steps 2 to 6 also ran read-only against mainnet on the USDC wrapper, with the wrapper's seed holder `0x000000000000000000000000000000000000dEaD` as the account. At block 26253426 it held 9,999,999,000,000,000,000 shares, and step 4 simulated a payout of 10,028,959 base units. Nothing was signed or sent.

## Rollback rehearsal

The rehearsal has two parts.

1. **Unit tests, offline.** These tests build the registry from the committed source with only the controls changed, through the real `buildWrappedMarketRegistry`, `resolveLendingRoute` and `useWrappedAction`:

   - `__tests__/helpers/lendingRoute.test.ts` › "rehearses a deposit-disable rollback with registry fixtures". It runs three settings: both controls on, deposits off with exits on, and both off. For each setting and market, it checks the Anchorage route:

     - the route stays wrapped, with the same wrapper identity and validation key
     - reads stay open, and the deposit and the exit follow their own controls
     - other wallets, watch-only sessions and markets without a wrapper stay on the standard route

     Under the rollback, it checks that a screening, wrapper-check or mapping failure still closes exits.

   - `__tests__/hooks/useWrappedAction.test.tsx` › "keeps withdrawals open when a deposit-disable rollback closes deposits only". With deposits off and exits on, the lifecycle refuses a supply review with `deposits-disabled` and allows a withdrawal review.
   - `__tests__/hooks/useWrappedAction.test.tsx` › "signs a withdrawal when a deposit-disable rollback closes deposits only". The check before the signature reads the exit control, so the withdrawal reaches the wallet.

   Run them with:

   ```bash
   yarn test __tests__/helpers/lendingRoute.test.ts __tests__/hooks/useWrappedAction.test.tsx -t "deposit-disable rollback"
   ```

2. **A local build, by hand.** Build the release commit locally as [the COM-290 checklist](anchorage-porto-validation.md#build-under-test) does, but open exits only. From both controls off, run:

   ```bash
   perl -pi -e 's/isExitEnabled: false/isExitEnabled: true/' src/constants/wrappedMarkets.ts
   git diff --stat   # expect: 1 file changed, 3 insertions(+), 3 deletions(-)
   ```

   Never commit or push that change. With the Anchorage extension, check on each market:

   - the supply control reads "Wrapped deposits are not open yet."
   - the panel shows the holdings, and the withdraw control opens its form for a position
   - the direct Supply button stays absent
   - another wallet and a watch-only view stay on the standard route

   The withdraw form needs a wrapped position. Without an authorized one, record that check as not exercised.

## Observe without collecting wallet identity data

The app sends no telemetry of its own. A search of `package.json`, `index.html` and `src/` for Sentry, PostHog, Google Tag Manager, Mixpanel, Amplitude, Datadog, Plausible, LogRocket, Hotjar, New Relic, Bugsnag and Rollbar found none. The app turns off the Coinbase Wallet SDK's telemetry (`src/helpers/wagmiConfig.ts:40-43`). This release adds no telemetry. Use these existing facilities:

1. **Chain data, counted per wrapper.** Count the wrappers' `Deposit` and `Withdraw` events and the failed transactions to each wrapper, per day, and read the failed ones' error selectors. Do not build lists of holder addresses, and do not link an address to a person.
2. **Quotes against receipts.** The fork suite at a recent block compares the app's quotes with the chain's receipts, with no wallet data. Run it after each stage.
3. **Reports from holders,** through Anchorage and Leo, with the transaction hashes that a holder chooses to share. Compare the dialog's checked cash with the cash in Comet's `Withdraw` event of the receipt. Interest after the check raises the payout. A lower payout, or a rise beyond the interest of the time between the check and the block, needs a look.

## Tests that pin the committed controls

A release-control PR also updates these tests. Each test keeps its intent. A test of the committed control asserts the new committed value. A test that used the shipped registry as a closed fixture moves to an explicit fixture. The rehearsal tests use fixtures, so no stage changes them.

The list comes from a trial on 2026-10-22: a copy of this branch with the controls flipped, run with `yarn test`. With `isExitEnabled: true` on all three markets, these 8 tests failed:

- `__tests__/helpers/wrappedMarkets.test.ts` › "maps the three Ethereum Comet addresses to distinct wrappers and correct units"
- `__tests__/helpers/lendingRoute.test.ts` › "selects wrapped deposits only for the active Anchorage connector and configured market", 3 cases
- `__tests__/hooks/useLendingRoute.test.tsx` › "enables reads but no write with the shipped registry"
- `__tests__/hooks/useWriteWrappedState.test.tsx` › "keeps the exit closed by the committed release control"
- `src/pages/home/__tests__/WrappedWithdraw.test.tsx` › "keeps the withdraw control disabled by the committed release control"
- `src/pages/home/__tests__/WrappedWithdraw.test.tsx` › "keeps the withdraw control disabled when the route refuses exits, whatever the lifecycle reports"

Each list counts from both controls off. A Stage 2 PR made after Stage 1 also fails the tests that the Stage 1 PR updated. With `isDepositEnabled: true` as well, these 2 failed in addition:

- `src/pages/home/__tests__/WrappedSupply.test.tsx` › "keeps the supply control disabled by the committed release control"
- `src/pages/home/__tests__/WrappedSupply.test.tsx` › "keeps the supply control disabled when the route refuses deposits, whatever the lifecycle reports"

The suite's one known failure, `useMarketsOverviewState` › "should return MarketOverviewState after fetch", failed in every run, the unflipped one included. On each release-control PR, check that it is still the only other failure. A new failure in the same file can hide behind it.

## Open questions

| Question                                                                                | Owner         |
| --------------------------------------------------------------------------------------- | ------------- |
| Will `main` and the `production` environment be protected, or is the risk accepted?     | Adam and Leo  |
| Which interface can send the direct exit's call data from an Anchorage custody account? | Adam, COM-290 |
| Which authorized position serves the Stage 1 exit and the custody exit check?           | Adam          |
| Who owns the release, and when does each stage ship?                                    | Adam and Leo  |

## Release record for COM-292

Paste this into COM-292 and fill it in, one stage block per release.

```text
## COM-292 release record

Release owner: <name>
Signoff per stage: Adam <date, link>. Leo <date, link>.
Agreed timing: <dates or windows per stage>

### Preflight

- Release path: main protection <yes/no>, production environment rules <yes/no>, or risk accepted by <names, link>
- Production before the stack: CID <cid>, commit <sha>
- Registry closures recorded in docs/anchorage-wrapper-registry.md: <PR>
- Registry check 1, post-audit changes: sign-off or risk acceptance by <name>, <link>
- Registry check 2, runtime reproduction (COM-289, #67): accepted by <name>
- Registry check 3, factory owner: owner <address>, threshold <n> of <m> signers, controlled by <names>
- Registry check 4, fresh reads at block <number>: <results>. Implementations: <addresses>. Fork suite at a recent block: <PASS or FAIL>, <summary link>
- COM-290 acceptance: <link>. Markets accepted: <markets>. Accepted commit: <sha>. Rows run again after later changes: <rows, or none>
- COM-291 decision: <link>. History follow-ups: <issues, or none>
- Product questions from #64, #65 and #66: <answers or acceptances>
- Extensions page path (#64), before Stage 2: <PR or decision>
- Dropped broadcast transaction (#64, #65), before Stage 2: <PR or accepted limitation>
- Custody exit path, before Stage 2: <interface>, <transaction hash>
- Stage 1 exit through the production app, before Stage 2: <transaction hash>

### Stage <0, 1, 2, R1, R2 or R3>

- PR: <link>. Approvals: <name>, <name>. Commits after the approvals: <none, or reviewed>
- Settings after the merge: USDC deposit <on/off>, exit <on/off>. USDT deposit <on/off>, exit <on/off>. Institutional USDC deposit <on/off>, exit <on/off>
- Merge commit: <sha>. Production commit before the release: <sha>. Diff between them: <controls and tests only, or what else>
- npx tsc <result>, yarn lint <result>, yarn test <result>, yarn build <result>
- build.yaml run: <link>. Head SHA: <sha>. CID: <cid>
- Release Production run: <link>, dispatched from main. cid input: <cid>. CID in the signing request matched: <yes/no>. Payload and released CID in the log: <cid>, <cid>. Timestamp: <ms>. Deployer: <address>
- Verification: wrapped markets <results>. Standard regressions <results>. Other wallets and watch-only <results>
- Stop conditions met: <none, or which>
- For R1: deposit-open CIDs unpinned: <CIDs>. Screening allows the gateway origin: <yes/no>

### Rollback rehearsal

- Rehearsal tests at commit <sha>: <n passed>
- Local build at <sha> with deposits off and exits on: <results>
- Direct exit rehearsal, on a fork or with an authorized mainnet holder: <results>

### Observations, without wallet identity data

- <observation>
```

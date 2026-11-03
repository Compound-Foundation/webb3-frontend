# Anchorage wrapped lending: transaction history decision record (COM-291)

No decision is recorded. Product's decision owner is Steve, and Leo is the contact. The [Decision](#decision) section holds empty fields for them.

Expected from code: Compound's transaction history will leave out every wrapped supply and its approvals. It will list each wrapped exit as "Withdrew <cash> <symbol>" on the market, the same as a withdrawal from the holder's own Comet position. These are expectations from the frontend, the history backend and the wrapper contract, with the chain part checked on a local fork. On 2026-10-26, COM-290's runs on mainnet observed the same in Recent Transactions, for USDC and institutional USDC. Each exit's row rounds the cash to four decimals. [Observed](#observed-filled-from-com-290) records the samples, and lists the surfaces and the market that the runs did not capture.

The record follows COM-291. It cites code at these commits:

- this repository at the PR's head
- `Compound-Foundation/webb3-backend-api` at `35389f3`, under `c3-api/`
- `Compound-Foundation/comet-erc4626` at [`1152de2`](https://github.com/Compound-Foundation/comet-erc4626/blob/1152de2b3942df189817ff03213177061455fb1d/src/WrappedCometERC4626.sol), `src/WrappedCometERC4626.sol`

## How the app builds transaction history

Facts from code:

1. **The frontend asks the backend for one account's history.** `useTransactionHistory` fetches `${VITE_V3_API_HOST}/account/<account>/transaction_history` (`src/helpers/urls.ts:60-73`, `src/hooks/useTransactionHistory.tsx:112-119`). The account is `web3.write.account` (`useTransactionHistory.tsx:121-164`). In a watch-only session that is the `?account=` address (`src/contexts/Web3Context.tsx:151-163`).
2. **The frontend caches one account's list.** It stores the last list in local storage under `RECENT_TRX_DATA` (`useTransactionHistory.tsx:20`, `:96-110` and `:179`). It fetches again every 5 minutes (`:21` and `:189-194`), and when the local transaction list changes (`src/components/WalletButton.tsx:86-97`, `src/pages/transactions/index.tsx:67-74`).
3. **The backend reads logs from the Comets and the rewards contract only.** On Ethereum its stream holds the cUSDCv3, cWETHv3, cUSDTv3 and ciUSDCv3 Comets and the rewards contract (`src/transaction-history-handler/transaction-history-items-handler.ts:135-156`). `rawTransactionHistoryItems` runs `eth_getLogs` on exactly those addresses (`lib/computations/account/raw-transaction-history-items.ts:283` and `:316`).
4. **The backend keeps a log only if the account is its first or second indexed address.** The two filters take Comet's `Supply`, `Transfer`, `Withdraw`, collateral, absorb and reward events with the account in topic 1 or topic 2 (`raw-transaction-history-items.ts:308-356`). It drops mint and burn transfers (`:156-160`) and duplicate log indexes (`:358-372`).
5. **The backend records the event's own account on each action.** A `Withdraw(src, to, amount)` action's account is `src` (`raw-transaction-history-items.ts:112-133`). The backend classifies a `Supply` or `Withdraw` by that account's Comet balances: a `Withdraw` from an account that does not borrow is a "Withdraw" (`lib/computations/account/enrich-transaction-history-items.ts:172-222`). The item's `initiatedBy` is the transaction's sender (`:127-131`).
6. **The frontend shows the action type, the amount, the token and the market.** A row's title is the past-tense verb, the amount and the token symbol (`src/components/WalletTrxHistory.tsx:101-118`, `src/hooks/useTransactionHistory.tsx:73-93`). Its subtitle is the market of the action's contract (`WalletTrxHistory.tsx:164`, `src/helpers/markets.ts:151-159`). It adds "Initiated by" only when `initiatedBy` is not the connected account (`WalletTrxHistory.tsx:89-92`, `useTransactionHistory.tsx:36-51`). The Transactions page does the same (`src/pages/transactions/components/UnitTransaction.tsx:15-47`).
7. **The frontend never shows the action's account.** The backend returns it (`lib/model/transaction-history/action.ts:93-111`), but the frontend's `TransactionAction` type has no such field (`src/types.ts:676-688`).

## What a wrapped supply and exit emit on chain

Facts from the contract:

- `supplyAndWrap(amount)` pulls the base token from the caller with `safeTransferFrom`, then supplies it to Comet on the wrapper's own account with `comet.supply(base, amount)`. It mints the shares to the caller (`WrappedCometERC4626.sol:537-541`, `:1021-1023`, `:1053-1058`, `:1101-1112` and `:986-990`).
- `unwrapAndWithdraw(shares)` sends `worth - buffer` of the base token from Comet straight to the caller with `comet.withdrawTo(caller, base, amount)`. It burns the caller's shares (`:628-648`, `:1072-1081` and `:973-978`).

Facts from a fork: on 2026-10-22 a scratch probe ran these calls on a local anvil fork of mainnet block 26244888, from a fresh impersonated account. The probe lives outside the repository. On each of the three markets it sent an exact approval of 2,000,000 base units, `supplyAndWrap(2000000)`, an exit of half the shares and an exit of the rest. The receipts held these logs, shown here for USDC. USDT and institutional USDC showed the same sequence of logs from their own token, Comet and wrapper.

| Transaction                           | Logs, in order                                                                                                                                                                                                                                                                                                 | Logs the backend's filter keeps for the holder                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Exact approval                        | USDC `Approval(holder, wrapper, 2000000)`                                                                                                                                                                                                                                                                      | none: no Comet log                                                      |
| `supplyAndWrap`                       | USDC `Transfer(holder, wrapper, 2000000)`, USDC `Approval(wrapper, Comet, 2000000)`, USDC `Transfer(wrapper, Comet, 2000000)`, Comet `Supply(wrapper, wrapper, 2000000)`, Comet `Transfer(0x0, wrapper, 1999998)`, wrapper `Transfer(0x0, holder, shares)`, wrapper `Deposit(holder, holder, 1999999, shares)` | none: no Comet log names the holder                                     |
| `unwrapAndWithdraw`, partial and full | USDC `Transfer(Comet, holder, 999996)`, Comet `Withdraw(wrapper, holder, 999996)`, Comet `Transfer(wrapper, 0x0, 999996)`, wrapper `Transfer(holder, 0x0, shares)`, wrapper `Withdraw(holder, holder, holder, 999997, shares)`                                                                                 | Comet's `Withdraw(wrapper, holder, 999996)`, with the holder as topic 2 |

In each exit the cash in Comet's `Withdraw` equalled the base token the holder received. The wrapper's `Withdraw` event carried a gross debit 1 unit higher. The probe applied the backend's filter from fact 4 to the receipts. It did not run the backend.

The same reading of the code accounts for one real observation. COM-284's direct withdrawal of 1 USDC, whose hash the COM-284 comment records, emitted Comet `Withdraw(holder, holder, 1000000)` and a burn `Transfer`. The filter keeps both Comet logs and then drops the burn, and COM-284 saw "Withdrew 1 USDC" in Recent Transactions. On 2026-10-26, COM-290's runs checked wrapped transactions against the app this way ([Observed](#observed-filled-from-com-290)).

## Expected Compound history, from code

| Surface                                   | Approval or USDT reset                                                       | `supplyAndWrap`                              | Partial or full exit                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| Wallet menu, "N Pending" and Pending list | counted while the wallet has it, listed once broadcast, removed when settled | the same                                     | the same                                                                      |
| Recent Transactions and `/transactions`   | absent                                                                       | absent                                       | "Withdrew <cash> <symbol>", subtitled with the market, with no "Initiated by" |
| Dashboard                                 | the panel's allowance                                                        | the panel's shares, value and wallet balance | the panel's shares, value and wallet balance                                  |
| Watch-only view of the same account       | absent                                                                       | absent                                       | "Withdrew <cash> <symbol>", while the view shows no wrapped position          |

From these expectations:

- **Absent:** every wrapped supply, its exact approval and the USDT reset. No Comet log names the holder, and the backend reads no other contract's logs.
- **Mislabelled and misattributed:** every wrapped exit. Its row reads like a withdrawal from the holder's own Comet position. The backend attributes the action to the wrapper, the `src` of Comet's event, but the frontend drops that field. The row's amount is the cash the holder received, so the amount is right.
- **Indistinguishable:** for a holder with a direct position on the same market, as the COM-284 wallet has, a wrapped exit and a direct withdrawal read the same. Only the explorer link tells them apart: the wrapped exit's transaction goes to the wrapper.
- **Not duplicated:** each exit emits one Comet log that names the holder, and the backend drops a second copy of a log index.
- **Not shown in any history surface:** the shares burned, the wrapper's address and the gross debit. The withdrawal dialog shows the shares and the gross value only while it is open.
- **When:** an exit's row appears at the first fetch after the backend can read its block. The app fetches when the local list changes and every 5 minutes (fact 2).
- **After a reload or a reconnect:** no difference is expected, because the list comes from the backend for the account. A reload first shows the cached list (fact 2).

## Local pending records

The transaction manager's records name a wrapper transaction as such while it is pending. Expected from code:

- The lifecycle records each request with the wrapper as its key and the step's description (`src/hooks/useWrappedAction.ts:734-739`). The descriptions are "Reset the <symbol> allowance for the wrapper to 0", "Approve <amount> for the wrapper", "Supply <amount> through the wrapper", "Withdraw about <cash> from the wrapper" and "Withdraw all your wrapped <symbol>, about <cash>" (`src/hooks/useWriteWrappedState.ts:447`, `:453`, `:461` and `:762-765`). An exit's record carries the cash of the check before its signature (`:807`).
- The wallet button counts each record as pending. The Pending list shows a record with a hash, with its description and an explorer link (`src/components/WalletButton.tsx:19-35` and `:132-158`).
- The manager keeps a pending record in local storage under `webb3-transactions` (`src/helpers/constants.ts:11`, `src/hooks/useTransactionManager.ts:118-135`). A reload restores it for the connected account and chain (#64).
- When a record settles, the manager deletes it from the list and from storage (`useTransactionManager.ts:383-391`). It keeps the outcome in memory only, for the last 20 settled transactions, and no list shows them (`:245-246`, `:355` and `:389`). A reload loses them.
- When the user rejects a request, or the wallet refuses it before handling it (EIP-1193 code `4100`, `4200`, `4900` or `4901`, with no sign that the request can still complete), the manager deletes its record at once (`useTransactionManager.ts:584-592`). Nothing was sent, so no list shows it.
- When the wallet answers that it still holds the request, the manager keeps a wrapper step's record, marked interrupted, until the user presses "Stop waiting" (`useTransactionManager.ts:593-603`). The Anchorage extension answers so with `-32005` "still pending" after about 4 minutes 47 seconds, as a COM-290 run observed. Read from the source of extension 1.1.16, it also answers so with `4900` "The request can still complete" when the wallet is disconnected while the request waits.

So a later session shows no local record of a settled wrapper transaction. It shows one only while the transaction is pending, or while an interrupted request waits for "Stop waiting". Local storage belongs to one browser profile and one origin, so another browser or device shows nothing.

## Porto history

The code cannot predict Porto's activity lists. COM-284 observed that the extension showed no status and no notification for a pending transaction. The mobile app showed the request and its result. COM-290's capture records the rest.

## Observed (filled from COM-290)

Do not fill a cell from the expectations above. Each value needs a COM-290 capture.

| Sample    | Market             | Kind                | Hash                                                                 | Block    | Comet log index naming the wallet | Raw shares                | Gross Comet assets | Base cash                         |
| --------- | ------------------ | ------------------- | -------------------------------------------------------------------- | -------- | --------------------------------- | ------------------------- | ------------------ | --------------------------------- |
| S-USDC-1  | USDC               | exact approval      | `0xafa7857dbb050fdb9219c437884350caad11818ce072ef7adf1a1a34a9951286` | 26278214 | none                              | none                      | none               | none: a USDC `Approval` of 500000 |
| S-USDC-2  | USDC               | supply              | `0xc0dabd60d8012be31d16f51e3a201a8619a6d4c66ca6793d423e39236dede691` | 26278276 | none                              | 498376356093481967 minted | 499999             | 500000 from the wallet            |
| S-USDC-3  | USDC               | partial exit        | `0x1e087a36d57bd7e4ab0b9df92c9912dfd76858ea2649b1b01426236660db3b70` | 26278301 | 1016 (`Withdraw`)                 | 199353902630387816 burned | 200001             | 200000 to the wallet              |
| S-USDC-4  | USDC               | full exit           | `0x725830803cb4fc5a9e57da89dbdeb3acd9e6c457ded1b6dee51eeb07fb00bd34` | 26278312 | 483 (`Withdraw`)                  | 299022453463094151 burned | 299994             | 299993 to the wallet              |
| S-USDC-5  | USDC               | exact approval      | `0xed802a86f6b628438e0a8b2965f48270658cdf3741fbcb260486ec6a4b68d482` | 26278575 | none                              | none                      | none               | none: a USDC `Approval` of 490000 |
| S-USDC-6  | USDC               | supply              | `0xca542d772459bc1a1381dad3dfba484f23a7a984a32706db140f68d2a249bf6a` | 26278589 | none                              | 488406852861299189 minted | 489999             | 490000 from the wallet            |
| S-USDC-7  | USDC               | full exit           | `0x40e17cbb2c963c880d979ad2dcb024e549340e9564f42593e70cf37c9daf5695` | 26278609 | 1867 (`Withdraw`)                 | 488406852861299189 burned | 489998             | 489996 to the wallet              |
| S-IUSDC-1 | Institutional USDC | exact approval      | `0xe71db0235b1e401e4701467736b9a27d6da7c05fe2ad49e0da4f3361fa62254f` | 26278519 | none                              | none                      | none               | none: a USDC `Approval` of 500000 |
| S-IUSDC-2 | Institutional USDC | supply              | `0x94cf243fea62c9b6b5cafac00133020c8e21bde428b88ab5191d80284545d981` | 26278535 | none                              | 498982308830999254 minted | 499999             | 500000 from the wallet            |
| S-IUSDC-3 | Institutional USDC | partial exit        | not run                                                              |          |                                   |                           |                    |                                   |
| S-IUSDC-4 | Institutional USDC | full exit           | `0x991bbc906e560540587678c621a75b3f3f0f6a67913e96d5a0587e28fa80190d` | 26278558 | 1727 (`Withdraw`)                 | 498982308830999254 burned | 499997             | 499996 to the wallet              |
| S-USDT-1  | USDT               | approval, then stop | not run                                                              |          |                                   |                           |                    |                                   |
| S-USDT-2  | USDT               | allowance reset     | not run                                                              |          |                                   |                           |                    |                                   |
| S-USDT-3  | USDT               | exact approval      | not run                                                              |          |                                   |                           |                    |                                   |
| S-USDT-4  | USDT               | supply              | not run                                                              |          |                                   |                           |                    |                                   |
| S-USDT-5  | USDT               | partial exit        | not run                                                              |          |                                   |                           |                    |                                   |
| S-USDT-6  | USDT               | full exit           | not run                                                              |          |                                   |                           |                    |                                   |

S-USDC-1 to S-USDC-4 ran on build `95555f6`, and the other samples on `8e7d022` ([COM-290 results](anchorage-porto-validation.md#results)). Log indexes are decimal. Each receipt holds the logs of the fork's table above, in the same order. In each exit, Comet's `Withdraw` carried the cash that the wallet received. The wrapper's `Withdraw` carried a gross debit 1 unit higher, or 2 units higher for S-USDC-7.

For each surface, record what it showed for each kind of transaction, with the sample IDs as evidence. A cell is "as expected", "different" with a description, or "not captured".

| Surface                    | Kind                       | After confirmation                                                                                                                                                                                                                                                                         | After reload                                                                                       | After reconnect | Later session | Samples                                                      |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | --------------- | ------------- | ------------------------------------------------------------ |
| Pending list and button    | approval, reset and supply | as expected: no row once settled. The tester opened the wallet menu once a review's transactions were confirmed, not after each step, so the count and the row while pending were not captured. S-USDC-5 was checked after S-USDC-6, and nobody opened the menu after S-USDC-1             | as expected: after the S3 reload, the button counted S-IUSDC-1 as "1 Pending" until "Stop waiting" | not captured    | not captured  | S-USDC-2, S-USDC-5, S-USDC-6, S-IUSDC-1, S-IUSDC-2           |
| Pending list and button    | exit                       | as expected: no row once settled. The count and the row while pending were not captured                                                                                                                                                                                                    | not captured                                                                                       | not captured    | not captured  | S-USDC-3, S-USDC-4, S-USDC-7, S-IUSDC-4                      |
| Recent Transactions        | approval, reset and supply | as expected: absent                                                                                                                                                                                                                                                                        | as expected: S-USDC-1 and S-USDC-2 were still absent after the reloads at 17:57 and 17:59 UTC      | not captured    | not captured  | S-USDC-1, S-USDC-2, S-USDC-5, S-USDC-6, S-IUSDC-1, S-IUSDC-2 |
| Recent Transactions        | exit                       | as expected: "Withdrew 0.2000 USDC", "Withdrew 0.3000 USDC", "Withdrew 0.4900 USDC" and "Withdrew 0.5000 USDC", subtitled with the market and with no "Initiated by". Each amount is the cash rounded to four decimals, such as 0.3000 for 299993 base units. Each row opened its own hash | as expected: S-USDC-3 and S-USDC-4 were still listed after the reloads at 17:57 and 17:59 UTC      | not captured    | not captured  | S-USDC-3, S-USDC-4, S-USDC-7, S-IUSDC-4                      |
| `/transactions`            | approval, reset and supply | not captured                                                                                                                                                                                                                                                                               | not captured                                                                                       | not captured    | not captured  |                                                              |
| `/transactions`            | exit                       | not captured                                                                                                                                                                                                                                                                               | not captured                                                                                       | not captured    | not captured  |                                                              |
| Dashboard                  | all                        | as expected: after each step, the panel showed the new allowance, value and wallet balance ([COM-290 M2 and M4](anchorage-porto-validation.md#results))                                                                                                                                    | as expected: after the S3 reload, the panel showed the S-IUSDC-1 allowance of 0.5000 USDC          | not captured    | not captured  | every sample above                                           |
| Watch-only `/transactions` | all                        | not captured                                                                                                                                                                                                                                                                               | not captured                                                                                       | not captured    | not captured  |                                                              |
| Porto mobile activity      | all                        | not captured                                                                                                                                                                                                                                                                               | not captured                                                                                       | not captured    | not captured  |                                                              |
| Porto extension            | all                        | not captured for activity. The account screen listed no wrapper share token while the wallet held shares ([COM-290 finding 4](anchorage-porto-validation.md#findings-for-anchorage))                                                                                                       | not captured                                                                                       | not captured    | not captured  | S-USDC-6, S-IUSDC-2                                          |

The browser console held "Error fetching transaction history: 500" at least once during the runs of 2026-10-26. The error came from the history endpoint of fact 1. Recent Transactions still rendered, and each exit's row appeared after its confirmation.

So Compound's history matched the expectations above on each surface that the runs captured: the Pending list, Recent Transactions and the dashboard, for USDC and institutional USDC. The runs did not capture the Transactions page, the watch-only view, a reconnect, a later session, Porto's activity or USDT.

## Options

Holder visibility stays on the Anchorage route only (COM-285). An option that shows wrapped activity to every viewer of an account, through another wallet or watch-only mode included, widens that display. That wider display is a separate decision, and no option below implies it.

### Option A: retain the current behaviour

- Engineering cost: none.
- Limitations, as expected from code and observed on 2026-10-26: the absent supplies and approvals, and the exits that read as direct withdrawals, listed above. A holder who only used the wrapper sees withdrawals with no matching supply.
- What remains for the holder: the wrapped panel shows the position. Each wrapped dialog links its transactions on the explorer, and the explorer shows every log.

### Option B: label or suppress the misleading exits

- What changes: the frontend reads each action's `account` from the backend's response, which the backend already returns (`lib/model/transaction-history/action.ts:109`). An action whose account is a configured wrapper (`isWrapperAddress`, `src/helpers/wrappedActions.ts:211-213`) gets its own label, such as "Withdrew from the wrapper", or no row.
- What stays: supplies and approvals stay absent, because the backend keeps no log for them.
- Files: `src/types.ts`, `src/components/WalletTrxHistory.tsx`, `src/pages/transactions/components/`, `src/hooks/useTransactionHistory.tsx`, and tests with the history mocks in `src/helpers/mocks.ts` and `handlers/`. `src/hooks/` is a security-sensitive path in CODEOWNERS. No backend change.
- Engineering estimate, not validated: about 1 to 2 engineer-days. It assumes the response keeps `actions[].account`.
- Decision input: whether the label applies only on the Anchorage route, or to every viewer of the account.

### Option C: full persistent user-level history

- What changes in the backend:
  - Read the three wrappers' logs, and decode their `Deposit` and `Withdraw` events and their share transfers.
  - Attribute each role (`sender`, `owner`, `receiver`) to the account.
  - Match the wrapper's event to Comet's `Withdraw` in the same receipt, so that an exit shows once.
  - Version the cache, so that cached items are computed again. `rawTransactionHistoryItems` is version 4 and `enrichTransactionHistoryItem` version 5 (`raw-transaction-history-items.ts:270`, `enrich-transaction-history-items.ts:72`).
  - Discover the deployment blocks. The index starts at the earliest creation block of the stream's contracts (`lib/symbolic/index/transaction-history-index.ts:15-26`). The wrappers were created in blocks 26098209 (USDC and USDT) and 26105183 (institutional USDC) ([registry](anchorage-wrapper-registry.md#deployment-transactions)).
- What changes in the frontend: new action labels and types, and their rendering and tests.
- Cost: the plan's earlier figure of 4 to 7 engineer-days is provisional and covers the history work only. It is not a project estimate. The work is in `webb3-backend-api`, outside this repository, plus its deployment.

## Decision

The decision owner is Steve (Product), and Leo is the contact. An unanswered request does not satisfy Product acceptance. Neither does an engineering recommendation. This record makes no recommendation.

| Field                                                           | Value |
| --------------------------------------------------------------- | ----- |
| Decision: A, B, C or another                                    |       |
| Decided by                                                      |       |
| Date                                                            |       |
| Where it is recorded (link)                                     |       |
| Accepted limitations                                            |       |
| Where an option's labels apply: Anchorage route or every viewer |       |
| Follow-up issues, each blocking COM-292                         |       |

If the decision needs implementation, create scoped issues with acceptance criteria, and make COM-292 blocked by them, before release.

## Open questions

| Question                                                                         | Owner                                                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| What do Porto's mobile and extension activity show for each wrapped transaction? | Adam, in the COM-290 run                                                                                        |
| Does Compound's history match the expectations above?                            | Answered on 2026-10-26: yes, on each surface that the runs captured ([Observed](#observed-filled-from-com-290)) |
| Under option B, does the label apply on the Anchorage route only?                | Steve, through Leo                                                                                              |
| Who changes and deploys the backend under option C?                              | Adam                                                                                                            |

# Queued execution on the wrapped route

With the Anchorage connector, the Ethereum USDC, USDT and institutional USDC markets lend through each market's `WrappedCometERC4626` wrapper. These markets use the normal dashboard, with no separate wrapped panel: the masthead's Supply and Withdraw buttons, the amount form, the position card, the action queue and its before and after comparison. An Anchorage user supplies and withdraws through the same screens, labels, states and order as a direct supply in production, with no dialog of its own. This document describes how the route fits those screens, and where each safeguard runs below them. Other wallets, and other markets, are unchanged.

The route is decided by `resolveLendingRoute` (`src/helpers/lendingRoute.ts`): it is wrapped only when the selected connector's id is `com.anchorage.connect` and the wrapper registry (`src/constants/wrappedMarkets.ts`) maps the selected market. Each market keeps one entry in the market list and selector, and its detail page shows no wrapped notice.

## What the queue holds

A base supply or withdrawal on the wrapped route is queued as the ordinary `ActionType.Supply` or `ActionType.Withdraw` action. The queue does not know the route. The route decides, at submission, that the wrapper carries the action out (`isWrapperRouted` in `src/helpers/queuedExecution.ts`).

This representation was chosen because `calculateUpdatedBalances`, `ActionQueueItem`, edit, remove, clear and the comparison all work on these actions already. A new action type needs a case in each of them. The queue still refuses a wrapper draft or an action that names wrapper shares (`assertDirectActions`). Neither is ever a queue entry.

The dashboard adds the wrapped position's value to the Comet base supply (`withWrappedSupply` in `src/helpers/wrappedPositions.ts`), so the masthead, the position card and the comparison show it as the account's supply. Collateral value, borrow capacity and the liquidation figures are computed from the collateral assets, so wrapper shares stay out of them. An account that borrows directly keeps its borrow as the base balance. The masthead shows the wrapped value beneath it, and never subtracts it from the debt. The wrapped value is used only with a Comet state read for the selected market and known to be the connected account's.

## What the amount form accepts

On the wrapped route, `ActionRules.wrappedBase` (`src/helpers/actions.ts`) applies to the form and to every queued action:

| Action                         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base supply                    | "Supply Not Open Yet" while `isDepositEnabled` is `false`, whatever network the wallet is on. Otherwise refused with the route's reason while `route.deposit` is not eligible. "Must Repay Borrow First" while the account borrows directly, or with a Repay queued, since the wrapper's transaction goes before the direct actions. The allowance it needs is the base token's allowance to the wrapper (`supplyAllowance`), not to Comet.                                |
| Base withdrawal                | "Withdrawals Not Open Yet" while `isExitEnabled` is `false`. Otherwise refused with the route's reason while `route.exit` is not eligible. A partial amount can be at most the account's direct Comet supply plus what the wrapper pays now, the position less the redeem buffer, within the market's cash (`getWrappedRouteWithdrawalLimits`). The maximum is the whole direct supply and a full exit, refused while they cannot pay. Refused until the position is read. |
| Repay                          | Refused above the debt, since the excess is a direct Comet supply.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Supply and withdrawal together | Refused. A queue holds at most one wrapper action.                                                                                                                                                                                                                                                                                                                                                                                                                         |

The route-check labels are "Checking Your Wallet And This Market", "Unavailable For This Market" and "Connect Your Wallet" (`wrappedEntryBlockLabel` in `src/helpers/queuedExecution.ts`). They show in the form's title and on a queue row, where production shows "Amount Exceeds Wallet Balance". Apart from a closed release control, a wallet on another network is let through: Submit asks it to switch first, as it does for direct actions.

## Adding a supply: Approve & Add

The form compares the amount with the allowance to the wrapper, which the wrapped position read holds (`wrapperAllowance`). The Comet allowance in the Comet state is left as it is. The form then behaves as production's does:

- With no allowance, it shows production's hint and **Approve & Add**. The hint drops production's last sentence, "You only need to do this once.", because the approval is for exactly the amount and the supply spends it. This is the route's one text change.
- With an allowance below the amount, it shows production's "This amount exceeds the allowance you previously set for this asset. You will be asked to approve an increase when you add this action." and **Approve & Add**.
- With an allowance that covers the amount, it shows **Add Action**. A Max supply is compared as the wallet balance.

Approve & Add queues the supply and asks the wallet for the approval at once (`startApproval` in `src/pages/home/index.tsx`, `write.approve` in `src/hooks/useWriteWrappedState.ts`). The approval is the base token's `approve(wrapper, amount)` for exactly the amount, never more. For USDT with an insufficient nonzero allowance, the same press first asks for `approve(wrapper, 0)`. The approval of the amount follows only after the reset's receipt, and after the balance and allowance are read again. The wallet asks the holder to approve each of the two. A wallet on another network is asked to switch first, and nothing is queued, as in production. An approval that cannot start, as while an earlier wrapper transaction of the account is pending, queues nothing either, and the form stays open to be pressed again.

The queue row shows production's **Approval Pending** from the press until the receipt. The approval does not hold the dashboard: the rows stay editable and the collateral rows stay enabled, as for an approval of Comet. Until the allowance covers the supply, the row shows production's "Approval Failed" and Submit stays disabled. This happens when the approval is rejected, reverts or stops on a check, or when the amount is raised later. Editing the row then shows Approve & Add again.

## Submitting: Submit Transaction

A queue is split into the wrapper action and the direct actions (`planQueuedExecution`). The wrapper action goes first. Submit Transaction starts it with no other screen (`startWrapperAction` in `src/pages/home/index.tsx`):

| Queued action   | Wallet request                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base supply     | wrapper `supplyAndWrap(amount)` alone. An allowance below the amount refuses it before the wallet is asked, so Submit never asks for an approval. |
| Base withdrawal | wrapper `unwrapAndWithdraw(shares)`: the fewest shares that pay the queued cash, or every share for Max                                           |

An account can also hold a base supply made to Comet directly, outside the wrapper. A base withdrawal then takes that direct part first, through Comet, and any rest through the wrapper (`splitWrappedWithdrawal` in `src/helpers/queuedExecution.ts`, `startSplitWithdrawal` in `src/pages/home/index.tsx`). The queue keeps one withdrawal row:

| Queued amount                 | Wallet requests                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| At or below the direct supply | Comet `withdraw(baseToken, amount)` alone: production's own base withdrawal, through `useWriteCometState`. No wrapper call.      |
| Above the direct supply       | Comet `withdraw(baseToken, type(uint256).max)`, then, once it confirms, wrapper `unwrapAndWithdraw(shares)` for the rest.        |
| Max                           | Comet `withdraw(baseToken, type(uint256).max)`, then, once it confirms, a full exit of every share. Without shares, Comet alone. |

`type(uint256).max` makes Comet withdraw the account's supply and never borrow. A part larger than the supply would borrow the difference, so the Comet step is checked twice:

- When Submit is pressed and again just before the wallet is asked, the session and the live Comet state must still allow it (`isDirectWithdrawalRefused`): the wrapped route with its exits open and eligible, a Comet state read for this market and account, and a direct supply that covers what the step counts on. That is the amount itself for a part, or the whole direct supply the plan read.
- Just before the wallet is asked, Home reads the account's Comet balance again through the configured chain's provider (`readDirectBaseBalance`). After a Comet step of this kind has confirmed, the read waits for a block no older than that step's receipt, so a provider behind the wallet's node cannot show the supply the step took. A balance below what the step counts on sends nothing, and the row shows "Balance Changed, Edit Amount".

What follows the Comet step:

| What happens to the Comet step                                                                    | Queue and screen                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| It confirms                                                                                       | The row holds what the wrapper still pays, and the wrapper step starts with no other press. If another page is shown, or the run was dropped, the rest waits for the next Submit. |
| The user declines it                                                                              | The withdrawal stays queued, and nothing is said.                                                                                                                                 |
| The wallet refuses it before handling it                                                          | The withdrawal stays queued. Its row shows "Reconnect Your Wallet".                                                                                                               |
| It reverts                                                                                        | The withdrawal stays queued. Its row shows "Transaction Failed".                                                                                                                  |
| The wallet answers with an error after it had the request, or another transaction takes its nonce | The row keeps only the rest, or leaves the queue when there is none. Nothing is sent to the wrapper.                                                                              |

In the last case the request can still execute, and the transaction manager does not follow it. So App holds back every further Comet step in the same account, connector and market (`SubmissionStore.directStep`), and a withdrawal that needs one shows "Earlier Request Still Pending". Two partial withdrawals could otherwise together take more than the direct supply. A rest that the wrapper alone pays still goes once the dashboard shows the direct supply gone. A reload, or a change of account, connector or market, ends the hold, after the holder has checked the wallet.

A withdrawal with a direct part is submitted on its own: queued with other actions, its row shows "Submit The Withdrawal On Its Own" and nothing is sent.

A check made before signing cannot cover the time until the transaction executes. On Anchorage that can be minutes. A part still borrows if the direct supply falls in that time, through another transaction of the same account.

The masthead's notice says how much of the balance is supplied to Comet directly, and that Withdraw takes it out first. The Withdraw form's helper text says the same. While withdrawals are closed, the notice states the amount alone, and the form shows why it refuses. Neither shows without a direct supply, or on the standard route.

The position card shows what production shows for a transaction to Comet: **Confirm Transaction**, disabled, from the press until the wallet returns a hash, then **Transaction Pending...** until the receipt. The header shows the pending count once the wallet has the request. The queue stays projected, its rows are read-only, and the masthead buttons and both collateral row families are disabled. Until the wallet is asked, the transaction manager does not track the request, so Home shows the action's place in the list itself (`inFlightTransaction`). On the receipt, the action leaves the queue and the position is read again from a block that shows it. Nothing else appears: no step list, no Done, no explorer link and no success text.

A Max withdrawal's row shows the cash it pays: the direct supply, and the full exit's cash, the position less the wrapper's buffer, in production's row shape. While that is not known the row shows a spinner and Submit is disabled. No share count shows anywhere.

## Mixed queues

When the queue also holds direct actions, the wrapper action goes first. When it confirms, the direct actions continue at once through production's own path (`continueAfterWrapper`): one action straight to Comet, or several in one Bulker transaction, with the Bulker's own approval and transaction dialogs. A single ETH or stETH action goes through the Bulker, as in production. The direct actions also wait for the next Submit if the wallet changed network or the session became unusable meanwhile, or if the wrapper action confirmed while another page was shown, so no wallet request opens when the user returns.

The wrapper's transaction and the direct transaction are two wallet transactions. They are not atomic: the wrapper's can confirm and the direct one can then be rejected or fail, and the direct actions then stay queued. Production sends several direct actions in one Bulker transaction. A wrapper call cannot join it, because the Bulker has no wrapper action. `getBulkerTrxData` still refuses a wrapper draft or an action naming wrapper shares.

The wrapper goes first for three reasons:

- The existing direct path clears the whole queue when its transaction settles. Run last, it clears only what is left.
- A wrapped exit that pays the cash a later direct action needs, such as a borrow after a full exit, runs first.
- A wrapper action that stops leaves the direct actions unsent, so nothing is half done on the Comet side.

Before the direct actions are sent, `isSubmissionRefused` checks them against the live route and refuses any base supply, base withdrawal or repay above the debt, and a borrow while a direct supply remains, which Comet would withdraw before it borrows (`lendsBaseDirectly`). The one base withdrawal to Comet on this route is a withdrawal's planned Comet step, which `isDirectWithdrawalRefused` checks instead. App pre-estimates gas for the direct actions only. The wrapper's transaction estimates its own gas just before it is signed.

## Where the safeguards run

The press of Approve & Add or Submit Transaction is the user's confirmation. `useWrappedAction` still runs each action as a draft, and `useSignWhenReady`, which App calls, signs each step once it is ready. Every safeguard runs below the screens:

| Safeguard                                                                                                                             | Where                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh account, connector id and uid, connection status, chain, market, wrapper, route, screening, release control and wallet provider | `checkBeforeSignature` before each request, again after the reads, and once more after the gas estimate, immediately before the wallet is asked (`src/hooks/useWrappedAction.ts`). A change of any of them discards the draft in the same render.                              |
| Release controls and route eligibility                                                                                                | The form's rules, the check in the form's callback, `start`, and `checkBeforeSignature`.                                                                                                                                                                                       |
| Canonical wrapper, asset and metadata                                                                                                 | The route's validation, and `checkWrappedStep`, which allows only the base token's `approve` to the wrapper, `supplyAndWrap` and `unwrapAndWithdraw`.                                                                                                                          |
| Exact approval, USDT reset order, no approval at Submit                                                                               | `prepareWrappedApproval` and `prepareWrappedSupply`. `checkWrappedDraft` allows an approval draft of `[approve(amount)]` or `[approve(0), approve(amount)]`, and a supply draft of `supplyAndWrap` alone. Each step reads the balance and allowance again before it is signed. |
| Supply simulation                                                                                                                     | `supplyAndWrap` is simulated from the account at the block of the step's read.                                                                                                                                                                                                 |
| Withdrawal pause, liquidity, buffer-aware quote, simulation                                                                           | `prepareWrappedWithdrawal`: a fresh read at a block no older than the review's, `recheckWithdrawal` with its rise and fall tolerances, and a simulation that must pay the quote of the same block.                                                                             |
| One wrapper action at a time                                                                                                          | `blockedReason`: a new action waits while another is in progress, or while a wrapper transaction of the account is pending on the chain.                                                                                                                                       |
| Duplicate sends across a network change                                                                                               | `SentWrapperAction` (below).                                                                                                                                                                                                                                                   |
| Settlement                                                                                                                            | The transaction manager's outcome: confirmed, reverted, replaced or unresolved, with no automatic retry.                                                                                                                                                                       |
| Fresh balances                                                                                                                        | Reads wait for the block of the account's newest settled wrapper transaction (`newestReceiptBlock`).                                                                                                                                                                           |

## When something stops

| What happens                                                                                                                                           | Queue and screen                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The user rejects the request in the wallet                                                                                                             | The supply or withdrawal stays queued, Submit is enabled again, and nothing is said, as in production.                                                 |
| A check before the wallet request fails, the reads fail, or the start is refused                                                                       | The action stays queued. Its row shows "Not Sent, Try Again" in production's error position, and Submit stays enabled. The detail goes to the console. |
| The check or the start finds an earlier wrapper request of the account still pending or open in the wallet                                             | The action stays queued. Its row shows "Earlier Request Still Pending", since that request can still go through.                                       |
| The wallet refuses the request before handling it (EIP-1193 `4100`, `4200`, `4900` or `4901`)                                                          | The action stays queued. Its row shows "Reconnect Your Wallet".                                                                                        |
| The transaction reverts                                                                                                                                | The action stays queued. Its row shows "Transaction Failed".                                                                                           |
| The wallet answers with an error after it can have sent the request, the transaction can no longer be followed, or another transaction takes its nonce | The action leaves the queue, so it is not sent twice. The direct actions stay.                                                                         |
| The transaction confirms                                                                                                                               | The action leaves the queue, and the direct actions continue.                                                                                          |

An approval that stops leaves its supply queued, with "Approval Failed" until the allowance covers it.

A wallet request whose result nothing can follow holds back every new wrapper action: one left open at a reload, or answered with an ambiguous error. The transaction manager keeps it, marked interrupted, because the wallet can still send it. The holder stops waiting for it with the **Clear** control of the header's and the wallet menu's list of transactions, after checking the wallet. Clear keeps a wrapper transaction that can still be followed: one with a hash, or one whose request is open in this session.

## Session changes and pages

A run, Approve & Add's approval or Submit's supply or withdrawal, belongs to its scope (`submissionScope`): the account, connector, connection status, wallet network and market it started in. App keeps it beside the lifecycle (`WrappedLendingContext.submission`, built by `useSubmissionStore`), so it survives a visit to another page: a supply that confirmed meanwhile has left the queue on return. A change of scope drops the run in the same render, whichever page is shown, and the dashboard's kept callbacks do nothing. The queue itself is cleared on a change of account, connector, connection status or market. It survives a change of wallet network.

The wallet network can change while a submitted supply or withdrawal is in the wallet or pending. The run is dropped and the lifecycle ignores what its discarded draft sent, but the transaction can still confirm. So when Submit starts a wrapper action, App also records it apart from the run (`SentWrapperAction`), in `queueScope`, which leaves out the wallet network. The record shows nothing of its own. While it is held:

- The position card shows the transaction manager's record of the transaction, as production does for a pending transaction to Comet: Transaction Pending..., with Submit disabled, on either network. The manager's list is not filtered by network.
- A Submit callback kept from an earlier render sends nothing until the record settles. With no transaction pending, Submit on another network opens the existing network-switch dialog and sends nothing, as in production.
- `useSubmissionStore` follows the manager's record of the transaction (`sentActionStatus`):

| What became of the transaction                                           | Queue                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| In the wallet, or pending                                                | Held                                                                                    |
| Confirmed                                                                | The action leaves, on whichever page and network the wallet is.                         |
| An interrupted request, or another transaction took its nonce            | The action leaves, so it is not sent twice.                                             |
| Reverted, or forgotten unsent (declined, refused, withdrawn or not sent) | Released: the action stays queued and can be submitted again.                           |
| Never reached the manager, and the run stopped or was dropped            | Released. The manager records a request before it asks the wallet, so nothing was sent. |

A pending receipt on the market's network is looked up only while the wallet is on that network, so a return to it settles the record.

## Limits

- An account with both a direct Comet supply and a wrapped position sees them added together, with a notice of the direct part. Withdraw takes the direct part first, through Comet, then the rest through the wrapper (see [Submitting](#submitting-submit-transaction)). The two steps are two wallet transactions, not one: the Comet step can confirm and the wrapper step then stop, and the row then holds the rest. The direct part goes first, so a partial withdrawal gives up the direct supply's COMP rewards before the wrapped supply, which earns none. Withdraw is gated by `isExitEnabled` as a whole, so a direct supply is not withdrawable on this route while exits are closed. Until they open, preflight item 11 of the [release runbook](anchorage-release-runbook.md#preflight) covers such accounts. A direct supply is never moved into the wrapper, and the app never asks for `comet.allow(wrapper, true)`.
- A borrow beside a supply, direct or wrapped, is mixed-position UX, which is out of scope. The masthead shows a supply, so the dashboard offers no Borrow while one is held, and validation refuses one ("Must Withdraw Full USDC Balance"). A borrow kept in the queue from before a direct supply appeared is refused at submission, since Comet's `withdraw` would take the direct supply before it borrows (`lendsBaseDirectly`). An account that borrows directly is shown its borrow, with the wrapped value beneath it, and is offered no wrapped withdrawal until the borrow is repaid. Such an account cannot arise through this flow, which refuses a wrapped supply while a direct borrow exists.
- A wrapper transaction and the direct actions after it are two transactions, not one (see [Mixed queues](#mixed-queues)).
- The wallet's request names the wrapper and its call, not Comet's `supply` or `withdraw`. The app's screens match production. The wallet's own screens cannot.
- Release controls are not changed. With the committed registry, both stay `false`, and the form refuses every base supply and withdrawal with the route's reason.

## Tests

- `__tests__/helpers/queuedExecution.test.ts`: the three market mappings, other wallets, Anchorage on a market without a wrapper, maximum amounts, mixed queues, refusals, the route-check labels, and `splitWrappedWithdrawal` below, at and above a direct supply and for Max.
- `__tests__/helpers/actions.test.ts`: the wrapped rules, including the allowance to the wrapper for a supply and a Max supply, a withdrawal up to the direct supply and the wrapper together, and `lendsBaseDirectly`, including a borrow beside a direct supply.
- `__tests__/helpers/wrappedPositions.test.ts`: `isSubmissionRefused`, `isDirectWithdrawalRefused`, `readDirectBaseBalance` and `getWrappedRouteWithdrawalLimits`.
- `__tests__/helpers/wrappedActions.test.ts`: approval and supply drafts, and the calls a step is allowed to make.
- `__tests__/hooks/useWrappedAction.test.tsx`: the lifecycle and its checks, `useSignWhenReady`, and waiting for an interrupted request until the list is cleared.
- `__tests__/hooks/useWriteWrappedState.test.tsx`: the approval, the USDT reset on one press, the supply that refuses a short allowance, and the withdrawal, against a simulated chain.
- `__tests__/hooks/useSubmissionStore.test.ts`: linking, following and releasing a sent wrapper action, and its scope, and the scope of a split withdrawal's Comet step.
- `__tests__/hooks/useTransactionManager.test.tsx`: Clear drops an interrupted wrapper request and keeps one that can still be followed.
- `src/pages/home/__tests__/wrappedQueue.test.tsx`: Approve & Add, Approval Pending, Confirm Transaction and Transaction Pending..., the receipt, rejection, the row labels, partial and full exits, mixed queues through the Bulker and straight to Comet, duplicate submits and session changes, each with no dialog.
- `src/pages/home/__tests__/wrappedQueueSettlement.test.tsx`: the real queue, transaction manager, lifecycle and wrapped writes. Approve & Add then Submit, rejection, a Max withdrawal, a supply or withdrawal sent before a change of network, which executes once, and Submit from another network with nothing pending, which asks for the switch. With a direct supply: a withdrawal at, below and above it and Max, the order of the two steps, each step's failure, a Comet step that confirms on another page or can still execute, a session change during the fresh read, a stale dashboard against a provider behind the wallet's node, a withdrawal queued with other actions, and a direct supply that falls between review and signing.
- `src/pages/home/__tests__/wrappedQueueFlow.test.tsx`: the real masthead, form, queue and position card: the hint and Approve & Add, add, edit, remove, clear, comparison and submit, what a Max withdrawal row shows, the direct-supply notice and helper text, and the standard route's unchanged withdrawal.
- `e2e/specs/mixed-position.spec.ts`: on the browser fork, a direct and a wrapped supply shown together, a withdrawal split between them, then Max.
- `src/pages/home/__tests__/PositionCard.test.tsx`: the queue's rows and button on the wrapped route.
- `__tests__/integration/wrappedLendingFork/` and `e2e/specs/wrapped-queue.spec.ts`: the same calls against a mainnet fork. The browser spec walks Approve & Add, Submit and a Max withdrawal and checks that no dialog is active.

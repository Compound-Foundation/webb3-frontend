# Queued execution on the wrapped route

With the Anchorage connector, the Ethereum USDC, USDT and institutional USDC markets lend through each market's `WrappedCometERC4626` wrapper. These markets use the normal dashboard, with no separate wrapped panel: the masthead's Supply and Withdraw buttons, the amount form, the position card, the action queue and its before and after comparison. This document describes how such a queue is submitted. Other wallets, and other markets, are unchanged.

The route is decided by `resolveLendingRoute` (`src/helpers/lendingRoute.ts`): it is wrapped only when the selected connector's id is `com.anchorage.connect` and the wrapper registry (`src/constants/wrappedMarkets.ts`) maps the selected market. Each market keeps one entry in the market list and selector, and its detail page shows no wrapped notice.

## What the queue holds

A base supply or withdrawal on the wrapped route is queued as the ordinary `ActionType.Supply` or `ActionType.Withdraw` action. The queue does not know the route. The route decides, at submission, that the wrapper carries the action out (`isWrapperRouted` in `src/helpers/queuedExecution.ts`).

This representation was chosen because `calculateUpdatedBalances`, `ActionQueueItem`, edit, remove, clear and the comparison all work on these actions already. A new action type needs a case in each of them. The queue still refuses a wrapper draft or an action that names wrapper shares (`assertDirectActions`). Neither is ever a queue entry.

The dashboard adds the wrapped position's value to the Comet base supply (`withWrappedSupply` in `src/helpers/wrappedPositions.ts`), so the masthead, the position card and the comparison show it as the account's supply. Collateral value, borrow capacity and the liquidation figures are computed from the collateral assets, so wrapper shares stay out of them. An account that borrows directly keeps its borrow as the base balance. The masthead shows the wrapped value beneath it, and never subtracts it from the debt. The wrapped value is used only with a Comet state read for the selected market and known to be the connected account's.

## What the amount form accepts

On the wrapped route, `ActionRules.wrappedBase` (`src/helpers/actions.ts`) applies to the form and to every queued action:

| Action                         | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base supply                    | "Supply Not Open Yet" while `isDepositEnabled` is `false`, whatever network the wallet is on. Otherwise refused with the route's reason while `route.deposit` is not eligible. Refused while the account borrows directly, or with a Repay queued: the user repays in a submission of its own first, since the wrapper's steps go before the direct actions. No allowance to Comet is needed: the wrapper's approval is requested at submission.                          |
| Base withdrawal                | "Withdrawals Not Open Yet" while `isExitEnabled` is `false`. Otherwise refused with the route's reason while `route.exit` is not eligible. A partial amount can be at most what the wrapper pays now: the position less the redeem buffer, within the market's cash. The maximum is a full exit, refused while one cannot pay. Refused until the position is read. The gross position is not compared with the market's cash, since the wrapper pays only what it quotes. |
| Repay                          | Refused above the debt, since the excess is a direct Comet supply.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Supply and withdrawal together | Refused. A queue holds at most one wrapper action.                                                                                                                                                                                                                                                                                                                                                                                                                        |

Apart from a closed release control, a wallet on another network is let through: Submit asks it to switch first, as it does for direct actions. The form callback checks the live rules again, so a form kept from before the controls closed queues nothing.

## Order of submission

A queue is split into the wrapper action and the direct actions (`planQueuedExecution`). The wrapper action goes first. The direct actions follow, as before: one action directly to Comet, or several in one Bulker transaction, after the Bulker approval if the account has not given it.

| Order | Transaction                                                                    | Contract and call                                                                                               |
| ----- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 1     | Reset the allowance to 0, only for USDT with an insufficient nonzero allowance | base token `approve(wrapper, 0)`                                                                                |
| 2     | Approve exactly the amount, only when the allowance is below it                | base token `approve(wrapper, amount)`                                                                           |
| 3     | Supply                                                                         | wrapper `supplyAndWrap(amount)`                                                                                 |
| 1     | Withdraw, instead of 1 to 3                                                    | wrapper `unwrapAndWithdraw(shares)`: the fewest shares that pay the queued cash, or every share for the maximum |
| Last  | The direct actions                                                             | Comet, or the Bulker's `invoke`                                                                                 |

The wrapper goes first for three reasons:

- The existing direct path clears the whole queue when its transaction settles. Run last, it clears only what is left.
- A wrapped exit that pays the cash a later direct action needs, such as a borrow after a full exit, runs first.
- A wrapper action that stops leaves the direct actions unsent, so nothing is half done on the Comet side.

The Bulker has no wrapper action, so a wrapper call never goes through it. The plan keeps the wrapper action apart. Before the direct actions are sent, `isSubmissionRefused` checks them against the live route and refuses any base supply, base withdrawal or repay above the debt (`lendsBaseDirectly`). `getBulkerTrxData` still refuses a wrapper draft or an action naming wrapper shares. App pre-estimates gas for the direct actions only. Each wrapper step estimates its own gas just before it is signed.

## The submission dialog

Submit starts the wrapper action through `useWriteWrappedState`, which reads the balance, allowance or position again and builds the steps. `useWrappedAction` runs them, with these safeguards:

- every step is signed only after the user confirms it in the dialog
- before each signature the step checks the identity it was reviewed under, the route's eligibility (signer, chain, screening, connector conflicts, wrapper validation and the release control), Comet's pause, the step's own read and simulation, the wallet session, and other pending wrapper transactions
- an exit is rechecked against a block no older than its review, with the buffer-aware quote and the rise and fall tolerances of `recheckWithdrawal`
- one wrapper action runs at a time, and a new one waits for an earlier wrapper transaction of the account to settle
- a settled transaction refreshes the position, from a block that shows it

The dialog (`QueuedSubmissionModal`) lists every transaction in order: the wrapper steps with their status and explorer link, then "Then N other actions, sent together as one transaction". The position card's Submit button shows "Confirm Transaction" or "Transaction Pending..." while a wrapper transaction is open, as it does for a Comet or Bulker transaction. While a submission is in progress, Home ignores every edit, removal, clear and new amount, from the position card, the masthead and both collateral row families, so the queue stays the one the submission was planned from. The collateral rows' buttons are disabled meanwhile, including while a step is checked before its signature, when no transaction is tracked yet.

When the wrapper action confirms, it leaves the queue. If direct actions remain, the dialog offers "Submit N Remaining Actions", which sends them through the direct path. The direct path then shows its own dialog.

## When a step fails

Nothing that did not complete leaves the queue, except a last step that can have executed or can still:

| What happens                                                                      | Queue                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The start is refused, for example `transaction-pending`                           | Unchanged. The dialog says why and offers Stop waiting for an interrupted earlier request.                                                                                                              |
| The read or a check before signing fails                                          | Unchanged                                                                                                                                                                                               |
| The user rejects a step, or the wallet refuses or fails                           | Unchanged. An approval that already confirmed stays on chain, and the next review reads the new allowance.                                                                                              |
| An approval reverts or is replaced                                                | Unchanged                                                                                                                                                                                               |
| The last step reverts                                                             | Unchanged                                                                                                                                                                                               |
| The wrapper action confirms                                                       | The wrapper action leaves. The direct actions stay until they are submitted.                                                                                                                            |
| The last step fails in the wallet, or can no longer be followed after it was sent | The wrapper action leaves, and the dialog says it can still go through. This keeps it from being sent twice. The direct actions stay.                                                                   |
| Another transaction takes the last step's nonce (`replaced`)                      | The wrapper action leaves, and the dialog says it can have gone through as another transaction. A sped-up copy of the same call takes the nonce under a new hash and executes. The direct actions stay. |

Closing the dialog while a step is being signed only hides it. Nothing more is sent without a confirmation, and the dialog returns when the step settles or stops. Meanwhile the position card says that the supply or withdrawal is in progress and the queue waits for it. Its Show Progress button, or Submit, shows the dialog again and starts nothing. Closing it at any other time discards the review.

App keeps the submission beside the wrapper action lifecycle (`WrappedLendingContext.submission`, built by `useSubmissionStore`), not in the dashboard. A user who opens another page while a step is pending finds the dialog again on return, and a supply that confirmed meanwhile has left the queue.

## Session changes

A submission belongs to its scope (`submissionScope`): the account, connector, connection status, wallet network and market it started in. A change of any of them drops the submission in the same render, whichever page is shown, and the dashboard's kept callbacks do nothing. The wrapper action lifecycle discards its draft for the same changes, since its `WrappedActionIdentity` covers the account, connector id and uid, connection status, chain, market, wrapper, screening, release control and wallet provider. The queue itself is cleared on a change of account, connector, connection status or market. It survives a change of wallet network, so it can be submitted after the switch.

The wallet network can change while the last wrapper step is in the wallet or pending. The submission is dropped, so no kept callback signs anything more, and the lifecycle ignores what its discarded draft sent. The transaction can still confirm, though. So when a submission starts its wrapper action, App also records the action apart from the submission (`SentWrapperAction`). That record belongs to `queueScope`: the account, connector, connection status and market, without the wallet network, like the queue itself. It is dropped with the queue on a change of any of them.

Until the record is settled, Home holds the whole queue as it does during a submission: Submit and every edit do nothing, and the collateral rows are disabled. When no submission dialog is shown, for example after a change of network, the position card says why. It names the network the supply or withdrawal is pending on, and says that the queue waits until it settles. With the wallet on another network, it asks the user to switch back. `useSubmissionStore` links the record to the transaction manager's record of the last step (`supplyAndWrap` or `unwrapAndWithdraw`, by step id, account, chain and wrapper) once that step reaches the manager, and then follows it (`sentActionStatus`):

| What became of the last step                                                                                                | Queue                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| In the wallet, or pending                                                                                                   | Held                                                                                           |
| Confirmed                                                                                                                   | The wrapper action leaves, on whichever page and network the wallet is. The record is dropped. |
| The wallet answered with an error after it can have sent it (an interrupted request), or another transaction took its nonce | The wrapper action leaves, as it does when the dialog says it can have gone through.           |
| Reverted, or forgotten unsent (declined, refused, withdrawn or not sent)                                                    | Released: the wrapper action stays queued and can be submitted again.                          |
| Never reached the manager, and the submission ended or was dropped                                                          | Released. The manager records a step before it asks the wallet, so nothing of it was sent.     |

A pending receipt on the market's network is looked up only while the wallet is on that network, so a return to it settles the record.

## Limits

- The empty-account path is the supported one. An account with both a direct Comet supply and a wrapped position sees them added together. A withdrawal goes through the wrapper only and can take at most what the wrapper pays, so a direct supply cannot be withdrawn on this route. A Max withdrawal's queue row shows what the full exit pays, not the combined balance. Mixed direct and wrapped positions are out of scope. Preflight item 11 of the [release runbook](anchorage-release-runbook.md#preflight) looks for such accounts before the first release.
- A borrow beside a wrapped supply is mixed-position UX, which is out of scope. The masthead shows a wrapped supply as the account's supply, so the dashboard offers no Borrow while it is held, and validation refuses one ("Must Withdraw Full USDC Balance"). An account that borrows directly is shown its borrow, with the wrapped value beneath it, and is offered no wrapped withdrawal until the borrow is repaid. Such an account cannot arise through this flow, which refuses a wrapped supply while a direct borrow exists.
- Release controls are not changed. With the committed registry, both stay `false`, and the form refuses every base supply and withdrawal with the route's reason.

## Tests

- `__tests__/helpers/queuedExecution.test.ts`: the three market mappings, other wallets, Anchorage on a market without a wrapper, maximum amounts, mixed queues and refusals.
- `__tests__/helpers/actions.test.ts`: the wrapped rules, including a full exit the wrapper can pay while the gross position exceeds the market's cash, and `lendsBaseDirectly`.
- `__tests__/hooks/useSubmissionStore.test.ts`: linking, following and releasing a sent wrapper action, and its scope.
- `src/pages/home/__tests__/wrappedQueue.test.tsx`: submission, step order, USDT reset order, partial and full exits, mixed queues, failure, duplicate submits, the queue lock and session changes. The lock tests cover both collateral row families, and the notice and Show Progress while the dialog is hidden.
- `src/pages/home/__tests__/wrappedQueueSettlement.test.tsx`: the real queue, transaction manager, lifecycle, wrapped writes and submission store. A supply or partial withdrawal sent before a change of network executes once, and one that reverted returns to the queue. Meanwhile the position card names the network that holds it.
- `src/pages/home/__tests__/PositionCard.test.tsx`: the position card's notice of a held queue and its action.
- `src/pages/home/__tests__/wrappedQueueFlow.test.tsx`: the real masthead, form, queue and position card: add, edit, remove, clear, comparison and submit, and what a Max withdrawal row shows.
- `__tests__/hooks/useWriteWrappedState.test.tsx` and `__tests__/hooks/useWrappedAction.test.tsx`: the wrapper steps and their checks, against a simulated chain.
- `__tests__/integration/wrappedLendingFork/` and `e2e/specs/wrapped-queue.spec.ts`: the same calls against a mainnet fork.

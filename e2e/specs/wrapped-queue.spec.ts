// COM-309: the Anchorage connector on the Ethereum USDC market, through the normal dashboard. The harness
// provider announces `com.anchorage.connect`, so the app lends through the market's wrapper. The harness's
// dev server opens the release controls (`releaseControls.ts`); the committed registry keeps them closed.
//
// The flow has production's screens and order: Approve & Add asks the wallet for an exact approval to the
// wrapper at once, and the queue row shows Approval Pending; Submit Transaction asks for `supplyAndWrap`
// with no dialog, and the position card shows Confirm Transaction until the wallet answers. A queued
// maximum withdrawal is `unwrapAndWithdraw` of every share. Each request is checked before it is approved
// and each receipt on the fork. Nothing is sent to Comet or the Bulker directly.
//
// The queue holds one action at a time. While the withdrawal is queued, the form for an ETH collateral
// supply says to submit or remove it first, and adds nothing.
import { decodeFunctionData, getAddress, type Address, type Hash } from 'viem';

import { COMET_USDC, ERC20_ABI, USDC, WRAPPER_ABI, WRAPPER_USDC } from '../harness/contracts';
import { connectAccount, expect, nextRequest, openApp, selectedAccount, test } from '../harness/fixtures';
import { minedOnFork, usdcBalance } from '../harness/forkState';
import { ANCHORAGE_WALLET } from '../harness/injectedProvider';
import type { WalletRequest } from '../harness/walletServer';

const FUNDED = 1_000_000_000n;
const SUPPLY = 100_000_000n;

type Transaction = { from: string; to: string; data: `0x${string}`; value?: string; chainId?: string };

/** Checks a queued `eth_sendTransaction` before it is approved: chain, origin, sender, contract and value. */
function checkTransactionRequest(
  request: WalletRequest,
  { account, appOrigin, to }: { account: Address; appOrigin: string; to: Address }
) {
  expect(request.method).toBe('eth_sendTransaction');
  expect(request.origin).toBe(appOrigin);
  expect(request.chainIdAtRequest).toBe(1);
  expect(request.selectedAccount).toBe(account);
  const [transaction] = request.params as [Transaction];
  expect(getAddress(transaction.from)).toBe(account);
  expect(getAddress(transaction.to)).toBe(to);
  expect(BigInt(transaction.value ?? '0x0')).toBe(0n);
  if (transaction.chainId !== undefined) expect(Number(transaction.chainId)).toBe(1);
  return transaction;
}

/**
 * Checks that no dialog is shown. The app keeps its modal nodes mounted and marks the shown one active,
 * so the active class is checked as well as the dialog role.
 */
async function expectNoDialog(page: Parameters<typeof openApp>[0]) {
  await expect(page.locator('.modal--active')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const wrapperShares = (fork: Parameters<typeof usdcBalance>[0], account: Address, blockNumber?: bigint) =>
  fork.readContract({
    address: WRAPPER_USDC,
    abi: WRAPPER_ABI,
    functionName: 'balanceOf',
    args: [account],
    blockNumber,
  });

test.describe('Anchorage on Ethereum USDC through the normal queue', { tag: ['@COM-309', '@COM-342'] }, () => {
  test.use({ harnessWallet: ANCHORAGE_WALLET });

  test('supplies and withdraws through the wrapper from the queue, with each request and the fork state checked', async ({
    page,
    wallet,
    fork,
    appOrigin,
  }) => {
    const account = getAddress(await selectedAccount(wallet, '1000'));
    expect(await usdcBalance(fork, account)).toBe(FUNDED);
    expect(await wrapperShares(fork, account)).toBe(0n);
    await openApp(page);
    await connectAccount(page, wallet, account, ANCHORAGE_WALLET.label);
    const seen = new Set((await wallet.requests()).map((request) => request.id));

    // The normal dashboard: no separate wrapped panel, and the masthead's Supply button.
    await expect(page.locator('.wrapped-position-panel')).toHaveCount(0);
    await page.getByRole('button', { name: 'Supply USDC' }).click();
    await page.getByRole('textbox', { name: '0' }).first().fill('100');
    // Production's approval hint, without its promise that one approval is enough.
    await expect(
      page
        .getByText('You need to approve Compound on the USDC contract before you can use this asset.', { exact: true })
        .first()
    ).toBeVisible();
    await expect(page.getByText(/You only need to do this once/)).toHaveCount(0);

    // Approve & Add asks the wallet for the exact approval to the wrapper at once, and queues the supply.
    await page.getByRole('button', { name: 'Approve & Add' }).first().click();
    const approveRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const approveTransaction = checkTransactionRequest(approveRequest, { account, appOrigin, to: USDC });
    const approveCall = decodeFunctionData({ abi: ERC20_ABI, data: approveTransaction.data });
    expect(approveCall.functionName).toBe('approve');
    expect(approveCall.args).toEqual([WRAPPER_USDC, SUPPLY]);
    await expect(page.getByText('Approval Pending').first()).toBeVisible();
    await expect(page.getByText('After Transaction')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: /^100\s*\.0000$/ })).toBeVisible();
    await expectNoDialog(page);
    const approveHash = ((await wallet.approve(approveRequest.id)) as WalletRequest).result as Hash;
    await minedOnFork(fork, approveHash, { from: account, to: USDC });
    await expect(page.getByText('Approval Pending')).toHaveCount(0, { timeout: 60_000 });

    // Submit Transaction asks the wallet for the supply alone, with no dialog. The position card says
    // Confirm Transaction while the wallet has the request.
    const submit = page.getByRole('button', { name: 'Submit Transaction' }).first();
    await expect(submit).toBeEnabled({ timeout: 60_000 });
    await submit.click();
    const supplyRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    await expect(page.getByRole('button', { name: 'Confirm Transaction' }).first()).toBeDisabled();
    await expectNoDialog(page);
    const supplyTransaction = checkTransactionRequest(supplyRequest, { account, appOrigin, to: WRAPPER_USDC });
    const supplyCall = decodeFunctionData({ abi: WRAPPER_ABI, data: supplyTransaction.data });
    expect(supplyCall.functionName).toBe('supplyAndWrap');
    expect(supplyCall.args).toEqual([SUPPLY]);
    const supplyHash = ((await wallet.approve(supplyRequest.id)) as WalletRequest).result as Hash;
    const { receipt: supplyReceipt } = await minedOnFork(fork, supplyHash, { from: account, to: WRAPPER_USDC });
    const shares = await wrapperShares(fork, account, supplyReceipt.blockNumber);
    expect(shares).toBeGreaterThan(0n);
    expect(await usdcBalance(fork, account, supplyReceipt.blockNumber)).toBe(FUNDED - SUPPLY);

    // The receipt takes the supply out of the queue with no Done. The masthead shows the wrapped position.
    await expect(page.getByText('After Transaction')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByRole('paragraph').filter({ hasText: /^Supplying$/ })).toBeVisible({ timeout: 60_000 });
    await expectNoDialog(page);

    // Withdraw everything: a maximum withdrawal is a full exit of every share, with no approval.
    await page.getByRole('button', { name: 'Withdraw USDC' }).click({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Max' }).first().click();
    await page.getByRole('button', { name: 'Add Action' }).first().click();

    // One action at a time: a collateral supply cannot join the queued withdrawal, and nothing is asked
    // of the wallet for it. The account holds ETH for gas, so the ETH row's Supply is the open entry.
    const etherRow = page.locator('.asset-row').filter({ has: page.getByText('Ether', { exact: true }) });
    await etherRow.getByRole('button').first().click();
    await expect(page.getByText('Submit Or Remove The Queued Action First').first()).toBeVisible();
    await page.getByRole('textbox', { name: '0' }).first().fill('0.1');
    await expect(page.getByRole('button', { name: 'Add Action' }).first()).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(page.getByText('Submit Or Remove The Queued Action First')).toHaveCount(0);

    await page.getByRole('button', { name: 'Submit Transaction' }).first().click();
    const exitRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    await expect(page.getByRole('button', { name: 'Confirm Transaction' }).first()).toBeDisabled();
    await expectNoDialog(page);
    const exitTransaction = checkTransactionRequest(exitRequest, { account, appOrigin, to: WRAPPER_USDC });
    const exitCall = decodeFunctionData({ abi: WRAPPER_ABI, data: exitTransaction.data });
    expect(exitCall.functionName).toBe('unwrapAndWithdraw');
    expect(exitCall.args).toEqual([shares]);
    const exitHash = ((await wallet.approve(exitRequest.id)) as WalletRequest).result as Hash;
    const { receipt: exitReceipt } = await minedOnFork(fork, exitHash, { from: account, to: WRAPPER_USDC });
    expect(await wrapperShares(fork, account, exitReceipt.blockNumber)).toBe(0n);
    // The exit pays the shares' value less the wrapper's rounding buffer of a few base units.
    const returned = (await usdcBalance(fork, account, exitReceipt.blockNumber)) - (FUNDED - SUPPLY);
    expect(returned).toBeGreaterThan(SUPPLY - 100n);
    expect(returned).toBeLessThanOrEqual(SUPPLY);
    await expect(page.getByText('After Transaction')).toHaveCount(0, { timeout: 60_000 });
    await expectNoDialog(page);

    // Exactly three transactions, and none of them to Comet or the Bulker.
    const sends = await wallet.requests({ method: 'eth_sendTransaction' });
    expect(sends.map((request) => request.id)).toEqual([approveRequest.id, supplyRequest.id, exitRequest.id]);
    for (const request of sends) {
      const [transaction] = request.params as [Transaction];
      expect(getAddress(transaction.to)).not.toBe(COMET_USDC);
    }
  });

  test('shows the normal dashboard and queue at a mobile width', async ({ page, wallet, appOrigin }) => {
    const account = getAddress(await selectedAccount(wallet, '1000'));
    await openApp(page);
    // The header's Connect Wallet text shows at desktop widths only, so the wallet connects first.
    await connectAccount(page, wallet, account, ANCHORAGE_WALLET.label);
    const seen = new Set((await wallet.requests()).map((request) => request.id));
    await page.setViewportSize({ width: 390, height: 844 });

    await expect(page.locator('.wrapped-position-panel')).toHaveCount(0);
    await page.getByRole('button', { name: 'Supply USDC' }).click();
    await page.getByRole('textbox', { name: '0' }).first().fill('25');
    await page.getByRole('button', { name: 'Approve & Add' }).first().click();
    // The bottom sheet's queue, as production's, with the approval asked for and nothing else.
    await expect(page.getByText('1 Pending Action', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: /^25\s*\.0000$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit Transaction' }).last()).toBeVisible();
    const approveRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const approveTransaction = checkTransactionRequest(approveRequest, { account, appOrigin, to: USDC });
    expect(decodeFunctionData({ abi: ERC20_ABI, data: approveTransaction.data }).args).toEqual([
      WRAPPER_USDC,
      25_000_000n,
    ]);
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(1);
    await expectNoDialog(page);
  });
});

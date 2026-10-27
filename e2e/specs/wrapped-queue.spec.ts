// COM-309: the Anchorage connector on the Ethereum USDC market, through the normal dashboard. The harness
// provider announces `com.anchorage.connect`, so the app lends through the market's wrapper. The harness's
// dev server opens the release controls (`releaseControls.ts`); the committed registry keeps them closed.
//
// A queued supply is sent as an exact approval to the wrapper and `supplyAndWrap`, and a queued maximum
// withdrawal as `unwrapAndWithdraw` of every share, each request checked before it is approved and each
// receipt checked on the fork. Nothing is sent to Comet or the Bulker directly.
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

const wrapperShares = (fork: Parameters<typeof usdcBalance>[0], account: Address, blockNumber?: bigint) =>
  fork.readContract({
    address: WRAPPER_USDC,
    abi: WRAPPER_ABI,
    functionName: 'balanceOf',
    args: [account],
    blockNumber,
  });

test.describe('Anchorage on Ethereum USDC through the normal queue', { tag: ['@COM-309'] }, () => {
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
    // No approval to Comet is asked for when the supply is queued.
    await page.getByRole('button', { name: 'Add Action' }).first().click();
    await expect(page.getByText('After Transaction')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: /^100\s*\.0000$/ })).toBeVisible();
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toEqual([]);

    // Submit: the shared dialog lists the exact approval, then the supply through the wrapper.
    await page.getByRole('button', { name: 'Submit Transaction' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Submit Your Actions' });
    await expect(dialog.getByRole('listitem')).toHaveText([
      /Approve 100\.000000 USDC for the wrapper/,
      /Supply 100\.000000 USDC through the wrapper/,
    ]);

    await dialog.getByRole('button', { name: 'Approve 100.000000 USDC' }).click();
    const approveRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const approveTransaction = checkTransactionRequest(approveRequest, { account, appOrigin, to: USDC });
    const approveCall = decodeFunctionData({ abi: ERC20_ABI, data: approveTransaction.data });
    expect(approveCall.functionName).toBe('approve');
    expect(approveCall.args).toEqual([WRAPPER_USDC, SUPPLY]);
    const approveHash = ((await wallet.approve(approveRequest.id)) as WalletRequest).result as Hash;
    await minedOnFork(fork, approveHash, { from: account, to: USDC });

    // The supply waits for its own confirmation.
    await dialog.getByRole('button', { name: 'Supply 100.000000 USDC' }).click({ timeout: 60_000 });
    const supplyRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const supplyTransaction = checkTransactionRequest(supplyRequest, { account, appOrigin, to: WRAPPER_USDC });
    const supplyCall = decodeFunctionData({ abi: WRAPPER_ABI, data: supplyTransaction.data });
    expect(supplyCall.functionName).toBe('supplyAndWrap');
    expect(supplyCall.args).toEqual([SUPPLY]);
    const supplyHash = ((await wallet.approve(supplyRequest.id)) as WalletRequest).result as Hash;
    const { receipt: supplyReceipt } = await minedOnFork(fork, supplyHash, { from: account, to: WRAPPER_USDC });
    const shares = await wrapperShares(fork, account, supplyReceipt.blockNumber);
    expect(shares).toBeGreaterThan(0n);
    expect(await usdcBalance(fork, account, supplyReceipt.blockNumber)).toBe(FUNDED - SUPPLY);

    // The supply confirmed and left the queue. The masthead shows the wrapped position as the supply.
    await page.getByRole('dialog', { name: 'Transactions Confirmed' }).getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('After Transaction')).toHaveCount(0);
    await expect(page.getByRole('paragraph').filter({ hasText: /^Supplying$/ })).toBeVisible({ timeout: 60_000 });

    // Withdraw everything: a maximum withdrawal is a full exit of every share.
    await page.getByRole('button', { name: 'Withdraw USDC' }).click({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Max' }).first().click();
    await page.getByRole('button', { name: 'Add Action' }).first().click();
    await page.getByRole('button', { name: 'Submit Transaction' }).first().click();
    const exitDialog = page.getByRole('dialog', { name: 'Submit Your Actions' });
    await exitDialog.getByRole('button', { name: 'Withdraw Everything' }).click({ timeout: 60_000 });
    const exitRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
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

    // Exactly three transactions, and none of them to Comet or the Bulker.
    const sends = await wallet.requests({ method: 'eth_sendTransaction' });
    expect(sends.map((request) => request.id)).toEqual([approveRequest.id, supplyRequest.id, exitRequest.id]);
    for (const request of sends) {
      const [transaction] = request.params as [Transaction];
      expect(getAddress(transaction.to)).not.toBe(COMET_USDC);
    }
  });

  test('shows the normal dashboard and queue at a mobile width', async ({ page, wallet }) => {
    const account = getAddress(await selectedAccount(wallet, '1000'));
    await openApp(page);
    // The header's Connect Wallet text shows at desktop widths only, so the wallet connects first.
    await connectAccount(page, wallet, account, ANCHORAGE_WALLET.label);
    await page.setViewportSize({ width: 390, height: 844 });

    await expect(page.locator('.wrapped-position-panel')).toHaveCount(0);
    await page.getByRole('button', { name: 'Supply USDC' }).click();
    await page.getByRole('textbox', { name: '0' }).first().fill('25');
    await page.getByRole('button', { name: 'Add Action' }).first().click();
    await expect(page.getByText('1 Pending Action', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: /^25\s*\.0000$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit Transaction' }).last()).toBeVisible();
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toEqual([]);
  });
});

// COM-344: an Anchorage account on the Ethereum USDC market with a base supply made straight to Comet beside
// its wrapped position. The dashboard shows the two together, and its notice says how much is supplied to
// Comet directly. Withdraw takes the direct part first, as production's Comet base withdrawal, then the rest
// through the wrapper, which the app asks for only once the Comet step confirms. Max takes the whole direct
// part, then every share. The harness's dev server opens the release controls (`releaseControls.ts`).
import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hash } from 'viem';

import { COMET_ABI, COMET_USDC, ERC20_ABI, MAX_UINT256, USDC, WRAPPER_ABI, WRAPPER_USDC } from '../harness/contracts';
import { connectAccount, expect, nextRequest, openApp, selectedAccount, test } from '../harness/fixtures';
import { minedOnFork, usdcBalance } from '../harness/forkState';
import { ANCHORAGE_WALLET } from '../harness/injectedProvider';
import type { WalletRequest } from '../harness/walletServer';

const DIRECT = 250_000_000n;
const WRAPPED = 100_000_000n;
const SPLIT = 300_000_000n;
const SECOND_DIRECT = 50_000_000n;

type Fork = Parameters<typeof usdcBalance>[0];
type Wallet = Parameters<typeof nextRequest>[0];
type Transaction = { from: string; to: string; data: `0x${string}`; value?: string; chainId?: string };

const wrapperShares = (fork: Fork, account: Address, blockNumber?: bigint) =>
  fork.readContract({
    address: WRAPPER_USDC,
    abi: WRAPPER_ABI,
    functionName: 'balanceOf',
    args: [account],
    blockNumber,
  });
const directSupply = (fork: Fork, account: Address, blockNumber?: bigint) =>
  fork.readContract({ address: COMET_USDC, abi: COMET_ABI, functionName: 'balanceOf', args: [account], blockNumber });

/** Sends a set-up transaction from the account without the app, and waits for it on the fork. */
async function sendOnFork(wallet: Wallet, fork: Fork, from: Address, to: Address, data: `0x${string}`) {
  const { hash } = await wallet.forkSend({ from, to, data });
  return minedOnFork(fork, hash, { from, to });
}

/** A direct Comet supply of `amount`, after an exact approval of Comet. */
async function supplyToComet(wallet: Wallet, fork: Fork, account: Address, amount: bigint) {
  const approve = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [COMET_USDC, amount] });
  await sendOnFork(wallet, fork, account, USDC, approve);
  const supply = encodeFunctionData({ abi: COMET_ABI, functionName: 'supply', args: [USDC, amount] });
  await sendOnFork(wallet, fork, account, COMET_USDC, supply);
}

/** Checks a queued `eth_sendTransaction` before it is approved: chain, origin, sender, contract and value. */
function checkTransactionRequest(
  request: WalletRequest,
  { account, appOrigin, to }: { account: Address; appOrigin: string; to: Address }
) {
  expect(request.method).toBe('eth_sendTransaction');
  expect(request.origin).toBe(appOrigin);
  expect(request.chainIdAtRequest).toBe(1);
  const [transaction] = request.params as [Transaction];
  expect(getAddress(transaction.from)).toBe(account);
  expect(getAddress(transaction.to)).toBe(to);
  expect(BigInt(transaction.value ?? '0x0')).toBe(0n);
  if (transaction.chainId !== undefined) expect(Number(transaction.chainId)).toBe(1);
  return transaction;
}

async function expectNoDialog(page: Parameters<typeof openApp>[0]) {
  await expect(page.locator('.modal--active')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

const notice = (page: Parameters<typeof openApp>[0]) =>
  page.getByText(
    /USDC of your balance is supplied to Comet directly, outside the wrapper\. Withdraw takes it out first\./
  );

test.describe('a direct Comet supply beside a wrapped position, on Anchorage', { tag: ['@COM-344'] }, () => {
  test.use({ harnessWallet: ANCHORAGE_WALLET });

  test('shows both, withdraws the direct part first and the rest through the wrapper, then withdraws everything with Max', async ({
    page,
    wallet,
    fork,
    appOrigin,
  }) => {
    test.setTimeout(240_000);
    const account = getAddress(await selectedAccount(wallet, '1000'));
    await supplyToComet(wallet, fork, account, DIRECT);
    const approveWrapper = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [WRAPPER_USDC, WRAPPED],
    });
    await sendOnFork(wallet, fork, account, USDC, approveWrapper);
    const wrap = encodeFunctionData({ abi: WRAPPER_ABI, functionName: 'supplyAndWrap', args: [WRAPPED] });
    await sendOnFork(wallet, fork, account, WRAPPER_USDC, wrap);
    const sharesAtStart = await wrapperShares(fork, account);
    expect(sharesAtStart).toBeGreaterThan(0n);
    expect(await directSupply(fork, account)).toBeGreaterThanOrEqual(DIRECT - 1n);

    await openApp(page);
    await connectAccount(page, wallet, account, ANCHORAGE_WALLET.label);
    const seen = new Set((await wallet.requests()).map((request) => request.id));

    // Shown: the two together, and the notice of the direct part, in the masthead's existing notice slot.
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: /^3(49|50)\s*\.\d{4}$/ })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('.wrapped-position-panel')).toHaveCount(0);

    // Split: 300 USDC is the whole direct supply through Comet, then the rest through the wrapper.
    await page.getByRole('button', { name: 'Withdraw USDC' }).click({ timeout: 60_000 });
    await expect(
      page
        .getByText(/of this balance is supplied to Comet directly\. Withdraw takes it out first, then the rest/)
        .first()
    ).toBeVisible();
    await page.getByRole('textbox', { name: '0' }).first().fill('300');
    await page.getByRole('button', { name: 'Add Action' }).first().click();
    const walletBefore = await usdcBalance(fork, account);
    await page.getByRole('button', { name: 'Submit Transaction' }).first().click();

    const cometRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    await expect(page.getByRole('button', { name: 'Confirm Transaction' }).first()).toBeDisabled();
    await expectNoDialog(page);
    const cometTransaction = checkTransactionRequest(cometRequest, { account, appOrigin, to: COMET_USDC });
    const cometCall = decodeFunctionData({ abi: COMET_ABI, data: cometTransaction.data });
    expect(cometCall.functionName).toBe('withdraw');
    expect(cometCall.args).toEqual([USDC, MAX_UINT256]);
    // Nothing is asked of the wrapper while the Comet step is in the wallet.
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(1);
    const cometHash = ((await wallet.approve(cometRequest.id)) as WalletRequest).result as Hash;
    const { receipt: cometReceipt } = await minedOnFork(fork, cometHash, { from: account, to: COMET_USDC });
    expect(await directSupply(fork, account, cometReceipt.blockNumber)).toBe(0n);
    const fromComet = (await usdcBalance(fork, account, cometReceipt.blockNumber)) - walletBefore;
    expect(fromComet).toBeGreaterThanOrEqual(DIRECT - 1n);

    // Once the Comet step confirms, the app asks for the wrapper step with no other press.
    const wrapperRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    await expectNoDialog(page);
    const wrapperTransaction = checkTransactionRequest(wrapperRequest, { account, appOrigin, to: WRAPPER_USDC });
    const wrapperCall = decodeFunctionData({ abi: WRAPPER_ABI, data: wrapperTransaction.data });
    expect(wrapperCall.functionName).toBe('unwrapAndWithdraw');
    const [burned] = wrapperCall.args as [bigint];
    expect(burned).toBeGreaterThan(0n);
    expect(burned).toBeLessThan(sharesAtStart);
    const wrapperHash = ((await wallet.approve(wrapperRequest.id)) as WalletRequest).result as Hash;
    const { receipt: wrapperReceipt } = await minedOnFork(fork, wrapperHash, { from: account, to: WRAPPER_USDC });
    expect(await wrapperShares(fork, account, wrapperReceipt.blockNumber)).toBe(sharesAtStart - burned);
    const received = (await usdcBalance(fork, account, wrapperReceipt.blockNumber)) - walletBefore;
    expect(received).toBeGreaterThanOrEqual(SPLIT);
    expect(received).toBeLessThan(SPLIT + 1_000_000n);
    await expect(page.getByText('After Transaction')).toHaveCount(0, { timeout: 60_000 });
    await expect(notice(page)).toHaveCount(0, { timeout: 60_000 });

    // A new direct supply beside what is left of the wrapped position, then Max.
    await supplyToComet(wallet, fork, account, SECOND_DIRECT);
    await expect(notice(page)).toBeVisible({ timeout: 90_000 });
    const sharesBeforeMax = await wrapperShares(fork, account);
    await page.getByRole('button', { name: 'Withdraw USDC' }).click({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Max' }).first().click();
    await page.getByRole('button', { name: 'Add Action' }).first().click();
    await page.getByRole('button', { name: 'Submit Transaction' }).first().click();

    const maxCometRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const maxCometCall = decodeFunctionData({
      abi: COMET_ABI,
      data: checkTransactionRequest(maxCometRequest, { account, appOrigin, to: COMET_USDC }).data,
    });
    expect(maxCometCall.functionName).toBe('withdraw');
    expect(maxCometCall.args).toEqual([USDC, MAX_UINT256]);
    const maxCometHash = ((await wallet.approve(maxCometRequest.id)) as WalletRequest).result as Hash;
    await minedOnFork(fork, maxCometHash, { from: account, to: COMET_USDC });

    const exitRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const exitCall = decodeFunctionData({
      abi: WRAPPER_ABI,
      data: checkTransactionRequest(exitRequest, { account, appOrigin, to: WRAPPER_USDC }).data,
    });
    expect(exitCall.functionName).toBe('unwrapAndWithdraw');
    expect(exitCall.args).toEqual([sharesBeforeMax]);
    const exitHash = ((await wallet.approve(exitRequest.id)) as WalletRequest).result as Hash;
    const { receipt: exitReceipt } = await minedOnFork(fork, exitHash, { from: account, to: WRAPPER_USDC });

    // Max leaves no direct supply and no wrapper shares.
    expect(await directSupply(fork, account, exitReceipt.blockNumber)).toBe(0n);
    expect(await wrapperShares(fork, account, exitReceipt.blockNumber)).toBe(0n);
    await expect(page.getByText('After Transaction')).toHaveCount(0, { timeout: 60_000 });
    await expectNoDialog(page);

    // Four requests in the app's order: Comet, wrapper, Comet, wrapper. No Bulker call and no approval.
    const sends = await wallet.requests({ method: 'eth_sendTransaction' });
    expect(sends.map((request) => request.id)).toEqual([
      cometRequest.id,
      wrapperRequest.id,
      maxCometRequest.id,
      exitRequest.id,
    ]);
  });
});

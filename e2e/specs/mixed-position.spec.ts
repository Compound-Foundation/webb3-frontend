// COM-344: an Anchorage account on the Ethereum USDC market with a base supply made straight to Comet beside
// its wrapped position. The dashboard shows the two together, and its notice says how much is supplied to
// Comet directly. Withdraw takes the direct part first, as production's Comet base withdrawal, then the rest
// through the wrapper, which the app asks for only once the Comet step confirms. Max takes the whole direct
// part, then every share. A Comet step the wallet still holds holds back the next one, whatever market is
// shown in between, whatever the balance does, and whichever tab submits, until the held request itself is
// found mined, in the block its log names. The same account through a standard-route wallet is refused
// while the holds cannot be read. A direct supply that changes before signing still pays the queued
// amount. The harness's dev server opens the release controls (`releaseControls.ts`).
import { decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Address, type Hash } from 'viem';

import { COMET_ABI, COMET_USDC, ERC20_ABI, MAX_UINT256, USDC, WRAPPER_ABI, WRAPPER_USDC } from '../harness/contracts';
import {
  connectAccount,
  expect,
  harnessContext,
  nextRequest,
  openApp,
  selectedAccount,
  test,
} from '../harness/fixtures';
import { minedOnFork, usdcBalance } from '../harness/forkState';
import { ANCHORAGE_WALLET, METAMASK_WALLET } from '../harness/injectedProvider';
import type { WalletRequest } from '../harness/walletServer';

const DIRECT = 250_000_000n;
const WRAPPED = 100_000_000n;
/** A withdrawal within the direct supply: one Comet request, nothing from the wrapper. */
const WITHIN_DIRECT = 40_000_000n;
const SPLIT = 300_000_000n;
const SECOND_DIRECT = 50_000_000n;
/** Mainnet WETH, collateral of the USDC Comet. */
const WETH = getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
const BORROW_ABI = parseAbi(['function borrowBalanceOf(address) view returns (uint256)']);
/** Where the app stores its holds on Comet steps (`src/helpers/directWithdrawalHold.ts`). */
const HOLDS_KEY = 'webb3-direct-withdrawal-holds';

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

/** A wrapped supply of `amount`, after an exact approval of the wrapper. */
async function supplyToWrapper(wallet: Wallet, fork: Fork, account: Address, amount: bigint) {
  const approve = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [WRAPPER_USDC, amount] });
  await sendOnFork(wallet, fork, account, USDC, approve);
  const wrap = encodeFunctionData({ abi: WRAPPER_ABI, functionName: 'supplyAndWrap', args: [amount] });
  await sendOnFork(wallet, fork, account, WRAPPER_USDC, wrap);
}

/** Queues a withdrawal of `amount` USDC through the form and presses Submit Transaction. */
async function submitWithdrawal(page: Parameters<typeof openApp>[0], amount: string) {
  await page.getByRole('button', { name: 'Withdraw USDC' }).click({ timeout: 60_000 });
  await page.getByRole('textbox', { name: '0' }).first().fill(amount);
  await page.getByRole('button', { name: 'Add Action', exact: true }).first().click();
  await page.getByRole('button', { name: 'Submit Transaction' }).first().click();
}

async function expectNoDialog(page: Parameters<typeof openApp>[0]) {
  await expect(page.locator('.modal--active')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** 1 WETH of collateral, so that Comet would lend what two partial withdrawals take beyond the supply. */
async function supplyCollateral(wallet: Wallet, fork: Fork, account: Address) {
  const deposit = await wallet.forkSend({ from: account, to: WETH, data: '0xd0e30db0', value: '0xde0b6b3a7640000' });
  await minedOnFork(fork, deposit.hash, { from: account, to: WETH });
  const approveWeth = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [COMET_USDC, 10n ** 18n] });
  await sendOnFork(wallet, fork, account, WETH, approveWeth);
  const supplyWeth = encodeFunctionData({ abi: COMET_ABI, functionName: 'supply', args: [WETH, 10n ** 18n] });
  await sendOnFork(wallet, fork, account, COMET_USDC, supplyWeth);
}

const debtOf = (fork: Fork, account: Address, blockNumber?: bigint) =>
  fork.readContract({
    address: COMET_USDC,
    abi: BORROW_ABI,
    functionName: 'borrowBalanceOf',
    args: [account],
    blockNumber,
  });

/** The holds stored in `page`'s storage. */
const storedHolds = (page: Parameters<typeof openApp>[0]) =>
  page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '[]') as unknown[], HOLDS_KEY);

/** Submits 200 USDC, which the wallet answers with a 4900: the app cannot follow the Comet request. */
async function holdFirstRequest(
  page: Parameters<typeof openApp>[0],
  wallet: Wallet,
  { account, appOrigin }: { account: Address; appOrigin: string }
) {
  const seen = new Set((await wallet.requests()).map((request) => request.id));
  await submitWithdrawal(page, '200');
  const first = await nextRequest(wallet, 'eth_sendTransaction', seen);
  const transaction = checkTransactionRequest(first, { account, appOrigin, to: COMET_USDC });
  expect(decodeFunctionData({ abi: COMET_ABI, data: transaction.data }).args).toEqual([USDC, 200_000_000n]);
  await wallet.reject(first.id, { code: 4900, message: 'The request can still complete in the wallet.' });
  await expect(page.getByText('After Transaction')).toHaveCount(0, { timeout: 60_000 });
  return { first, transaction };
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

    // Within the direct supply: one Comet withdraw(USDC, 40 USDC), and nothing from the wrapper.
    const walletBeforeWithin = await usdcBalance(fork, account);
    await submitWithdrawal(page, '40');
    const withinRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    await expectNoDialog(page);
    const withinCall = decodeFunctionData({
      abi: COMET_ABI,
      data: checkTransactionRequest(withinRequest, { account, appOrigin, to: COMET_USDC }).data,
    });
    expect(withinCall.functionName).toBe('withdraw');
    expect(withinCall.args).toEqual([USDC, WITHIN_DIRECT]);
    const withinHash = ((await wallet.approve(withinRequest.id)) as WalletRequest).result as Hash;
    const { receipt: withinReceipt } = await minedOnFork(fork, withinHash, { from: account, to: COMET_USDC });
    expect((await usdcBalance(fork, account, withinReceipt.blockNumber)) - walletBeforeWithin).toBe(WITHIN_DIRECT);
    expect(await wrapperShares(fork, account, withinReceipt.blockNumber)).toBe(sharesAtStart);
    await expect(page.getByText('After Transaction')).toHaveCount(0, { timeout: 60_000 });
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(1);
    expect(await wrapperShares(fork, account)).toBe(sharesAtStart);

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
    expect((await wallet.requests({ method: 'eth_sendTransaction' })).map((request) => request.id)).toEqual([
      withinRequest.id,
      cometRequest.id,
    ]);
    const cometHash = ((await wallet.approve(cometRequest.id)) as WalletRequest).result as Hash;
    const { receipt: cometReceipt } = await minedOnFork(fork, cometHash, { from: account, to: COMET_USDC });
    expect(await directSupply(fork, account, cometReceipt.blockNumber)).toBe(0n);
    const fromComet = (await usdcBalance(fork, account, cometReceipt.blockNumber)) - walletBefore;
    expect(fromComet).toBeGreaterThanOrEqual(DIRECT - WITHIN_DIRECT - 1n);

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
    // The wrapper's part is 300 USDC less what Comet took, paid with the fewest shares that cover it. At the
    // Comet receipt's block, before the app read the wrapper, one share fewer paid less than that part. So
    // the payout exceeds 300 USDC by less than what the burned shares paid beyond one share fewer, that is
    // the shares-to-assets rounding and the interest they earned until the exit.
    const { result: oneShareFewer } = await fork.simulateContract({
      address: WRAPPER_USDC,
      abi: WRAPPER_ABI,
      functionName: 'unwrapAndWithdraw',
      args: [burned - 1n],
      account,
      blockNumber: cometReceipt.blockNumber,
    });
    const fromWrapper = received - fromComet;
    expect(received - SPLIT).toBeLessThanOrEqual(fromWrapper - oneShareFewer);
    expect(fromWrapper - oneShareFewer).toBeLessThan(100n);
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

    // Five requests in the app's order: Comet, Comet, wrapper, Comet, wrapper. No Bulker call and no approval.
    const sends = await wallet.requests({ method: 'eth_sendTransaction' });
    expect(sends.map((request) => request.id)).toEqual([
      withinRequest.id,
      cometRequest.id,
      wrapperRequest.id,
      maxCometRequest.id,
      exitRequest.id,
    ]);
  });

  test('holds back a second Comet request after the wallet still holds the first (4900), across a change of market and back', async ({
    page,
    wallet,
    fork,
    appOrigin,
  }) => {
    test.setTimeout(240_000);
    const account = getAddress(await selectedAccount(wallet, '1000'));
    await supplyToComet(wallet, fork, account, DIRECT);
    await supplyToWrapper(wallet, fork, account, WRAPPED);
    await supplyCollateral(wallet, fork, account);

    await openApp(page);
    await connectAccount(page, wallet, account, ANCHORAGE_WALLET.label);
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });
    const seen = new Set((await wallet.requests()).map((request) => request.id));

    // 200 USDC, within the 250 USDC direct supply: one Comet withdraw(USDC, 200 USDC). The wallet answers
    // that the request can still complete, so the app cannot follow it.
    await submitWithdrawal(page, '200');
    const first = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const firstTransaction = checkTransactionRequest(first, { account, appOrigin, to: COMET_USDC });
    expect(decodeFunctionData({ abi: COMET_ABI, data: firstTransaction.data }).args).toEqual([USDC, 200_000_000n]);
    await wallet.reject(first.id, { code: 4900, message: 'The request can still complete in the wallet.' });
    await expect(page.getByText('After Transaction')).toHaveCount(0, { timeout: 60_000 });

    // USDT, then USDC again.
    const choose = async (symbol: string) => {
      await page.locator('.market-selector__selected-market').click();
      await page
        .locator('.market-selector__option')
        .filter({ has: page.getByText(symbol, { exact: true }) })
        .last()
        .click();
    };
    await choose('USDT');
    await expect(page).toHaveURL(/market=usdt-mainnet/);
    await page.getByText('Net Supply APR').first().waitFor();
    await choose('USDC');
    await expect(page).toHaveURL(/market=usdc-mainnet/);
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });

    // The same 200 USDC again: nothing reaches the wallet, and the row says why.
    await submitWithdrawal(page, '200');
    await expect(page.getByText('Earlier Request Still Pending').first()).toBeVisible({ timeout: 60_000 });
    await expectNoDialog(page);
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(1);

    // The held request executes after all, from the wallet. Comet lends nothing.
    const late = await wallet.forkSend({ from: account, to: COMET_USDC, data: firstTransaction.data });
    const { receipt: lateReceipt } = await minedOnFork(fork, late.hash, { from: account, to: COMET_USDC });
    const debt = await fork.readContract({
      address: COMET_USDC,
      abi: BORROW_ABI,
      functionName: 'borrowBalanceOf',
      args: [account],
      blockNumber: lateReceipt.blockNumber,
    });
    expect(debt).toBe(0n);
    expect(await directSupply(fork, account, lateReceipt.blockNumber)).toBeGreaterThanOrEqual(50_000_000n - 1n);
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(1);
  });

  test('pays the queued amount, not more, when the direct supply rises between queueing and signing', async ({
    page,
    wallet,
    fork,
    appOrigin,
  }) => {
    test.setTimeout(240_000);
    const account = getAddress(await selectedAccount(wallet, '1000'));
    await supplyToComet(wallet, fork, account, DIRECT);
    await supplyToWrapper(wallet, fork, account, WRAPPED);
    const sharesAtStart = await wrapperShares(fork, account);

    await openApp(page);
    await connectAccount(page, wallet, account, ANCHORAGE_WALLET.label);
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });
    const seen = new Set((await wallet.requests()).map((request) => request.id));

    // 300 USDC against the 250 USDC direct supply the dashboard read, then 150 USDC more is supplied to
    // Comet directly before Submit.
    await page.getByRole('button', { name: 'Withdraw USDC' }).click({ timeout: 60_000 });
    await page.getByRole('textbox', { name: '0' }).first().fill('300');
    await page.getByRole('button', { name: 'Add Action', exact: true }).first().click();
    await supplyToComet(wallet, fork, account, 150_000_000n);
    const before = await usdcBalance(fork, account);
    await page.getByRole('button', { name: 'Submit Transaction' }).first().click();

    // The app splits again from the 400 USDC it reads just before signing: one Comet withdraw(USDC, 300 USDC).
    const request = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const transaction = checkTransactionRequest(request, { account, appOrigin, to: COMET_USDC });
    expect(decodeFunctionData({ abi: COMET_ABI, data: transaction.data }).args).toEqual([USDC, SPLIT]);
    const hash = ((await wallet.approve(request.id)) as WalletRequest).result as Hash;
    const { receipt } = await minedOnFork(fork, hash, { from: account, to: COMET_USDC });
    await expect(page.getByText('After Transaction')).toHaveCount(0, { timeout: 60_000 });
    await expectNoDialog(page);

    // A finite Comet withdrawal pays exactly its amount, so the rounding tolerance is zero, and the wrapper
    // is asked for nothing.
    expect((await usdcBalance(fork, account, receipt.blockNumber)) - before).toBe(SPLIT);
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(1);
    expect(await wrapperShares(fork, account)).toBe(sharesAtStart);
    expect(await directSupply(fork, account, receipt.blockNumber)).toBeGreaterThanOrEqual(100_000_000n - 1n);
  });

  test('keeps the hold when another interface supplies 100 USDC and withdraws 301 USDC, until the held request itself executes', async ({
    page,
    wallet,
    fork,
    appOrigin,
  }) => {
    test.setTimeout(300_000);
    const account = getAddress(await selectedAccount(wallet, '1000'));
    // 450 USDC supplied directly when the 200 USDC request is held.
    await supplyToComet(wallet, fork, account, DIRECT + 200_000_000n);
    await supplyToWrapper(wallet, fork, account, WRAPPED);
    await supplyCollateral(wallet, fork, account);

    await openApp(page);
    await connectAccount(page, wallet, account, ANCHORAGE_WALLET.label);
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });
    const seen = new Set((await wallet.requests()).map((request) => request.id));

    await submitWithdrawal(page, '200');
    const first = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const firstTransaction = checkTransactionRequest(first, { account, appOrigin, to: COMET_USDC });
    expect(decodeFunctionData({ abi: COMET_ABI, data: firstTransaction.data }).args).toEqual([USDC, 200_000_000n]);
    await wallet.reject(first.id, { code: 4900, message: 'The request can still complete in the wallet.' });
    await expect(page.getByText('After Transaction')).toHaveCount(0, { timeout: 60_000 });

    // Another interface, from the same account: 100 USDC more, then 301 USDC out. About 249 USDC stay, so
    // the held 200 USDC request can still execute. A principal rule would have taken this for it.
    await supplyToComet(wallet, fork, account, 100_000_000n);
    const elsewhere = encodeFunctionData({ abi: COMET_ABI, functionName: 'withdraw', args: [USDC, 301_000_000n] });
    await sendOnFork(wallet, fork, account, COMET_USDC, elsewhere);
    expect(await directSupply(fork, account)).toBeGreaterThan(200_000_000n);

    await page.reload();
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });
    await submitWithdrawal(page, '200');
    await expect(page.getByText('Earlier Request Still Pending').first()).toBeVisible({ timeout: 60_000 });
    await expectNoDialog(page);
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(1);

    // The held request executes after all, from the wallet. Comet lends nothing.
    const late = await wallet.forkSend({ from: account, to: COMET_USDC, data: firstTransaction.data });
    const { receipt: lateReceipt } = await minedOnFork(fork, late.hash, { from: account, to: COMET_USDC });
    expect(await debtOf(fork, account, lateReceipt.blockNumber)).toBe(0n);

    // Its calldata is now found mined, so the hold ends and the next Comet request goes.
    await page.reload();
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });
    await submitWithdrawal(page, '30');
    const next = await nextRequest(wallet, 'eth_sendTransaction', new Set([...seen, first.id]));
    const nextTransaction = checkTransactionRequest(next, { account, appOrigin, to: COMET_USDC });
    expect(decodeFunctionData({ abi: COMET_ABI, data: nextTransaction.data }).args).toEqual([USDC, 30_000_000n]);
    const nextHash = ((await wallet.approve(next.id)) as WalletRequest).result as Hash;
    const { receipt: nextReceipt } = await minedOnFork(fork, nextHash, { from: account, to: COMET_USDC });
    expect(await debtOf(fork, account, nextReceipt.blockNumber)).toBe(0n);
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(2);
  });

  test('asks the wallet once when a second tab submits while the first is between its estimate and the wallet', async ({
    page,
    context,
    wallet,
    fork,
    appOrigin,
  }) => {
    test.setTimeout(300_000);
    const account = getAddress(await selectedAccount(wallet, '1000'));
    await supplyToComet(wallet, fork, account, DIRECT);
    await supplyToWrapper(wallet, fork, account, WRAPPED);
    await supplyCollateral(wallet, fork, account);

    await openApp(page);
    await connectAccount(page, wallet, account, ANCHORAGE_WALLET.label);
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });
    const seen = new Set((await wallet.requests()).map((request) => request.id));

    // The first tab's fresh read of the direct supply, just before it would ask the wallet, waits until
    // the test lets it go.
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => (release = resolve));
    const isReached = new Promise<void>((resolve) => (reached = resolve));
    const freshRead = encodeFunctionData({ abi: COMET_ABI, functionName: 'balanceOf', args: [account] }).toLowerCase();
    let isGated = false;
    await page.route('**/*', async (route) => {
      let body: { method?: string; params?: [{ to?: string; data?: string }] } | undefined;
      try {
        body = route.request().postDataJSON();
      } catch {
        body = undefined;
      }
      const call = body?.method === 'eth_call' ? body.params?.[0] : undefined;
      if (!isGated && call?.to?.toLowerCase() === COMET_USDC.toLowerCase() && call.data?.toLowerCase() === freshRead) {
        isGated = true;
        reached();
        await paused;
      }
      await route.fallback();
    });
    await submitWithdrawal(page, '200');
    await isReached;

    // A second tab opens, restores what storage holds, and submits the same 200 USDC.
    const second = await context.newPage();
    await second.goto(page.url());
    await expect(notice(second)).toBeVisible({ timeout: 60_000 });
    await submitWithdrawal(second, '200');
    await expect(second.getByText('Earlier Request Still Pending').first()).toBeVisible({ timeout: 60_000 });
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(0);

    // The first tab goes on, and its request is the only one.
    release();
    const request = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const transaction = checkTransactionRequest(request, { account, appOrigin, to: COMET_USDC });
    expect(decodeFunctionData({ abi: COMET_ABI, data: transaction.data }).args).toEqual([USDC, 200_000_000n]);
    const hash = ((await wallet.approve(request.id)) as WalletRequest).result as Hash;
    const { receipt } = await minedOnFork(fork, hash, { from: account, to: COMET_USDC });
    expect(await debtOf(fork, account, receipt.blockNumber)).toBe(0n);
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(1);
    await second.close();
  });
  test('refuses a second Comet request from the same account through a standard-route wallet while the holds cannot be read', async ({
    page,
    browser,
    manifest,
    appOrigin,
    blocked,
    wallet,
    fork,
  }) => {
    test.setTimeout(300_000);
    const account = getAddress(await selectedAccount(wallet, '1000'));
    await supplyToComet(wallet, fork, account, DIRECT);
    await supplyToWrapper(wallet, fork, account, WRAPPED);
    await supplyCollateral(wallet, fork, account);

    await openApp(page);
    await connectAccount(page, wallet, account, ANCHORAGE_WALLET.label);
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });
    const { transaction: firstTransaction } = await holdFirstRequest(page, wallet, { account, appOrigin });
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), HOLDS_KEY);
    expect(stored).not.toBeNull();

    // The same account through a standard-route wallet, in a browser that has the hold, then cannot read it.
    const standard = await harnessContext(browser, {
      manifest,
      appOrigin,
      wallet,
      blocked,
      harnessWallet: METAMASK_WALLET,
    });
    try {
      await standard.addInitScript(
        ([key, value]) => window.localStorage.setItem(key, value),
        [HOLDS_KEY, stored ?? '']
      );
      const other = await standard.newPage();
      await openApp(other);
      await connectAccount(other, wallet, account, METAMASK_WALLET.label);
      await other.evaluate((key) => {
        const read = Storage.prototype.getItem;
        Storage.prototype.getItem = function (this: Storage, name: string) {
          if (name === key) throw new DOMException('The hold key cannot be read.', 'SecurityError');
          return read.call(this, name);
        };
      }, HOLDS_KEY);

      // Another 200 USDC from the standard route: nothing reaches the wallet.
      await submitWithdrawal(other, '200');
      await expectNoDialog(other);
      // The refused write would ask the wallet within this time; nothing positive marks the refusal.
      await other.waitForTimeout(5_000);
      expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(1);
    } finally {
      await standard.close();
    }

    // The held request executes after all, from the wallet. Comet lends nothing.
    const late = await wallet.forkSend({ from: account, to: COMET_USDC, data: firstTransaction.data });
    const { receipt: lateReceipt } = await minedOnFork(fork, late.hash, { from: account, to: COMET_USDC });
    expect(await debtOf(fork, account, lateReceipt.blockNumber)).toBe(0n);
  });

  test('keeps the hold when a reorg returns the held request to pending, and ends it once the request is mined again', async ({
    page,
    wallet,
    fork,
    appOrigin,
  }) => {
    test.setTimeout(300_000);
    const account = getAddress(await selectedAccount(wallet, '1000'));
    await supplyToComet(wallet, fork, account, DIRECT);
    await supplyToWrapper(wallet, fork, account, WRAPPED);
    await supplyCollateral(wallet, fork, account);

    await openApp(page);
    await connectAccount(page, wallet, account, ANCHORAGE_WALLET.label);
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });
    const { first, transaction: firstTransaction } = await holdFirstRequest(page, wallet, { account, appOrigin });

    // The held request is mined, and the app finds its Withdraw log. When the app reads the transaction, a
    // reorg removes its block, and the node answers with the transaction pending again. The route is in
    // place before the request is mined, so that no earlier look of the open page finds it.
    // anvil's own methods, which the public client does not type.
    const forkRpc = (method: string, params: unknown[] = []) =>
      (fork.request as unknown as (call: { method: string; params: unknown[] }) => Promise<unknown>)({
        method,
        params,
      });
    const snapshot = await forkRpc('evm_snapshot');
    const late: { hash?: string } = {};
    let isClaimed = false;
    let isReorged = false;
    // The reorg waits until the test has seen the request mined.
    let seenMined: () => void = () => undefined;
    const isSeenMined = new Promise<void>((resolve) => (seenMined = resolve));
    await page.route('**/*', async (route) => {
      let body: { id?: number; method?: string; params?: [string] } | undefined;
      try {
        body = route.request().postDataJSON();
      } catch {
        body = undefined;
      }
      if (
        !isClaimed &&
        late.hash !== undefined &&
        body?.method === 'eth_getTransactionByHash' &&
        body.params?.[0]?.toLowerCase() === late.hash.toLowerCase()
      ) {
        isClaimed = true;
        await isSeenMined;
        const mined = (await forkRpc('eth_getTransactionByHash', [late.hash])) as object;
        expect(await forkRpc('evm_revert', [snapshot])).toBe(true);
        await forkRpc('evm_mine');
        isReorged = true;
        const pending = { ...mined, blockHash: null, blockNumber: null, transactionIndex: null };
        await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: pending } });
        return;
      }
      await route.fallback();
    });
    const mined = await wallet.forkSend({ from: account, to: COMET_USDC, data: firstTransaction.data });
    late.hash = mined.hash;
    await minedOnFork(fork, mined.hash, { from: account, to: COMET_USDC });
    seenMined();

    // A reload looks at the hold, and meets the reorg.
    await page.reload();
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => isReorged, { timeout: 60_000 }).toBe(true);

    // The same 200 USDC again: the hold stays, and nothing reaches the wallet.
    await submitWithdrawal(page, '200');
    await expect(page.getByText('Earlier Request Still Pending').first()).toBeVisible({ timeout: 60_000 });
    await expectNoDialog(page);
    expect(await storedHolds(page)).toHaveLength(1);
    expect(await wallet.requests({ method: 'eth_sendTransaction' })).toHaveLength(1);

    // The held request is mined again, after the reorg. Comet lends nothing, and the next look, which
    // reads the block of the earlier log again, ends the hold.
    const again = await wallet.forkSend({ from: account, to: COMET_USDC, data: firstTransaction.data });
    const { receipt } = await minedOnFork(fork, again.hash, { from: account, to: COMET_USDC });
    expect(await debtOf(fork, account, receipt.blockNumber)).toBe(0n);
    await page.reload();
    await expect(notice(page)).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => storedHolds(page), { timeout: 60_000 }).toHaveLength(0);
    expect((await wallet.requests({ method: 'eth_sendTransaction' })).map((request) => request.id)).toEqual([first.id]);
  });
});

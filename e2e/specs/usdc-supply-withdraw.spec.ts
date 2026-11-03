// AC3, AC4, AC8: the Ethereum USDC flow through the app UI (approve, supply, withdraw), with each wallet
// request checked before it is approved, and the fork's state checked after it is mined.
//
// Raw-unit tolerances. USDC balances and the allowance are exact (tolerance 0). Comet's principal and
// balance are checked exactly (tolerance 0) against values derived from the supply index of the block that
// mined each action, with Comet's own rounding (`contracts.ts`), not against the nominal amount: a supply
// of 100 USDC can read back as 99.999999 USDC. The wallet mines each block exactly 12 s after the last, so
// the indices, and so the expected values, are the same on every run at the pinned block.
import { decodeFunctionData, getAddress, type Address, type Hash } from 'viem';

import {
  COMET_ABI,
  COMET_USDC,
  ERC20_ABI,
  MAX_UINT256,
  presentValueOf,
  principalAfterSupply,
  principalAfterWithdraw,
  USDC,
} from '../harness/contracts';
import { connectAccount, expect, nextRequest, openApp, selectedAccount, test } from '../harness/fixtures';
import { rpc, UPSTREAM_METHODS } from '../harness/fork';
import { cometAt, minedOnFork, usdcAllowance, usdcBalance } from '../harness/forkState';
import { APP_READ_METHODS } from '../harness/rpcProxy';
import type { WalletRequest } from '../harness/walletServer';

/** Comet's raw-unit tolerance against the derived oracle: none, as the derivation follows Comet's rounding. */
const COMET_TOLERANCE = 0n;
const USDC_TOLERANCE = 0n;
const SUPPLY = 100_000_000n;
const WITHDRAW = 40_000_000n;
const FUNDED = 1_000_000_000n;

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

const within = (actual: bigint, expected: bigint, tolerance: bigint) => {
  const difference = actual > expected ? actual - expected : expected - actual;
  expect(difference, `${actual} is within ${tolerance} raw units of ${expected}`).toBeLessThanOrEqual(tolerance);
};

test.describe('Ethereum USDC through the app UI', { tag: ['@AC3', '@AC4', '@AC8'] }, () => {
  test('approves, supplies and withdraws, with each request and the fork state checked', async ({
    page,
    wallet,
    fork,
    appOrigin,
    manifest,
  }) => {
    const account = getAddress(await selectedAccount(wallet, '1000'));
    // The spender and token come from the fork too, not only from constants.
    expect(
      getAddress(await fork.readContract({ address: COMET_USDC, abi: COMET_ABI, functionName: 'baseToken' }))
    ).toBe(USDC);
    expect(await usdcBalance(fork, account)).toBe(FUNDED);
    expect(await usdcAllowance(fork, account)).toBe(0n);
    await openApp(page);
    await connectAccount(page, wallet, account);
    const seen = new Set((await wallet.requests()).map((request) => request.id));

    // Approve: "Enable USDC" for cUSDCv3.
    await page.getByRole('button', { name: 'Supply USDC' }).click();
    await page.getByRole('textbox', { name: '0' }).fill('100');
    await page.getByRole('button', { name: 'Approve & Add' }).click();
    const approveRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const approveTransaction = checkTransactionRequest(approveRequest, { account, appOrigin, to: USDC });
    const approveCall = decodeFunctionData({ abi: ERC20_ABI, data: approveTransaction.data });
    expect(approveCall.functionName).toBe('approve');
    expect(approveCall.args).toEqual([COMET_USDC, MAX_UINT256]);
    const approved = await wallet.approve(approveRequest.id);
    const approveHash = (approved as WalletRequest).result as Hash;
    const { receipt: approveReceipt } = await minedOnFork(fork, approveHash, { from: account, to: USDC });
    expect(await usdcAllowance(fork, account, approveReceipt.blockNumber)).toBe(MAX_UINT256);
    within(await usdcBalance(fork, account, approveReceipt.blockNumber), FUNDED, USDC_TOLERANCE);

    // Supply 100 USDC.
    await page.getByRole('button', { name: 'Submit Transaction' }).click();
    const supplyRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const supplyTransaction = checkTransactionRequest(supplyRequest, { account, appOrigin, to: COMET_USDC });
    const supplyCall = decodeFunctionData({ abi: COMET_ABI, data: supplyTransaction.data });
    expect(supplyCall.functionName).toBe('supply');
    expect(supplyCall.args).toEqual([USDC, SUPPLY]);
    const supplied = (await wallet.approve(supplyRequest.id)) as WalletRequest;
    const supplyHash = supplied.result as Hash;
    const { receipt: supplyReceipt, block: supplyBlock } = await minedOnFork(fork, supplyHash, {
      from: account,
      to: COMET_USDC,
    });
    const afterSupply = await cometAt(fork, account, supplyReceipt.blockNumber);
    expect(afterSupply.lastAccrualTime).toBe(supplyBlock.timestamp);
    const expectedPrincipal = principalAfterSupply(0n, SUPPLY, afterSupply.supplyIndex);
    within(afterSupply.principal, expectedPrincipal, COMET_TOLERANCE);
    within(afterSupply.balance, presentValueOf(expectedPrincipal, afterSupply.supplyIndex), COMET_TOLERANCE);
    // FiatToken spends the allowance even when it is the maximum.
    expect(await usdcAllowance(fork, account, supplyReceipt.blockNumber)).toBe(MAX_UINT256 - SUPPLY);
    within(await usdcBalance(fork, account, supplyReceipt.blockNumber), FUNDED - SUPPLY, USDC_TOLERANCE);
    // The UI shows the position from the fork: 99.999999 USDC, shown to four places.
    await expect(page.getByRole('paragraph').filter({ hasText: /^Supplying$/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: /^100\s*\.0000$/ })).toBeVisible({
      timeout: 60_000,
    });

    // Withdraw 40 USDC.
    await page.getByRole('button', { name: 'Withdraw USDC' }).click();
    await page.getByRole('textbox', { name: '0' }).fill('40');
    await page.getByRole('button', { name: 'Add Action' }).click();
    await page.getByRole('button', { name: 'Submit Transaction' }).click();
    const withdrawRequest = await nextRequest(wallet, 'eth_sendTransaction', seen);
    const withdrawTransaction = checkTransactionRequest(withdrawRequest, { account, appOrigin, to: COMET_USDC });
    const withdrawCall = decodeFunctionData({ abi: COMET_ABI, data: withdrawTransaction.data });
    expect(withdrawCall.functionName).toBe('withdraw');
    expect(withdrawCall.args).toEqual([USDC, WITHDRAW]);
    const withdrawn = (await wallet.approve(withdrawRequest.id)) as WalletRequest;
    const withdrawHash = withdrawn.result as Hash;
    const { receipt: withdrawReceipt, block: withdrawBlock } = await minedOnFork(fork, withdrawHash, {
      from: account,
      to: COMET_USDC,
    });
    const afterWithdraw = await cometAt(fork, account, withdrawReceipt.blockNumber);
    expect(afterWithdraw.lastAccrualTime).toBe(withdrawBlock.timestamp);
    const expectedAfterWithdraw = principalAfterWithdraw(afterSupply.principal, WITHDRAW, afterWithdraw.supplyIndex);
    within(afterWithdraw.principal, expectedAfterWithdraw, COMET_TOLERANCE);
    within(afterWithdraw.balance, presentValueOf(expectedAfterWithdraw, afterWithdraw.supplyIndex), COMET_TOLERANCE);
    expect(await usdcAllowance(fork, account, withdrawReceipt.blockNumber)).toBe(MAX_UINT256 - SUPPLY);
    within(await usdcBalance(fork, account, withdrawReceipt.blockNumber), FUNDED - SUPPLY + WITHDRAW, USDC_TOLERANCE);
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: /^60\s*\.0000$/ })).toBeVisible({
      timeout: 60_000,
    });

    // Exactly three transactions were asked for, and each was mined on the fork from the account.
    const sends = (await wallet.requests({ method: 'eth_sendTransaction' })).map((request) => request.id);
    expect(sends).toEqual([approveRequest.id, supplyRequest.id, withdrawRequest.id]);
    await testInfoAttach({ approveHash, supplyHash, withdrawHash, afterSupply, afterWithdraw });

    // AC8: nothing but reads left the browser for the fork or the upstream, and the upstream never saw the
    // supply. The upstream read is supporting evidence: the stronger argument is the refusals and the
    // impersonated, never-signed sends.
    const stats = (await wallet.stats()) as {
      rpcProxy: { forwarded: Record<string, number> };
      upstream: { methods: Record<string, number> };
    };
    for (const method of Object.keys(stats.rpcProxy.forwarded)) expect(APP_READ_METHODS.has(method), method).toBe(true);
    for (const method of Object.keys(stats.upstream.methods)) expect(UPSTREAM_METHODS.has(method), method).toBe(true);
    expect(await rpc(manifest.fork.upstreamProxyUrl, 'eth_getTransactionByHash', [supplyHash])).toBeNull();
  });
});

async function testInfoAttach(values: Record<string, unknown>) {
  await test.info().attach('fork-results.json', {
    body: JSON.stringify(values, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2),
    contentType: 'application/json',
  });
}

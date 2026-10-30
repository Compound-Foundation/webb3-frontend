// AC3, AC4: an existing position held by an address with no key, set up by impersonation on the fork, then
// partly withdrawn through the app UI. Impersonation sends transactions but cannot sign messages.
import { randomBytes } from 'node:crypto';

import { decodeFunctionData, encodeFunctionData, getAddress, type Hash } from 'viem';

import {
  COMET_ABI,
  COMET_USDC,
  ERC20_ABI,
  presentValueOf,
  principalAfterSupply,
  principalAfterWithdraw,
  USDC,
} from '../harness/contracts';
import { connectAccount, expect, nextRequest, openApp, providerRequest, test } from '../harness/fixtures';
import { cometAt, minedOnFork, usdcBalance } from '../harness/forkState';
import type { WalletRequest } from '../harness/walletServer';

const EXISTING = 250_000_000n;
const WITHDRAW = 50_000_000n;

test.describe('an existing position on an impersonated address', { tag: ['@AC3', '@AC4'] }, () => {
  test('shows the position from the fork, withdraws part of it, and cannot sign a message', async ({
    page,
    wallet,
    fork,
    appOrigin,
  }) => {
    // A fresh address that no key in this run controls.
    const holder = getAddress(`0x${randomBytes(20).toString('hex')}`);
    await wallet.impersonate(holder, { eth: '1', usdc: '300' });
    const approve = await wallet.forkSend({
      from: holder,
      to: USDC,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [COMET_USDC, EXISTING] }),
    });
    await minedOnFork(fork, approve.hash, { from: holder, to: USDC });
    const supply = await wallet.forkSend({
      from: holder,
      to: COMET_USDC,
      data: encodeFunctionData({ abi: COMET_ABI, functionName: 'supply', args: [USDC, EXISTING] }),
    });
    const { receipt: supplyReceipt } = await minedOnFork(fork, supply.hash, { from: holder, to: COMET_USDC });
    const existing = await cometAt(fork, holder, supplyReceipt.blockNumber);
    expect(existing.principal).toBe(principalAfterSupply(0n, EXISTING, existing.supplyIndex));
    expect(await usdcBalance(fork, holder)).toBe(50_000_000n);

    await wallet.select(holder);
    await openApp(page);
    await connectAccount(page, wallet, holder);
    await expect(page.getByRole('heading', { level: 1 }).filter({ hasText: /^250\s*\.0000$/ })).toBeVisible({
      timeout: 60_000,
    });

    await page.getByRole('button', { name: 'Withdraw USDC' }).click();
    await page.getByRole('textbox', { name: '0' }).fill('50');
    await page.getByRole('button', { name: 'Add Action' }).click();
    await page.getByRole('button', { name: 'Submit Transaction' }).click();
    const request = await nextRequest(wallet, 'eth_sendTransaction');
    expect(request.origin).toBe(appOrigin);
    expect(request.chainIdAtRequest).toBe(1);
    const [transaction] = request.params as [{ from: string; to: string; data: `0x${string}`; value?: string }];
    expect(getAddress(transaction.from)).toBe(holder);
    expect(getAddress(transaction.to)).toBe(COMET_USDC);
    expect(BigInt(transaction.value ?? '0x0')).toBe(0n);
    const call = decodeFunctionData({ abi: COMET_ABI, data: transaction.data });
    expect(call.functionName).toBe('withdraw');
    expect(call.args).toEqual([USDC, WITHDRAW]);
    const approved = (await wallet.approve(request.id)) as WalletRequest;
    const { receipt } = await minedOnFork(fork, approved.result as Hash, { from: holder, to: COMET_USDC });
    const after = await cometAt(fork, holder, receipt.blockNumber);
    const expected = principalAfterWithdraw(existing.principal, WITHDRAW, after.supplyIndex);
    expect(after.principal).toBe(expected);
    expect(after.balance).toBe(presentValueOf(expected, after.supplyIndex));
    expect(await usdcBalance(fork, holder, receipt.blockNumber)).toBe(100_000_000n);

    const signature = await providerRequest(page, 'personal_sign', ['an impersonated account', holder]);
    expect(signature.error?.code).toBe(4200);
  });
});

// AC6: deterministic wallet behaviour: rejection with 4001, pending and delayed requests, account and chain
// changes, chain-switch outcomes including 4902, and disconnects.
//
// Chain switches: the app calls wagmi's `switchChain` mutation, which does not reject to its caller, so the
// app's own `catch` branches for 4902, 4001 and -32002 in `switchWriteNetwork` do not run. wagmi's injected
// connector handles 4902 itself: it sends `wallet_addEthereumChain` with the chain's configured RPC URL,
// then reads `eth_chainId` and expects the new chain. These tests assert that observed sequence, and do not
// claim coverage of the app's catch branches.
import type { Page } from '@playwright/test';
import { getAddress } from 'viem';

import { USDC } from '../harness/contracts';
import {
  connectAccount,
  expect,
  headerAccount,
  headerConnect,
  nextRequest,
  openApp,
  selectedAccount,
  storedConnector,
  test,
} from '../harness/fixtures';
import { usdcAllowance } from '../harness/forkState';
import type { WalletRequest } from '../harness/walletServer';

const pendingBadge = (page: Page) => page.getByRole('banner').getByText(/\d+ Pending/);

async function startSupply(page: Page, amount: string) {
  await expect(async () => {
    await page.getByRole('button', { name: 'Supply USDC' }).click();
    await expect(page.getByRole('textbox', { name: '0' })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole('textbox', { name: '0' }).fill(amount);
}

async function connected(page: Page, wallet: Parameters<typeof connectAccount>[1], usdc = '1000') {
  const account = getAddress(await selectedAccount(wallet, usdc));
  await openApp(page);
  await connectAccount(page, wallet, account);
  return account;
}

const sends = async (wallet: Parameters<typeof connectAccount>[1]) =>
  wallet.requests({ method: 'eth_sendTransaction' });

test.describe('wallet requests and events', { tag: ['@AC6'] }, () => {
  test('4001 on the approval leaves the app out of its pending state and the allowance unchanged', async ({
    page,
    wallet,
    fork,
  }) => {
    const account = await connected(page, wallet);
    await startSupply(page, '100');
    await page.getByRole('button', { name: 'Approve & Add' }).click();
    const request = await nextRequest(wallet, 'eth_sendTransaction');
    await expect(pendingBadge(page)).toBeVisible();
    await wallet.reject(request.id, { code: 4001 });
    await expect(pendingBadge(page)).toHaveCount(0);
    expect((await wallet.getRequest(request.id)).status).toBe('rejected');
    expect(await usdcAllowance(fork, account)).toBe(0n);
    // The app stays connected, and keeps the supply as a queued action to submit or edit.
    await expect(headerAccount(page, account)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Supply 100.0000 USDC' })).toBeVisible();
    expect(await sends(wallet)).toHaveLength(1);
  });

  test('a pending request holds the app in its wallet-confirmation state, and blocks a second submit, until approved', async ({
    page,
    wallet,
    fork,
  }) => {
    const account = await connected(page, wallet);
    await startSupply(page, '100');
    await page.getByRole('button', { name: 'Approve & Add' }).click();
    await wallet.approve((await nextRequest(wallet, 'eth_sendTransaction')).id);
    await expect(pendingBadge(page)).toHaveCount(0, { timeout: 60_000 });
    await page.getByRole('button', { name: 'Submit Transaction' }).click();
    const supply = await wallet.waitForRequest({ method: 'eth_sendTransaction' });
    await expect(pendingBadge(page)).toBeVisible();
    await page.waitForTimeout(2_000);
    // A second submit while the first waits in the wallet: whatever the control shows, no second request.
    const submit = page.getByRole('button', { name: /Submit/ }).first();
    const outcome = await submit.click({ timeout: 2_000 }).then(
      () => 'clicked',
      () => 'not clickable (gone or disabled)'
    );
    test.info().annotations.push({ type: 'attempted action', description: `second submit: ${outcome}` });
    await page.waitForTimeout(1_000);
    expect((await sends(wallet)).map((request) => [request.id, request.status]).slice(1)).toEqual([
      [supply.id, 'pending'],
    ]);
    await wallet.approve(supply.id);
    await expect(pendingBadge(page)).toHaveCount(0, { timeout: 60_000 });
    expect(await usdcAllowance(fork, account)).toBeLessThan(2n ** 256n - 1n);
  });

  test('a delayed approval resolves after its delay, and the app stays pending until then', async ({
    page,
    wallet,
  }) => {
    await connected(page, wallet);
    await startSupply(page, '100');
    await page.getByRole('button', { name: 'Approve & Add' }).click();
    const request = await nextRequest(wallet, 'eth_sendTransaction');
    const decidedAt = Date.now();
    await wallet.approve(request.id, { delayMs: 5_000 });
    expect((await wallet.getRequest(request.id)).scheduled?.decision).toBe('approve');
    await page.waitForTimeout(3_000);
    expect((await wallet.getRequest(request.id)).status).toBe('pending');
    await expect(pendingBadge(page)).toBeVisible();
    await expect.poll(async () => (await wallet.getRequest(request.id)).status, { timeout: 15_000 }).toBe('approved');
    const settled = await wallet.getRequest(request.id);
    expect(Date.parse(settled.respondedAt as string) - decidedAt).toBeGreaterThanOrEqual(5_000);
    await expect(pendingBadge(page)).toHaveCount(0, { timeout: 60_000 });
  });

  test('an account change to another allowed account is screened, shown, and used for the next request', async ({
    page,
    wallet,
    appOrigin,
  }) => {
    const first = await connected(page, wallet);
    const second = getAddress((await wallet.newAccount({ usdc: '1000' })).address);
    await wallet.select(second);
    await expect(headerAccount(page, second)).toBeVisible();
    await expect(headerAccount(page, first)).toHaveCount(0);
    expect((await wallet.screeningLog()).map((entry) => entry.address)).toEqual([
      first.toLowerCase(),
      second.toLowerCase(),
    ]);
    await startSupply(page, '100');
    await page.getByRole('button', { name: 'Approve & Add' }).click();
    const request = await nextRequest(wallet, 'eth_sendTransaction');
    expect(request.origin).toBe(appOrigin);
    expect(getAddress((request.params as [{ from: string }])[0].from)).toBe(second);
    expect(getAddress((request.params as [{ to: string }])[0].to)).toBe(USDC);
    await wallet.reject(request.id);
  });

  test('a chain change from the wallet stops writes until the switch back is approved', async ({
    page,
    wallet,
    appOrigin,
  }) => {
    await connected(page, wallet);
    await wallet.setChain(8453);
    await startSupply(page, '100');
    await page.getByRole('button', { name: 'Approve & Add' }).click();
    await expect(page.getByText('connected to the Base network')).toBeVisible();
    await page.getByRole('button', { name: 'Switch Network' }).click();
    const switchRequest = await nextRequest(wallet, 'wallet_switchEthereumChain');
    expect(switchRequest.origin).toBe(appOrigin);
    expect(switchRequest.chainIdAtRequest).toBe(8453);
    expect(switchRequest.params).toEqual([{ chainId: '0x1' }]);
    expect(await sends(wallet)).toEqual([]);
    await wallet.approve(switchRequest.id);
    await expect.poll(async () => (await wallet.state()).chainId).toBe(1);
    await expect(page.getByText('connected to the Base network')).toHaveCount(0);
    await startSupply(page, '100');
    await page.getByRole('button', { name: 'Approve & Add' }).click();
    const send = await nextRequest(wallet, 'eth_sendTransaction');
    expect(send.chainIdAtRequest).toBe(1);
    await wallet.reject(send.id);
  });

  test('4902: the connector adds Ethereum after the switch fails, and the switch completes', async ({
    page,
    wallet,
    manifest,
  }) => {
    await connected(page, wallet);
    await wallet.setChain(8453);
    await wallet.setKnownChains([8453]);
    await startSupply(page, '100');
    await page.getByRole('button', { name: 'Approve & Add' }).click();
    await page.getByRole('button', { name: 'Switch Network' }).click();
    const switchRequest = await nextRequest(wallet, 'wallet_switchEthereumChain');
    const switched = (await wallet.approve(switchRequest.id)) as WalletRequest;
    expect(switched.status).toBe('failed');
    expect(switched.error?.code).toBe(4902);
    const add = await nextRequest(wallet, 'wallet_addEthereumChain');
    const [parameter] = add.params as [{ chainId: string; chainName: string; rpcUrls: string[] }];
    expect(parameter.chainId).toBe('0x1');
    expect(parameter.chainName).toBe('Ethereum');
    // The connector's chain configuration, not the app's `walletRpcUrls`: the connector, not the app's catch
    // branch, added the chain.
    expect(parameter.rpcUrls).toEqual([`${manifest.services.rpcProxy}/ethereum-mainnet`]);
    await wallet.approve(add.id);
    const state = await wallet.state();
    expect(state.chainId).toBe(1);
    expect(state.knownChains).toContain(1);
    expect((await wallet.requests()).map((request) => [request.method, request.status])).toEqual([
      ['wallet_requestPermissions', 'approved'],
      ['wallet_switchEthereumChain', 'failed'],
      ['wallet_addEthereumChain', 'approved'],
    ]);
    await expect(page.getByText('connected to the Base network')).toHaveCount(0);
  });

  for (const code of [4001, -32002]) {
    test(`${code} on a switch leaves the wallet on the other chain and sends nothing`, async ({ page, wallet }) => {
      const account = await connected(page, wallet);
      await wallet.setChain(8453);
      await startSupply(page, '100');
      await page.getByRole('button', { name: 'Approve & Add' }).click();
      await page.getByRole('button', { name: 'Switch Network' }).click();
      const switchRequest = await nextRequest(wallet, 'wallet_switchEthereumChain');
      await wallet.reject(switchRequest.id, { code });
      expect((await wallet.getRequest(switchRequest.id)).error?.code).toBe(code);
      await page.waitForTimeout(2_000);
      expect((await wallet.state()).chainId).toBe(8453);
      expect(await sends(wallet)).toEqual([]);
      expect((await wallet.requests({ method: 'wallet_addEthereumChain' })).length).toBe(0);
      await expect(headerAccount(page, account)).toBeVisible();
    });
  }

  test('a disconnect event from the wallet disconnects the app, and nothing more reaches the wallet', async ({
    page,
    wallet,
  }) => {
    await connected(page, wallet);
    const before = (await wallet.requests()).length;
    await wallet.disconnect();
    await expect(headerConnect(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Supply USDC' })).toBeDisabled();
    await page.waitForTimeout(1_000);
    expect((await wallet.requests()).length).toBe(before);
    expect((await wallet.state()).permittedOrigin).toBeNull();
  });

  test('disconnecting from the app UI revokes the permission in the wallet', async ({ page, wallet, appOrigin }) => {
    const account = await connected(page, wallet);
    await headerAccount(page, account).click();
    await page.getByRole('button', { name: 'Disconnect Wallet' }).click();
    await expect(headerConnect(page)).toBeVisible();
    await expect
      .poll(async () => (await wallet.calls()).map((call) => [call.method, call.origin]))
      .toEqual([['wallet_revokePermissions', appOrigin]]);
    expect((await wallet.state()).permittedOrigin).toBeNull();
    expect(await storedConnector(page)).toBeNull();
  });
});

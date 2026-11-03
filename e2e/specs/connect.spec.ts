// AC2: a clean browser profile discovers the injected wallet through the app's existing wallet list and
// connects through the app UI.
import {
  expect,
  headerAccount,
  headerConnect,
  openApp,
  providerRequest,
  selectedAccount,
  storedConnector,
  test,
} from '../harness/fixtures';

test.describe('wallet discovery and connection', { tag: ['@AC2'] }, () => {
  test('a clean profile lists the injected wallet once, as MetaMask, from EIP-6963 discovery', async ({
    page,
    context,
  }) => {
    // A fresh context: no cookies and no stored origin state, so no remembered connector.
    expect(await context.storageState()).toEqual({ cookies: [], origins: [] });
    await openApp(page);
    // The harness sets no window.ethereum, so the app's list comes from the announcement alone.
    expect(await page.evaluate(() => 'ethereum' in window)).toBe(false);
    await headerConnect(page).click();
    await expect(page.getByText('MetaMask', { exact: true })).toHaveCount(1);
    await expect(page.getByText('MetaMask (harness)')).toHaveCount(0);
    await expect(page.getByText('No browser wallet detected')).toHaveCount(0);
    await expect(page.getByText('Browser Wallet', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/hidden for your safety/)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Connect Wallet' })).toBeVisible();
  });

  test('connects through the UI with the permission request the connector sends first', async ({
    page,
    wallet,
    appOrigin,
  }) => {
    const address = await selectedAccount(wallet);
    await openApp(page);
    await headerConnect(page).click();
    await page.getByText('MetaMask', { exact: true }).click();
    const request = await wallet.waitForRequest({ method: 'wallet_requestPermissions' });
    expect(request.origin).toBe(appOrigin);
    expect(request.params).toEqual([{ eth_accounts: {} }]);
    expect(request.chainIdAtRequest).toBe(1);
    await wallet.approve(request.id);
    await expect(headerAccount(page, address)).toBeVisible();
    // The connector took the accounts from the permission's caveat and `eth_accounts`, so it never called
    // `eth_requestAccounts`, which the wallet would answer at once, without queueing it.
    expect((await wallet.requests()).map((each) => each.method)).toEqual(['wallet_requestPermissions']);
    const methods = (await wallet.providerCalls()).map((call) => call.method);
    expect(methods).toContain('wallet_requestPermissions');
    expect(methods).toContain('eth_accounts');
    expect(methods).not.toContain('eth_requestAccounts');
    const approved = await wallet.getRequest(request.id);
    expect(approved.result).toEqual([
      expect.objectContaining({
        parentCapability: 'eth_accounts',
        invoker: appOrigin,
        caveats: [{ type: 'restrictReturnedAccounts', value: [address.toLowerCase()] }],
      }),
    ]);
    expect(await storedConnector(page)).toBe('io.metamask');
    const screened = await wallet.screeningLog();
    expect(screened).toEqual([
      expect.objectContaining({ address: address.toLowerCase(), origin: appOrigin, outcome: 'answered' }),
    ]);
    // A re-announcement on request keeps the same uuid, so the app raises no conflict and keeps the session.
    await page.evaluate(() => window.dispatchEvent(new Event('eip6963:requestProvider')));
    await page.waitForTimeout(500);
    await expect(headerAccount(page, address)).toBeVisible();
    expect(await providerRequest(page, 'eth_accounts')).toEqual({ result: [address.toLowerCase()] });
  });

  test('a rejected permission request leaves the app disconnected and stores no connector', async ({
    page,
    wallet,
  }) => {
    await selectedAccount(wallet);
    await openApp(page);
    await headerConnect(page).click();
    await page.getByText('MetaMask', { exact: true }).click();
    const request = await wallet.waitForRequest({ method: 'wallet_requestPermissions' });
    await wallet.reject(request.id, { code: 4001 });
    await expect(headerConnect(page)).toBeVisible();
    expect(await storedConnector(page)).toBeNull();
    expect(await wallet.screeningLog()).toEqual([]);
    expect((await wallet.getRequest(request.id)).status).toBe('rejected');
  });
});

// AC5: message and typed-data signing. Each signature is recovered with ethers v5, a different library from
// the viem signer in the wallet, and must give the account's address.
//
// Coverage: the app has one flow that signs, the extension bridge (`src/pages/extensions/helpers/handler.ts`),
// which forwards an extension frame's `personal_sign` and `eth_signTypedData_v4` to the connected wallet.
// The harness's test extension drives it. The other cases call the injected provider directly from the app
// page, as a fixture: the 4001 rejection, the chain check, hex and UTF-8 messages, and account checks.
import { utils } from 'ethers';
import { getAddress } from 'viem';

import { EXTENSION_MESSAGE, HARNESS_TYPED_DATA } from '../harness/extensionPage';
import {
  connectAccount,
  expect,
  headerAccount,
  openApp,
  providerRequest,
  selectedAccount,
  signingCalls,
  signingRequests,
  test,
} from '../harness/fixtures';
import type { WalletRequest } from '../harness/walletServer';

const { EIP712Domain: _domainType, ...TYPES } = HARNESS_TYPED_DATA.types;
void _domainType;

const recoverTyped = (signature: string, data: { domain: object; message: object } = HARNESS_TYPED_DATA) =>
  utils.verifyTypedData(
    data.domain,
    TYPES as unknown as Record<string, { name: string; type: string }[]>,
    data.message,
    signature
  );

test.describe('signing', { tag: ['@AC5'] }, () => {
  test('app flow: the extension bridge forwards personal_sign and eth_signTypedData_v4 to the wallet', async ({
    page,
    wallet,
    appOrigin,
  }) => {
    const account = await selectedAccount(wallet, '0');
    await page.goto('/extensions/cfharness');
    await connectAccount(page, wallet, account);
    const frame = page.frameLocator('iframe');

    await frame.getByRole('button', { name: 'Sign message' }).click();
    const personal = await wallet.waitForRequest({ method: 'personal_sign' });
    // The app, not the frame, is the origin the wallet sees: the frame never reaches the provider itself.
    expect(personal.origin).toBe(appOrigin);
    expect(personal.params).toEqual([utils.hexlify(utils.toUtf8Bytes(EXTENSION_MESSAGE)), account]);
    await wallet.approve(personal.id);
    await expect(frame.locator('#result-personal')).toHaveText(/^0x[0-9a-f]{130}$/);
    expect(
      utils.verifyMessage(EXTENSION_MESSAGE, (await frame.locator('#result-personal').textContent()) as string)
    ).toBe(account);

    await frame.getByRole('button', { name: 'Sign typed data' }).click();
    const typed = await wallet.waitForRequest({ method: 'eth_signTypedData_v4' });
    expect(typed.origin).toBe(appOrigin);
    const [typedAccount, typedJson] = typed.params as [string, string];
    expect(typedAccount).toBe(account);
    expect(JSON.parse(typedJson)).toEqual(HARNESS_TYPED_DATA);
    await wallet.approve(typed.id);
    await expect(frame.locator('#result-typed')).toHaveText(/^0x[0-9a-f]{130}$/);
    expect(recoverTyped((await frame.locator('#result-typed').textContent()) as string)).toBe(account);
    // The wallet's own record holds the same signatures the frame received.
    expect(((await wallet.getRequest(typed.id)) as WalletRequest).result).toBe(
      await frame.locator('#result-typed').textContent()
    );
  });

  test('fixture: personal_sign of UTF-8 and hex messages recovers the account', async ({ page, wallet }) => {
    const account = await selectedAccount(wallet, '0');
    await wallet.setPolicy('personal_sign', 'approve');
    await openApp(page);
    await connectAccount(page, wallet, account);
    const text = 'Compound browser harness: UTF-8 message';
    const utf8 = await providerRequest(page, 'personal_sign', [text, account]);
    expect(utils.verifyMessage(text, utf8.result as string)).toBe(account);
    const bytes = utils.toUtf8Bytes('Compound browser harness: hex message');
    const hex = await providerRequest(page, 'personal_sign', [utils.hexlify(bytes), account]);
    expect(utils.verifyMessage(bytes, hex.result as string)).toBe(account);
  });

  test('fixture: eth_signTypedData_v4 recovers the account, and a domain on another chain is refused', async ({
    page,
    wallet,
  }) => {
    const account = await selectedAccount(wallet, '0');
    await openApp(page);
    await connectAccount(page, wallet, account);
    const signing = providerRequest(page, 'eth_signTypedData_v4', [account, JSON.stringify(HARNESS_TYPED_DATA)]);
    await wallet.approve((await wallet.waitForRequest({ method: 'eth_signTypedData_v4' })).id);
    expect(recoverTyped((await signing).result as string)).toBe(account);

    const otherChain = { ...HARNESS_TYPED_DATA, domain: { ...HARNESS_TYPED_DATA.domain, chainId: 8453 } };
    const refused = await providerRequest(page, 'eth_signTypedData_v4', [account, JSON.stringify(otherChain)]);
    expect(refused.error?.code).toBe(-32602);
    expect((await wallet.requests({ method: 'eth_signTypedData_v4' })).length).toBe(1);
  });

  test('fixture: a rejected signature gives the page 4001 and no signature', async ({ page, wallet }) => {
    const account = await selectedAccount(wallet, '0');
    await openApp(page);
    await connectAccount(page, wallet, account);
    const signing = providerRequest(page, 'personal_sign', ['no', account]);
    const request = await wallet.waitForRequest({ method: 'personal_sign' });
    await wallet.reject(request.id, { code: 4001 });
    expect((await signing).error).toEqual({ code: 4001, message: 'User rejected the request.' });
    expect((await wallet.getRequest(request.id)).status).toBe('rejected');
  });

  test('fixture: the wallet signs only for the selected, permitted account, and checks again at approval', async ({
    page,
    wallet,
  }) => {
    const account = await selectedAccount(wallet, '0');
    const { address: other } = await wallet.newAccount({ usdc: '0' });
    // Before the app is permitted, nothing is signed.
    await openApp(page);
    expect((await providerRequest(page, 'personal_sign', ['early', account])).error?.code).toBe(4100);
    // Refused before it was queued: absent from the queue, present in the record of provider calls, which the
    // screening tests read for the same reason.
    expect(await signingRequests(wallet)).toEqual([]);
    expect(await signingCalls(wallet)).toEqual(['personal_sign']);
    await connectAccount(page, wallet, account);
    // An account that is not the selected one.
    expect((await providerRequest(page, 'personal_sign', ['other', other])).error?.code).toBe(4100);
    // An approval delayed past an account change finds the account no longer selected, and signs nothing.
    const signing = providerRequest(page, 'personal_sign', ['delayed', account]);
    const request = await wallet.waitForRequest({ method: 'personal_sign' });
    await wallet.approve(request.id, { delayMs: 1_500 });
    await wallet.select(other);
    expect((await signing).error?.code).toBe(4100);
    expect((await wallet.getRequest(request.id)).status).toBe('failed');
    await expect(
      headerAccount(page, other).or(page.getByRole('banner').getByText('Connect Wallet', { exact: true }))
    ).toBeVisible();
  });

  test('fixture: an impersonated account without a key cannot sign', async ({ page, wallet }) => {
    const address = getAddress('0x000000000000000000000000000000000000c304');
    await wallet.impersonate(address, { eth: '1' });
    await wallet.select(address);
    await openApp(page);
    await connectAccount(page, wallet, address);
    const answer = await providerRequest(page, 'personal_sign', ['impersonated', address]);
    expect(answer.error).toEqual({ code: 4200, message: 'harness: impersonated account cannot sign' });
    expect(await wallet.requests({ method: 'personal_sign' })).toEqual([]);
  });
});

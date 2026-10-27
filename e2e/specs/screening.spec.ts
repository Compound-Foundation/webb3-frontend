// AC7: screening with the stub, on the dev server with VITE_SCREENING_ENDPOINT set, so the dev-only bypass
// never applies. Each case asserts the wallet's whole request history for the test, not only its state
// after the disconnect: no signing or sending request may reach the wallet from an address that is not
// screened as allowed. The wallet itself does not screen, so a regression in the app would show here.
//
// The production build cases are in prod-build.spec.ts.
import type { Locator, Page } from '@playwright/test';
import { getAddress } from 'viem';

import type { ControlClient } from '../harness/controlClient';
import {
  BYPASS_WARNING,
  connectThroughUi,
  expect,
  headerAccount,
  headerConnect,
  openApp,
  screeningOverlay,
  signingRequests,
  storedConnector,
  test,
} from '../harness/fixtures';
import type { ScreeningBehaviour } from '../harness/screeningStub';

const supplyButton = (page: Page) => page.getByRole('button', { name: 'Supply USDC' });

/** Tries an action, and records whether the click landed or the control was gone or disabled. */
async function attempt(name: string, locator: Locator) {
  const outcome = await locator.click({ timeout: 2_000 }).then(
    () => 'clicked',
    () => 'not clickable (gone or disabled)'
  );
  test.info().annotations.push({ type: 'attempted action', description: `${name}: ${outcome}` });
}

async function expectFailedClosed(page: Page, wallet: ControlClient, consoleMessages: string[]) {
  await expect(screeningOverlay(page)).toBeVisible({ timeout: 30_000 });
  await expect(headerConnect(page)).toBeVisible();
  expect(await storedConnector(page)).toBeNull();
  await expect(supplyButton(page)).toBeDisabled();
  await attempt('Supply USDC', supplyButton(page));
  expect(await signingRequests(wallet)).toEqual([]);
  expect(consoleMessages.filter((message) => message.includes(BYPASS_WARNING))).toEqual([]);
}

async function account(wallet: ControlClient, screening: ScreeningBehaviour) {
  const { address } = await wallet.newAccount({ usdc: '1000', screening });
  await wallet.select(address);
  return getAddress(address);
}

test.describe('screening', { tag: ['@AC7'] }, () => {
  test('allowed: the account connects and can ask for a transaction', async ({ page, wallet, consoleMessages }) => {
    const address = await account(wallet, 'allowed');
    await openApp(page);
    await connectThroughUi(page, wallet);
    await expect(headerAccount(page, address)).toBeVisible();
    await supplyButton(page).click();
    await page.getByRole('textbox', { name: '0' }).fill('1');
    await page.getByRole('button', { name: 'Approve & Add' }).click();
    const request = await wallet.waitForRequest({ method: 'eth_sendTransaction' });
    expect(getAddress((request.params as [{ from: string }])[0].from)).toBe(address);
    await wallet.reject(request.id);
    expect(consoleMessages.filter((message) => message.includes(BYPASS_WARNING))).toEqual([]);
  });

  for (const behaviour of ['blocked', 'malformed-text', 'malformed-string', 'malformed-empty', 'error'] as const) {
    test(`${behaviour}: the app fails closed, disconnects and sends nothing to sign`, async ({
      page,
      wallet,
      consoleMessages,
    }) => {
      const address = await account(wallet, behaviour);
      await openApp(page);
      await connectThroughUi(page, wallet);
      await expectFailedClosed(page, wallet, consoleMessages);
      expect(await wallet.screeningLog()).toEqual([
        expect.objectContaining({ address: address.toLowerCase(), behaviour, outcome: 'answered' }),
      ]);
    });
  }

  test('timeout: the app gives up after 10 s, fails closed and sends nothing to sign', async ({
    page,
    wallet,
    consoleMessages,
  }) => {
    const address = await account(wallet, 'timeout');
    await openApp(page);
    await connectThroughUi(page, wallet);
    const started = Date.now();
    await expect(headerAccount(page, address)).toHaveCount(0);
    await expect(screeningOverlay(page)).toBeVisible({ timeout: 20_000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(8_000);
    await expectFailedClosed(page, wallet, consoleMessages);
  });

  test('pending: the account stays hidden and nothing reaches the wallet until screening answers', async ({
    page,
    wallet,
    consoleMessages,
  }) => {
    const address = await account(wallet, 'hold');
    await openApp(page);
    await connectThroughUi(page, wallet);
    await expect.poll(async () => (await wallet.screeningLog()).map((entry) => entry.outcome)).toEqual(['held']);
    await expect(headerAccount(page, address)).toHaveCount(0);
    await expect(supplyButton(page)).toBeDisabled();
    await page.goto('/extensions/cfharness');
    // The extension page has rendered, and shows the connect prompt in place of the extension frame.
    await expect(page.getByText('to preview this extension.')).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(await signingRequests(wallet)).toEqual([]);
    // The navigation sent a new screening request, which the stub holds too. Answer both: blocked.
    await expect
      .poll(async () => (await wallet.screeningLog()).filter((entry) => entry.outcome === 'held').length)
      .toBeGreaterThan(0);
    await wallet.releaseScreening(address, 'blocked');
    await expect(screeningOverlay(page)).toBeVisible();
    await expect(headerConnect(page)).toBeVisible();
    expect(await signingRequests(wallet)).toEqual([]);
    expect(consoleMessages.filter((message) => message.includes(BYPASS_WARNING))).toEqual([]);
  });

  test('pending, then allowed: the account appears only once screening allows it', async ({ page, wallet }) => {
    const address = await account(wallet, 'hold');
    await openApp(page);
    await connectThroughUi(page, wallet);
    await expect.poll(async () => (await wallet.screeningLog()).map((entry) => entry.outcome)).toEqual(['held']);
    await expect(headerAccount(page, address)).toHaveCount(0);
    expect(await wallet.releaseScreening(address, 'allowed')).toEqual({ released: 1 });
    await expect(headerAccount(page, address)).toBeVisible();
    await expect(supplyButton(page)).toBeEnabled();
  });

  test('allowed, then an account change to a blocked account with an action open: nothing is sent', async ({
    page,
    wallet,
  }) => {
    const first = await account(wallet, 'allowed');
    await openApp(page);
    await connectThroughUi(page, wallet);
    await expect(headerAccount(page, first)).toBeVisible();
    await supplyButton(page).click();
    await page.getByRole('textbox', { name: '0' }).fill('100');
    const approve = page.getByRole('button', { name: 'Approve & Add' });
    await expect(approve).toBeEnabled();
    // The second account's screening is held, so the action is attempted while it is pending.
    const second = getAddress((await wallet.newAccount({ usdc: '1000', screening: 'hold' })).address);
    await wallet.select(second);
    await expect
      .poll(async () => (await wallet.screeningLog()).filter((entry) => entry.outcome === 'held').length)
      .toBe(1);
    await attempt('Approve & Add while the new account is pending', approve);
    await page.waitForTimeout(1_000);
    expect(await signingRequests(wallet)).toEqual([]);
    await wallet.releaseScreening(second, 'blocked');
    await expect(screeningOverlay(page)).toBeVisible();
    await expect(headerConnect(page)).toBeVisible();
    await attempt('Approve & Add after the block', approve);
    await page.waitForTimeout(1_000);
    expect(await signingRequests(wallet)).toEqual([]);
  });

  test('allowed, then an account change to a blocked account during an extension signing request: nothing is signed', async ({
    page,
    wallet,
  }) => {
    const first = await account(wallet, 'allowed');
    await page.goto('/extensions/cfharness');
    await connectThroughUi(page, wallet);
    await expect(headerAccount(page, first)).toBeVisible();
    const frame = page.frameLocator('iframe');
    await expect(frame.getByRole('button', { name: 'Sign message' })).toBeVisible();
    const second = getAddress((await wallet.newAccount({ usdc: '0', screening: 'hold' })).address);
    await wallet.select(second);
    await expect
      .poll(async () => (await wallet.screeningLog()).filter((entry) => entry.outcome === 'held').length)
      .toBe(1);
    // The frame goes when the account is not allowed. A click on a frame that is still there must not
    // produce a signing request for the unscreened account either.
    await attempt(
      'Sign message in the extension while the new account is pending',
      frame.getByRole('button', { name: 'Sign message' })
    );
    await page.waitForTimeout(1_000);
    expect(await signingRequests(wallet)).toEqual([]);
    await wallet.releaseScreening(second, 'blocked');
    await expect(screeningOverlay(page)).toBeVisible();
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(await signingRequests(wallet)).toEqual([]);
  });
});

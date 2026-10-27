// Playwright fixtures for browser tests against the harness wallet. A spec imports `test` and `expect` from
// here instead of `@playwright/test`.
//
// - `wallet`: the control client (`controlClient.ts`).
// - `fork`: a viem client for reading the fork directly from Node.
// - `context` and `page`: a fresh browser context per test, limited to the harness's origins
//   (`egress.ts`), with the harness provider injected into the app's top frame and its binding exposed.
// - Before each test, the wallet resets: the fork reverts to its baseline snapshot, and every account,
//   request, permission, chain setting and screening behaviour is cleared.
import fs from 'node:fs';

import { test as base, expect, type Browser, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { createPublicClient, http, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';

import { ControlClient } from './controlClient';
import { allowLoopbackWebSocket, applyEgress, type BlockedRequest } from './egress';
import { BINDING_NAME, installHarnessProvider, PROVIDER_ICON, PROVIDER_NAME, PROVIDER_RDNS } from './injectedProvider';
import type { Manifest } from './services';
import { v3ApiReadPrefixes } from './settings';
import { trustHarnessCertificate } from './tls';
import type { WalletRequest } from './walletServer';

export { expect };

export type AppTarget = 'dev' | 'prod-missing-endpoint' | 'prod-allowed';

export function readManifest(): Manifest {
  const file = process.env.BROWSER_HARNESS_MANIFEST;
  if (file === undefined) throw new Error('BROWSER_HARNESS_MANIFEST is not set: run the suite with yarn test:browser.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function originOf(manifest: Manifest, target: AppTarget): string {
  if (target === 'dev') return manifest.app.devOrigin;
  if (manifest.production.isSkipped) throw new Error(`production builds were skipped: ${manifest.production.reason}`);
  return target === 'prod-allowed' ? manifest.production.allowed.origin : manifest.production.missingEndpoint.origin;
}

type BindingSource = { page: Page | null; frame: Frame };

/**
 * The handler behind the page's wallet binding. It answers only the app's top frame at `appOrigin`, and
 * only two kinds of call: a provider request and the events poll. It never lets the page choose a control
 * endpoint, and the token stays in this worker.
 */
export function bindingHandler(appOrigin: string, wallet: ControlClient) {
  return async (source: BindingSource, payload: unknown) => {
    if (source.page === null || source.frame !== source.page.mainFrame()) {
      return { error: { code: 4100, message: "harness: only the app page's top frame may use the wallet" } };
    }
    let origin: string | undefined;
    try {
      origin = new URL(source.frame.url()).origin;
    } catch {
      origin = undefined;
    }
    if (origin !== appOrigin) return { error: { code: 4100, message: 'harness: the page is not the app' } };
    const call = (payload ?? {}) as { kind?: unknown; method?: unknown; params?: unknown; cursor?: unknown };
    if (call.kind === 'rpc' && typeof call.method === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(call.method)) {
      return wallet.walletRpc(origin, call.method, call.params ?? []);
    }
    if (call.kind === 'events' && (call.cursor === undefined || Number.isSafeInteger(call.cursor))) {
      return wallet.events(call.cursor as number | undefined);
    }
    return { error: { code: 4200, message: 'harness: unknown wallet call' } };
  };
}

/** Makes a browser context for `appOrigin`: no service workers, the harness egress, the binding and the provider. */
export async function harnessContext(
  browser: Browser,
  {
    manifest,
    appOrigin,
    wallet,
    blocked,
  }: { manifest: Manifest; appOrigin: string; wallet: ControlClient; blocked: BlockedRequest[] }
): Promise<BrowserContext> {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 1000 },
  });
  if (appOrigin === manifest.app.devOrigin) await allowLoopbackWebSocket(context, appOrigin);
  await applyEgress(
    context,
    {
      http: new Set([appOrigin, manifest.services.rpcProxy, manifest.services.screening]),
      readOnly: new Set(v3ApiReadPrefixes(manifest.v3Api.url)),
      webSocket: new Set(appOrigin === manifest.app.devOrigin ? [manifest.app.hmrOrigin] : []),
    },
    blocked
  );
  await context.exposeBinding(BINDING_NAME, bindingHandler(appOrigin, wallet));
  await context.addInitScript(installHarnessProvider, {
    appOrigin,
    bindingName: BINDING_NAME,
    name: PROVIDER_NAME,
    icon: PROVIDER_ICON,
    rdns: PROVIDER_RDNS,
  });
  return context;
}

type WorkerFixtures = { manifest: Manifest; wallet: ControlClient; fork: PublicClient };
type TestFixtures = {
  appTarget: AppTarget;
  appOrigin: string;
  blocked: BlockedRequest[];
  consoleMessages: string[];
  resetWallet: void;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Playwright reads a fixture's dependencies from its first parameter, so one with none takes `{}`.
  // eslint-disable-next-line no-empty-pattern
  manifest: [async ({}, use) => use(readManifest()), { scope: 'worker' }],
  // eslint-disable-next-line no-empty-pattern
  wallet: [async ({}, use) => use(ControlClient.fromEnvironment()), { scope: 'worker' }],
  fork: [
    async ({ manifest }, use) =>
      use(createPublicClient({ chain: mainnet, transport: http(manifest.fork.localUrl) }) as PublicClient),
    { scope: 'worker' },
  ],
  browser: [
    async ({ playwright, manifest, headless }, use) => {
      // The egress route fetches each browser request in Node, so this worker trusts the harness certificate.
      trustHarnessCertificate(fs.readFileSync(manifest.tls.certPath, 'utf8'));
      const browser = await playwright.chromium.launch({ headless });
      await use(browser);
      await browser.close();
    },
    { scope: 'worker' },
  ],
  appTarget: ['dev', { option: true }],
  appOrigin: async ({ manifest, appTarget }, use, testInfo) => {
    if (appTarget !== 'dev' && manifest.production.isSkipped) {
      testInfo.skip(true, `the production builds were skipped: ${manifest.production.reason}`);
    }
    await use(originOf(manifest, appTarget));
  },
  baseURL: async ({ appOrigin }, use) => use(appOrigin),
  // eslint-disable-next-line no-empty-pattern
  blocked: async ({}, use, testInfo) => {
    const blocked: BlockedRequest[] = [];
    await use(blocked);
    await testInfo.attach('blocked-requests.json', {
      body: JSON.stringify(blocked, null, 2),
      contentType: 'application/json',
    });
  },
  resetWallet: [
    async ({ wallet }, use) => {
      await wallet.reset();
      await use();
    },
    { auto: true },
  ],
  context: async ({ browser, manifest, appOrigin, wallet, blocked, resetWallet }, use) => {
    void resetWallet;
    const context = await harnessContext(browser, { manifest, appOrigin, wallet, blocked });
    await use(context);
    await context.close();
  },
  consoleMessages: async ({ page }, use) => {
    const messages: string[] = [];
    page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
    await use(messages);
  },
});

/** The bypass warning that `useAddressScreening` logs when the dev-only screening bypass runs. */
export const BYPASS_WARNING = 'Address screening is disabled';

/** Waits for a pending request of `method` that is not in `seen`. */
export async function nextRequest(
  wallet: ControlClient,
  method: string,
  seen: Set<string> = new Set(),
  timeoutMs = 60_000
) {
  const request = await wallet.waitForRequest({ method }, { timeoutMs, after: seen });
  seen.add(request.id);
  return request;
}

/** The ID of every request in the wallet's history, so a test can wait for the next new one. */
export async function seenRequests(wallet: ControlClient): Promise<Set<string>> {
  return new Set((await wallet.requests()).map((request: WalletRequest) => request.id));
}

/** Requests that ask the wallet to sign or send, in the whole history of this test. */
export const SIGNING_METHODS = ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'];
export async function signingRequests(wallet: ControlClient): Promise<WalletRequest[]> {
  return (await wallet.requests()).filter((request) => SIGNING_METHODS.includes(request.method));
}

/**
 * Connects the harness wallet through the app UI: Connect Wallet, the MetaMask row, then approval of the
 * permission request. Returns the approved request.
 */
export async function connectThroughUi(page: Page, wallet: ControlClient, { approve = true } = {}) {
  await page.getByRole('banner').getByText('Connect Wallet', { exact: true }).click();
  await page.getByText('MetaMask', { exact: true }).click();
  const request = await wallet.waitForRequest({ method: 'wallet_requestPermissions' });
  if (approve) await wallet.approve(request.id);
  return request;
}

/** The app's short form of an address, as its header shows the connected wallet: `0x1234...abcd`. */
export const shortAddress = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;

/** The header's label for the connected wallet `address`. */
export const headerAccount = (page: Page, address: string) =>
  page
    .getByRole('banner')
    .locator('label')
    .filter({ hasText: shortAddress(address) });

export const CONNECTOR_STORAGE_KEY = 'webb3-preferred-connector';

/** Opens `path` in the app and waits until the market data has loaded from the fork. */
export async function openApp(page: Page, path = '/') {
  await page.goto(path);
  await page.getByText('Net Supply APR').first().waitFor();
}

/** Connects `address`, which must be selected in the wallet, through the app UI, and waits for the header. */
export async function connectAccount(page: Page, wallet: ControlClient, address: string) {
  await connectThroughUi(page, wallet);
  await headerAccount(page, address).waitFor();
}

/** A new keyed account with 10 ETH and `usdc` USDC, screened as allowed, and selected in the wallet. */
export async function selectedAccount(wallet: ControlClient, usdc = '1000') {
  const { address } = await wallet.newAccount({ eth: '10', usdc });
  await wallet.select(address);
  return address;
}

/** The header's Connect Wallet button, which shows while no allowed wallet is connected. */
export const headerConnect = (page: Page) => page.getByRole('banner').getByText('Connect Wallet', { exact: true });

/** The stored connector preference, which the app writes on connect and clears on a blocked screen. */
export const storedConnector = (page: Page) =>
  page.evaluate((key) => window.localStorage.getItem(key), CONNECTOR_STORAGE_KEY);

/** The screening overlay that a blocked screen shows. */
export const screeningOverlay = (page: Page) => page.getByRole('alert').filter({ hasText: 'Unexpected error' });

/** Calls the injected provider from the app page, as the app would: through its EIP-6963 announcement. */
export function providerRequest(page: Page, method: string, params: unknown[] = []) {
  return page.evaluate(
    async ({ method, params }) => {
      const provider = await new Promise<{ request: (args: unknown) => Promise<unknown> }>((resolve) => {
        const listener = (event: Event) => {
          const detail = (event as CustomEvent).detail;
          if (detail?.info?.rdns === 'io.metamask') {
            window.removeEventListener('eip6963:announceProvider', listener);
            resolve(detail.provider);
          }
        };
        window.addEventListener('eip6963:announceProvider', listener);
        window.dispatchEvent(new Event('eip6963:requestProvider'));
      });
      try {
        return { result: await provider.request({ method, params }) };
      } catch (error) {
        return { error: { code: (error as { code?: number }).code, message: (error as Error).message } };
      }
    },
    { method, params }
  );
}

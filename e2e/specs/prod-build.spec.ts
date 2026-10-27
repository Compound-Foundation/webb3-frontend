// AC7: a production build cannot use the dev server's screening bypass. Both builds are made by the global
// setup in mode production with NODE_ENV=production, as `vite build` does when NODE_ENV is unset, and the harness
// refused to serve either unless Vite resolved DEV=false and PROD=true (`viteApp.ts`). A build run with
// NODE_ENV=development compiles DEV=true, and so the bypass, whatever its mode. The harness sets NODE_ENV
// itself, so it does not test that case; see docs/browser-fork-wallet.md.
//
// - The first build has no VITE_SCREENING_ENDPOINT: exactly the configuration in which the dev server would
//   skip screening. A connected wallet must fail closed.
// - The second, the control, has the stub's endpoint and an allowed account. It must connect normally, so
//   the first case cannot pass merely because a production build fails to connect at all.
import fs from 'node:fs';
import path from 'node:path';

import { getAddress } from 'viem';

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
import type { Manifest } from '../harness/services';

const builtJavaScript = (outDir: string) =>
  fs
    .readdirSync(path.join(outDir, 'assets'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(outDir, 'assets', name), 'utf8'))
    .join('\n');

const production = (manifest: Manifest) => {
  if (manifest.production.skipped) throw new Error('production builds were skipped');
  return manifest.production;
};

test.describe('production build without a screening endpoint', { tag: ['@AC7'] }, () => {
  test.use({ appTarget: 'prod-missing-endpoint' });

  test('was built as production, with no screening endpoint', async ({ manifest, appOrigin }) => {
    const build = production(manifest).missingEndpoint;
    expect(appOrigin).toBe(build.origin);
    expect(build.resolved).toEqual({ mode: 'production', isProduction: true, DEV: false, PROD: true });
    expect(Object.keys(build.environment)).not.toContain('VITE_SCREENING_ENDPOINT');
    const javaScript = builtJavaScript(build.outDir);
    expect(javaScript.includes('SCREENING_ENDPOINT_NOT_CONFIGURED'), 'the build has no screening endpoint').toBe(true);
    // Not a gate: Vite compiles `SCREENING_DISABLED` here to `Boolean(false) && true`, which the minifier
    // does not fold, so the dead branch and its warning text stay in the bundle without being able to run.
    // The next test is the gate: a connected wallet must fail closed.
    test.info().annotations.push({
      type: 'bypass text in bundle',
      description: String(javaScript.includes(BYPASS_WARNING)),
    });
  });

  test('a connected wallet fails closed: the app disconnects and nothing is signed', async ({
    page,
    wallet,
    consoleMessages,
  }) => {
    const { address } = await wallet.newAccount({ usdc: '1000', screening: 'allowed' });
    await wallet.select(address);
    await openApp(page);
    await connectThroughUi(page, wallet);
    await expect(screeningOverlay(page)).toBeVisible({ timeout: 30_000 });
    await expect(headerConnect(page)).toBeVisible();
    await expect(headerAccount(page, getAddress(address))).toHaveCount(0);
    expect(await storedConnector(page)).toBeNull();
    await expect(page.getByRole('button', { name: 'Supply USDC' })).toBeDisabled();
    expect(await signingRequests(wallet)).toEqual([]);
    // The stub would have allowed the account, but the build has no endpoint, so it was never asked.
    expect(await wallet.screeningLog()).toEqual([]);
    expect(consoleMessages.filter((message) => message.includes(BYPASS_WARNING))).toEqual([]);
  });
});

test.describe('production build with the screening endpoint (control)', { tag: ['@AC7'] }, () => {
  test.use({ appTarget: 'prod-allowed' });

  test('was built as production, with the stub endpoint', async ({ manifest }) => {
    const build = production(manifest).allowed;
    expect(build.resolved).toEqual({ mode: 'production', isProduction: true, DEV: false, PROD: true });
    const javaScript = builtJavaScript(build.outDir);
    expect(javaScript.includes(build.environment.VITE_SCREENING_ENDPOINT), 'the build has the stub endpoint').toBe(
      true
    );
  });

  test('an allowed wallet connects and can ask for a transaction', async ({
    page,
    wallet,
    appOrigin,
    consoleMessages,
  }) => {
    const address = getAddress((await wallet.newAccount({ usdc: '1000', screening: 'allowed' })).address);
    await wallet.select(address);
    await openApp(page);
    await connectThroughUi(page, wallet);
    await expect(headerAccount(page, address)).toBeVisible();
    expect(await wallet.screeningLog()).toEqual([
      expect.objectContaining({ address: address.toLowerCase(), origin: appOrigin, outcome: 'answered' }),
    ]);
    await page.getByRole('button', { name: 'Supply USDC' }).click();
    await page.getByRole('textbox', { name: '0' }).fill('1');
    await page.getByRole('button', { name: 'Approve & Add' }).click();
    const request = await wallet.waitForRequest({ method: 'eth_sendTransaction' });
    expect(getAddress((request.params as [{ from: string }])[0].from)).toBe(address);
    await wallet.reject(request.id);
    expect(consoleMessages.filter((message) => message.includes(BYPASS_WARNING))).toEqual([]);
  });
});

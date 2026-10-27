// AC10: the production bundle holds none of the harness: no injected provider, wallet server, test key or
// control credential. It scans each production build this run made and, when one exists, the repository's
// `dist/` from `yarn build`. The global teardown also scans the same outputs for every key the wallet made
// and the private upstream URL, which only the runner holds (see stats.json and summary.md).
import fs from 'node:fs';
import path from 'node:path';

import { EXTENSION_PAGE } from '../harness/extensionPage';
import { expect, test } from '../harness/fixtures';
import { BINDING_NAME, PROVIDER_NAME } from '../harness/injectedProvider';
import { REPO_ROOT } from '../harness/paths';

/** Strings that only the harness holds. */
const HARNESS_MARKERS = [
  BINDING_NAME,
  PROVIDER_NAME,
  'installHarnessProvider',
  'Compound browser harness',
  'HarnessCheck',
  'e2e/harness',
  '@playwright',
  'cf-browser-wallet',
  'BROWSER_WALLET_CONTROL',
  'BROWSER_FORK_RPC_URL',
];

/** anvil's well-known test mnemonic and its first ten keys, which the harness must never use. */
const ANVIL_DEFAULTS = [
  'test test test test test test test test test test test junk',
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  'dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
];

function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

test.describe('the production bundle', { tag: ['@AC10'] }, () => {
  test('holds no harness code, test key or control credential', async ({ manifest }) => {
    test.skip(manifest.production.skipped, 'the production builds were skipped');
    if (manifest.production.skipped) return;
    const token = fs.readFileSync(manifest.tokenFile, 'utf8').trim();
    const outputs = [manifest.production.missingEndpoint.outDir, manifest.production.allowed.outDir];
    const repositoryDist = path.join(REPO_ROOT, 'dist');
    if (fs.existsSync(repositoryDist)) outputs.push(repositoryDist);
    await test
      .info()
      .attach('scanned-outputs.json', { body: JSON.stringify(outputs.map((each) => path.relative(REPO_ROOT, each))) });
    const needles = [...HARNESS_MARKERS, ...ANVIL_DEFAULTS, token, EXTENSION_PAGE.slice(0, 200)];
    for (const output of outputs) {
      const files = filesUnder(output);
      expect(files.length).toBeGreaterThan(10);
      for (const file of files) {
        expect(path.relative(output, file)).not.toMatch(/e2e|harness|playwright/i);
        const text = fs.readFileSync(file, 'latin1');
        for (const needle of needles) {
          if (text.toLowerCase().includes(needle.toLowerCase())) {
            throw new Error(
              `${path.relative(REPO_ROOT, file)} holds a harness string (${
                needle === token ? 'the control token' : needle.slice(0, 40)
              })`
            );
          }
        }
      }
    }
  });
});

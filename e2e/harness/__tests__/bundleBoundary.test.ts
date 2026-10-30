/**
 * @jest-environment node
 */
// The structural half of AC10: nothing the app builds imports the harness. The browser suite's
// bundle.spec.ts checks the built output itself.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');

function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : filesUnder(full);
    return /\.(tsx?|jsx?|html|scss)$/.test(entry.name) ? [full] : [];
  });
}

test('no app source, HTML entry point or build configuration refers to the harness', () => {
  const entries = [
    'index.html',
    'markets/index.html',
    'extensions/index.html',
    'vote/index.html',
    'transactions/index.html',
    'rewards/index.html',
    'redirect/index.html',
    'vite.config.js',
    'envVars.ts',
  ];
  const files = [...filesUnder(path.join(ROOT, 'src')), ...entries.map((entry) => path.join(ROOT, entry))];
  expect(files.length).toBeGreaterThan(100);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    expect({
      file: path.relative(ROOT, file),
      refersToHarness: /e2e\/|@playwright|__compoundHarnessWallet|BROWSER_WALLET|BROWSER_FORK/.test(text),
    }).toEqual({
      file: path.relative(ROOT, file),
      refersToHarness: false,
    });
  }
});

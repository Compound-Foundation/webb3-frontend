import { execFileSync } from 'child_process';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const git = (args: string[], input?: string) =>
  execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });

// The browser harness under e2e/ handles keys and impersonates accounts, so its
// changes, tests included, stay expanded in pull request diffs.
const isHarnessFile = (path: string) => path.startsWith('e2e/');

const isTestFile = (path: string) =>
  !isHarnessFile(path) && (path.split('/').includes('__tests__') || /\.test\.(ts|tsx|js)$/.test(path));

// Returns each path's linguist-generated value: 'set', 'unset', 'unspecified' or a string value.
const linguistGenerated = (paths: string[]): Map<string, string> => {
  const fields = git(['check-attr', '-z', '--stdin', 'linguist-generated'], paths.join('\0')).split('\0');
  const values = new Map<string, string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    values.set(fields[index], fields[index + 2]);
  }
  return values;
};

const trackedFiles = git(['ls-files', '-z']).split('\0').filter(Boolean);

// Paths the harness in the open wrapped-lending stack adds. They are not on main
// yet; git check-attr reads the attribute rules for a path whether or not it exists.
const harnessProbePaths = [
  'e2e/harness/__tests__/secrets.test.ts',
  'e2e/harness/secrets.ts',
  'e2e/playwright.config.ts',
  'e2e/specs/connect.spec.ts',
];

describe('gitattributes', () => {
  it('marks every test file as linguist-generated', () => {
    const testFiles = trackedFiles.filter(isTestFile);
    expect(testFiles).toContain('__tests__/repo/gitattributes.test.ts');

    const values = linguistGenerated(testFiles);
    const unmarked = testFiles.filter((path) => values.get(path) !== 'set');
    expect(unmarked).toEqual([]);
  });

  it('marks no app, config, script or harness file', () => {
    const otherFiles = [...trackedFiles.filter((path) => !isTestFile(path)), ...harnessProbePaths];
    expect(otherFiles).toEqual(expect.arrayContaining(['.gitattributes', 'AGENTS.md', 'src/main.tsx']));

    const values = linguistGenerated(otherFiles);
    const marked = otherFiles.filter((path) => values.get(path) === 'set');
    expect(marked).toEqual([]);
  });
});

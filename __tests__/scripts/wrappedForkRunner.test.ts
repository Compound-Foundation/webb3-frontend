// The wrapped lending fork runner's own tests use Node's test runner, because the runner and its
// module are plain ES modules that this Jest setup does not load. This test runs them, so that
// `yarn test` covers them. `yarn test:fork-runner` runs them alone, with each test's result.
import { spawnSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

test('the wrapped lending fork runner passes its own tests', () => {
  const run = spawnSync(process.execPath, ['--test', 'scripts/lib/__tests__/wrapped-fork-runner.test.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240_000,
  });
  // On a failure, the comparison prints the runner tests' output, which names each failed test.
  expect({ status: run.status, output: run.status === 0 ? '' : `${run.stdout}${run.stderr}` }).toEqual({
    status: 0,
    output: '',
  });
}, 300_000);

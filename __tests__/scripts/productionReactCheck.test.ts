// The production React check's own tests use Node's test runner, because the check is a plain ES module
// that this Jest setup does not load. This test runs them, so that `yarn test` covers them.
// `yarn test:production-react-check` runs them alone, with each test's result.
import { spawnSync } from 'child_process';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

test('the production React check passes its own tests', () => {
  const run = spawnSync(process.execPath, ['--test', 'scripts/lib/__tests__/development-react.test.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  // On a failure, the comparison prints the check's test output, which names each failed test.
  expect({ status: run.status, output: run.status === 0 ? '' : `${run.stdout}${run.stderr}` }).toEqual({
    status: 0,
    output: '',
  });
}, 90_000);

// A Jest reporter for the wrapped lending fork suite. It writes each test's title and status, and the
// first line of its failure, to the file that WRAPPED_FORK_JEST_RESULTS names. The runner holds each
// matrix cell to that result, because a scenario can record its cell after Jest failed its test.
import fs from 'fs';

export default class CellReporter {
  onRunComplete(_contexts, results) {
    const file = process.env.WRAPPED_FORK_JEST_RESULTS;
    if (file === undefined || file === '') return;
    const tests = results.testResults.flatMap((suite) =>
      suite.testResults.map((test) => ({
        title: test.title,
        status: test.status,
        failure: String(test.failureMessages[0] ?? '').split('\n')[0],
      }))
    );
    const report = {
      numFailedTests: results.numFailedTests,
      numRuntimeErrorTestSuites: results.numRuntimeErrorTestSuites,
      tests,
    };
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  }
}

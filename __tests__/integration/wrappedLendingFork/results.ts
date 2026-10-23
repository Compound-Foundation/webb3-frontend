import fs from 'fs';

/** One cell of the scenario matrix, as the runner prints it. */
export type ScenarioResult = {
  scenario: string;
  market: string;
  status: 'pass' | 'fail' | 'not-exercised';
  /** Why it failed or was not exercised. */
  reason?: string;
  /** Raw figures the scenario measured: receipts, quotes and their differences, in base or share units. */
  measurements?: Record<string, string | number | boolean>;
};

const resultsFile = process.env.WRAPPED_FORK_RESULTS;

/**
 * Thrown by a scenario that the fork's state does not let it exercise, such as a market with no
 * supply rate. `scenario` records the cell as not exercised, with the message as the reason.
 */
export class NotExercisedOnThisFork extends Error {}

function append(result: ScenarioResult) {
  if (resultsFile === undefined || resultsFile === '') return;
  const existing: ScenarioResult[] = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : [];
  fs.writeFileSync(resultsFile, JSON.stringify([...existing, result], null, 2));
}

/** Figures a scenario records as it goes. Bigints are kept as decimal strings. */
export type Measurements = Record<string, bigint | string | number | boolean>;

function serialize(measurements: Measurements): ScenarioResult['measurements'] {
  return Object.fromEntries(
    Object.entries(measurements).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value])
  );
}

/**
 * A Jest test that is also a cell of the matrix. The cell passes when the test passes, and fails
 * with the test's error otherwise. The test still fails or passes as usual. A scenario that throws
 * `NotExercisedOnThisFork` passes as a test, and its cell is recorded as not exercised. The runner
 * fails any cell whose test Jest failed, whatever the cell records.
 */
export function scenario(name: string, market: string, run: (measurements: Measurements) => Promise<void>) {
  test(`${name} (${market})`, async () => {
    const measurements: Measurements = {};
    try {
      await run(measurements);
    } catch (error) {
      if (error instanceof NotExercisedOnThisFork) {
        append({
          scenario: name,
          market,
          status: 'not-exercised',
          reason: error.message,
          measurements: serialize(measurements),
        });
        return;
      }
      append({
        scenario: name,
        market,
        status: 'fail',
        reason: error instanceof Error ? error.message.split('\n')[0] : String(error),
        measurements: serialize(measurements),
      });
      throw error;
    }
    append({ scenario: name, market, status: 'pass', measurements: serialize(measurements) });
  });
}

/** A cell the suite does not exercise, with the reason. It is recorded, never silently skipped. */
export function notExercised(name: string, market: string, reason: string) {
  test.todo(`${name} (${market}): not exercised: ${reason}`);
  append({ scenario: name, market, status: 'not-exercised', reason });
}

/**
 * @jest-environment node
 */
// The real browser suite holds every required acceptance case. It lists the actual Playwright
// configuration, as the summary reporter does: the listing loads the specs only, and starts no service and
// no browser. Deleting a required case's test, such as the NODE_ENV=development placeholder in
// prod-build.spec.ts, fails here as well as in the run's summary.
import path from 'node:path';

import { REQUIRED_ACCEPTANCE_CASES } from '../acceptance';
import { REPO_ROOT } from '../paths';
import { listFullSuite } from '../summaryReporter';

const CONFIG = path.join(REPO_ROOT, 'e2e/playwright.config.ts');

test('the full browser suite lists every required acceptance case', () => {
  const inventory = listFullSuite(CONFIG);
  expect(inventory.length).toBeGreaterThan(40);
  expect(REQUIRED_ACCEPTANCE_CASES.length).toBeGreaterThan(0);
  for (const each of REQUIRED_ACCEPTANCE_CASES) expect(inventory).toContain(each.id);
}, 60_000);

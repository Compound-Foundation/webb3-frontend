import { readFileSync } from 'fs';
import { join } from 'path';

const DEFAULT_OWNER = '@Compound-Foundation/foundation-engineering';

const codeowners = readFileSync(join(__dirname, '..', '..', '.github', 'CODEOWNERS'), 'utf8');

// Each rule as its path pattern and owners. Blank lines and comments are not rules.
const rules = codeowners
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))
  .map((line) => {
    const [pattern, ...owners] = line.split(/\s+/);
    return { pattern, owners };
  });

describe('CODEOWNERS', () => {
  // The last matching rule wins, so a rule with no owner leaves its paths with none.
  it('names the default owner on every rule', () => {
    expect(rules.map((rule) => rule.pattern)).toEqual(expect.arrayContaining(['*', '/src/hooks/', '/e2e/']));

    const unowned = rules.filter((rule) => !rule.owners.includes(DEFAULT_OWNER)).map((rule) => rule.pattern);
    expect(unowned).toEqual([]);
  });
});

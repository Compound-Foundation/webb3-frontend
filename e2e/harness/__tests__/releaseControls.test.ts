/**
 * @jest-environment node
 */
// The dev server's plugin opens the six wrapper release controls of the registry, and no other module. It is
// a dev-server plugin only, so `vite build` never runs it, and the committed source stays as committed.
import fs from 'node:fs';

import type { Plugin } from 'vite';

import {
  openReleaseControls,
  openWrappedReleaseControls,
  RELEASE_CONTROL_COUNT,
  RELEASE_CONTROLS_FILE,
} from '../releaseControls';

type Transform = (code: string, id: string) => { code: string } | null;
const transformOf = (plugin: Plugin) => plugin.transform as unknown as Transform;

const committed = fs.readFileSync(RELEASE_CONTROLS_FILE, 'utf8');

describe('openWrappedReleaseControls', () => {
  it('applies to the dev server only', () => {
    expect(openWrappedReleaseControls().apply).toBe('serve');
  });

  it('leaves the committed registry, whose six controls are open, unchanged', () => {
    expect(committed.match(/(isDepositEnabled|isExitEnabled): true,/g)).toHaveLength(RELEASE_CONTROL_COUNT);

    expect(openReleaseControls(committed)).toBe(committed);
  });

  it.each([
    ['both controls closed', /(isDepositEnabled|isExitEnabled): true,/g],
    ['deposits closed, the deposit-disable rollback', /(isDepositEnabled): true,/g],
  ])('opens every control of a registry with %s and changes nothing else', (_label, closing) => {
    const closed = committed.replace(closing, '$1: false,');
    expect(closed).not.toBe(committed);

    expect(openReleaseControls(closed)).toBe(committed);
  });

  it('transforms the registry module only', () => {
    const transform = transformOf(openWrappedReleaseControls());

    expect(transform(committed, RELEASE_CONTROLS_FILE)?.code).toBe(openReleaseControls(committed));
    expect(transform(committed, `${RELEASE_CONTROLS_FILE}?t=1`)?.code).toBe(openReleaseControls(committed));
    expect(transform(committed, RELEASE_CONTROLS_FILE.replace('wrappedMarkets', 'markets'))).toBeNull();
  });

  it('stops the run when the registry no longer holds six controls', () => {
    const changed = committed.replace('isExitEnabled: true,', 'isExitEnabled: Boolean(1),');

    expect(() => openReleaseControls(changed)).toThrow(/Expected 6 release controls/);
  });
});

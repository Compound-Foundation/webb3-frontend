/**
 * @jest-environment node
 */
// The dev server's plugin opens the six wrapper release controls of the registry, and no other module. It is
// a dev-server plugin only, so `vite build` never runs it, and the committed source stays closed.
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

  it('opens exactly the six closed controls of the committed registry and changes nothing else', () => {
    expect(committed.match(/(isDepositEnabled|isExitEnabled): false,/g)).toHaveLength(RELEASE_CONTROL_COUNT);

    const opened = openReleaseControls(committed);

    expect(opened.match(/(isDepositEnabled|isExitEnabled): true,/g)).toHaveLength(RELEASE_CONTROL_COUNT);
    expect(opened.match(/(isDepositEnabled|isExitEnabled): false,/g)).toBeNull();
    expect(opened.replace(/(isDepositEnabled|isExitEnabled): true,/g, '$1: false,')).toBe(committed);
  });

  it('transforms the registry module only', () => {
    const transform = transformOf(openWrappedReleaseControls());

    expect(transform(committed, RELEASE_CONTROLS_FILE)?.code).toBe(openReleaseControls(committed));
    expect(transform(committed, `${RELEASE_CONTROLS_FILE}?t=1`)?.code).toBe(openReleaseControls(committed));
    expect(transform(committed, RELEASE_CONTROLS_FILE.replace('wrappedMarkets', 'markets'))).toBeNull();
  });

  it('stops the run when the registry no longer holds the six closed controls', () => {
    const changed = committed.replace('isExitEnabled: false,', 'isExitEnabled: true,');

    expect(() => openReleaseControls(changed)).toThrow(/Expected 6 closed release controls/);
  });
});

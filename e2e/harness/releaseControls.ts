// Opens the wrapper release controls in the harness's dev server, so the browser suite can supply and
// withdraw through the wrappers on the fork whatever the committed controls are, a rollback's closed ones
// included. This file never changes the committed registry. The plugin applies to Vite's dev server only (`apply: 'serve'`), so `vite build`,
// the harness's own production builds included, never runs it, and no `VITE_*` variable is involved.
import path from 'node:path';

import type { Plugin } from 'vite';

import { REPO_ROOT } from './paths';

/** The registry whose hardcoded source holds the release controls. */
export const RELEASE_CONTROLS_FILE = path.join(REPO_ROOT, 'src/constants/wrappedMarkets.ts');

/** `isDepositEnabled` and `isExitEnabled` for each of the three Ethereum wrappers. */
export const RELEASE_CONTROL_COUNT = 6;

const CONTROL = /\b(isDepositEnabled|isExitEnabled): (true|false),/g;
const CLOSED_CONTROL = /\b(isDepositEnabled|isExitEnabled): false,/g;

/**
 * The registry's source with every closed release control opened, and the open ones left as they are. It
 * throws unless it finds exactly six controls, open or closed, so a change to the registry's source stops
 * the run rather than opening less, or something else.
 */
export function openReleaseControls(source: string): string {
  const controls = source.match(CONTROL) ?? [];
  if (controls.length !== RELEASE_CONTROL_COUNT) {
    throw new Error(
      `Expected ${RELEASE_CONTROL_COUNT} release controls in ${RELEASE_CONTROLS_FILE}, found ${controls.length}.`
    );
  }
  return source.replace(CLOSED_CONTROL, '$1: true,');
}

/** The dev server's plugin: it opens the release controls of the registry module, and changes no other module. */
export function openWrappedReleaseControls(): Plugin {
  return {
    name: 'cf-harness-open-wrapped-release-controls',
    apply: 'serve',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] !== RELEASE_CONTROLS_FILE) return null;
      return { code: openReleaseControls(code), map: null };
    },
  };
}

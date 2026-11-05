// jest.setup.ts
import { TextEncoder, TextDecoder } from 'util';
import { BroadcastChannel } from 'worker_threads';
import 'whatwg-fetch';

Object.assign(global, { TextEncoder, TextDecoder, BroadcastChannel });

// Hook tests change no DOM, so `waitFor` checks them again only on its timer. Check every 5 ms instead
// of Testing Library's 50 ms. A call that passes its own `interval` keeps it. A setup file shares each
// test file's module registry, so this mock reaches every test file.
jest.mock('@testing-library/react', () => {
  const actual: typeof import('@testing-library/react') = jest.requireActual('@testing-library/react');
  const waitFor: typeof actual.waitFor = (callback, options) => actual.waitFor(callback, { interval: 5, ...options });
  return { __esModule: true, ...actual, waitFor };
});

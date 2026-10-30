/**
 * @jest-environment node
 */
// The screening stub: the exact answer for each behaviour, CORS for the app only, and held requests.
import { server as mswServer } from '../../../handlers/server';
import { startScreeningStub, type ScreeningStub } from '../screeningStub';

const APP = 'http://127.0.0.1:5999';
const ADDRESS = '0x00000000000000000000000000000000000c0304';

let stub: ScreeningStub;
beforeAll(() => mswServer.close());
beforeEach(async () => {
  stub = await startScreeningStub({ allowedOrigins: new Set([APP]) });
});
afterEach(() => stub.close());

const screen = (address = ADDRESS, origin = APP, signal?: AbortSignal) =>
  fetch(stub.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ address }),
    signal,
  });

test.each([
  ['allowed', 200, '{"flagged":false}'],
  ['blocked', 200, '{"flagged":true}'],
  ['malformed-text', 200, 'not json'],
  ['malformed-string', 200, '{"flagged":"false"}'],
  ['malformed-empty', 200, '{}'],
  ['error', 500, 'internal error'],
] as const)('%s answers %i %s', async (behaviour, status, body) => {
  stub.setBehaviour(ADDRESS, behaviour);
  const response = await screen();
  expect(response.status).toBe(status);
  expect(await response.text()).toBe(body);
  expect(response.headers.get('access-control-allow-origin')).toBe(APP);
  expect(stub.log()).toEqual([
    expect.objectContaining({ address: ADDRESS, origin: APP, behaviour, outcome: 'answered' }),
  ]);
});

test('an address with no behaviour is blocked', async () => {
  expect(await (await screen('0x1111111111111111111111111111111111111111')).text()).toBe('{"flagged":true}');
});

test('refuses an origin outside the app, and a body that is not an address', async () => {
  stub.setBehaviour(ADDRESS, 'allowed');
  expect((await screen(ADDRESS, 'https://attacker.example')).status).toBe(403);
  expect((await screen('not an address')).status).toBe(400);
});

test('hold keeps the request until released, as allowed or blocked', async () => {
  stub.setBehaviour(ADDRESS, 'hold');
  const pending = screen();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(stub.log().map((entry) => entry.outcome)).toEqual(['held']);
  expect(stub.release(ADDRESS, 'allowed')).toBe(1);
  expect(await (await pending).text()).toBe('{"flagged":false}');
  expect(stub.log().map((entry) => entry.outcome)).toEqual(['released']);
});

test('timeout never answers, and a reset closes the held request', async () => {
  stub.setBehaviour(ADDRESS, 'timeout');
  const pending = screen().then(
    () => 'answered',
    () => 'closed'
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(stub.release(ADDRESS, 'allowed')).toBe(0);
  stub.reset();
  expect(await pending).toBe('closed');
  expect(stub.log()).toEqual([]);
});

test('serves the test extension page', async () => {
  const page = await (await fetch(stub.extensionUrl)).text();
  expect(page).toContain('sendWeb3');
  expect(page).toContain('Sign typed data');
});

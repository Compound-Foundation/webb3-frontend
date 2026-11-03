/**
 * @jest-environment node
 */
// The screening stub: the exact answer for each behaviour, CORS for the app only, and held requests.
import { server as mswServer } from '../../../handlers/server';
import { LANE_HEADER } from '../laneHeader';
import { startScreeningStub, type ScreeningLane, type ScreeningStub } from '../screeningStub';

const APP = 'http://127.0.0.1:5999';
const ADDRESS = '0x00000000000000000000000000000000000c0304';

let server: ScreeningStub;
/** Lane 0, which the tests of one lane's behaviour use. */
let stub: ScreeningLane;
beforeAll(() => mswServer.close());
beforeEach(async () => {
  server = await startScreeningStub({ allowedOrigins: new Set([APP]), laneCount: 2 });
  stub = server.lanes[0];
});
afterEach(() => server.close());

/** A screen from the app, in lane 0 unless `lane` names another, or `null` for none. */
const screen = (address = ADDRESS, origin = APP, signal?: AbortSignal, lane: string | null = '0') =>
  fetch(server.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      ...(lane === null ? {} : { [LANE_HEADER]: lane }),
    },
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
  const page = await (await fetch(server.extensionUrl)).text();
  expect(page).toContain('sendWeb3');
  expect(page).toContain('Sign typed data');
});

describe('fork lanes', () => {
  test("keeps each lane's behaviours, log and held requests apart, so one lane's reset leaves the others", async () => {
    const [first, second] = server.lanes;
    first.setBehaviour(ADDRESS, 'allowed');
    second.setBehaviour(ADDRESS, 'hold');
    expect(await (await screen(ADDRESS, APP, undefined, '0')).text()).toBe('{"flagged":false}');
    const held = screen(ADDRESS, APP, undefined, '1');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(first.log().map((entry) => entry.outcome)).toEqual(['answered']);
    expect(second.log().map((entry) => entry.outcome)).toEqual(['held']);
    // A reset of lane 0, as before its next test, neither answers nor clears lane 1's request.
    first.reset();
    expect(first.behaviourOf(ADDRESS)).toBe('blocked');
    expect(second.behaviourOf(ADDRESS)).toBe('hold');
    expect(first.release(ADDRESS, 'allowed')).toBe(0);
    expect(second.log().map((entry) => entry.outcome)).toEqual(['held']);
    expect(second.release(ADDRESS, 'blocked')).toBe(1);
    expect(await (await held).text()).toBe('{"flagged":true}');
  });

  test('refuses a screen with no lane, or a lane out of range, and logs it in no lane', async () => {
    for (const lane of [null, '2', 'x', '01']) {
      expect((await screen(ADDRESS, APP, undefined, lane)).status).toBe(403);
    }
    expect(server.lanes.flatMap((each) => each.log())).toEqual([]);
    // A preflight needs no lane: the browser sends no custom header with it.
    const preflight = await fetch(server.endpoint, { method: 'OPTIONS', headers: { origin: APP } });
    expect(preflight.status).toBe(204);
  });
});

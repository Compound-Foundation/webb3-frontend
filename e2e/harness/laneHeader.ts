// The header that names a request's fork lane. Each Playwright worker has its own lane: an anvil fork, a
// wallet server and a screening partition. The app's RPC and screening URLs are compiled into its bundle, so
// every worker's pages reach the same RPC proxy and screening stub, and the header tells those services which
// lane a request is for. The page never chooses it: the worker's egress route, which fetches every browser
// request in Node, sets it on requests to those two services and removes it from every other request.
export const LANE_HEADER = 'x-cf-harness-lane';

/** The lane `value` names: a decimal index below `laneCount`, without a leading zero, or undefined. */
export function laneOf(value: string | string[] | undefined, laneCount: number): number | undefined {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,3})$/.test(value)) return undefined;
  const lane = Number(value);
  return lane < laneCount ? lane : undefined;
}

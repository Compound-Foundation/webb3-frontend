// The browser's network boundary. A context reaches only the exact origins a test needs: the app, the
// HTTPS RPC proxy and the screening stub, plus Vite's HMR WebSocket on the dev server, and, when one is
// configured, GET and HEAD under the read-only prefixes of the public v3 API. Every other HTTP request is
// aborted and every other WebSocket is closed, including the raw anvil fork, the upstream proxy, the wallet
// server and every production host. Service workers are blocked by the context options
// (`serviceWorkers: 'block'`), because Playwright's routes do not see their requests.
//
// Playwright calls a route for a request's first URL only, and the browser follows a redirect without
// calling it again. So the route never lets the browser make a request itself: it fetches each allowed
// request in Node with redirects off, checks each redirect's destination as a request of its own, follows
// it there, and fulfills the browser's request with the final answer. A redirect to a destination that is
// not allowed fails the request before anything is sent there.
import type { BrowserContext } from '@playwright/test';

/**
 * `http`: origins, or origins with a path prefix, that any method may reach. `readOnly`: prefixes that only
 * GET and HEAD may reach. `webSocket`: WebSocket origins.
 */
export type Egress = { http: ReadonlySet<string>; readOnly?: ReadonlySet<string>; webSocket: ReadonlySet<string> };
export type BlockedRequest = { kind: 'http' | 'redirect' | 'websocket'; url: string; method?: string; from?: string };

/**
 * Lets pages at `origin` open a WebSocket to a loopback address, for Vite's HMR on the dev server. The route
 * fulfills every document, and a fulfilled document has no network address, so Chromium's Local Network
 * Access check counts it as public and blocks its WebSocket to 127.0.0.1. Without HMR, Vite cannot reload a
 * page after it re-optimizes dependencies, and the page loads two copies of React. The permission is
 * granted to the dev server's origin only: the check stays on for every other origin, such as an extension
 * frame's, and `routeWebSocket` still decides each WebSocket that a page or frame opens.
 */
export async function allowLoopbackWebSocket(context: BrowserContext, origin: string): Promise<void> {
  await context.grantPermissions(['local-network-access'], { origin });
}

/** The most redirects the route follows for one request, as a guard against a redirect loop. */
export const MAX_REDIRECTS = 5;
const READ_METHODS = ['GET', 'HEAD'];

/** `url` without its query and fragment, so that a recorded URL cannot carry a credential in either. */
export function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<an unparsable URL>';
  }
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** Whether `url` is under one of `prefixes`, each an origin with an optional path prefix. */
export function isAllowed(url: string, prefixes: ReadonlySet<string>): boolean {
  const origin = originOf(url);
  if (origin === undefined) return false;
  for (const prefix of prefixes) {
    const allowed = new URL(prefix);
    if (allowed.origin !== origin) continue;
    // A path prefix matches whole segments: `/v3` allows `/v3` and `/v3/...`, not `/v3admin`.
    const allowedPath = allowed.pathname.replace(/\/$/, '');
    const pathname = new URL(url).pathname;
    if (allowedPath === '' || pathname === allowedPath || pathname.startsWith(`${allowedPath}/`)) return true;
  }
  return false;
}

/**
 * The policy added to every document the route fulfills, top-level or framed: no dedicated or shared
 * worker may start. A worker's own fetch, XHR and WebSocket do not pass through the route, so a worker
 * could reach any server, raw anvil included. The app starts no worker. A frame that a document makes
 * from `about:`, `data:` or `blob:` inherits the policy.
 */
export const DOCUMENT_POLICY = "worker-src 'none'";

/** `headers` with `DOCUMENT_POLICY` added beside any policy the document already has, which stays enforced. */
export function withDocumentPolicy(headers: Record<string, string>): Record<string, string> {
  const existing = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-security-policy');
  const rest = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-security-policy')
  );
  return {
    ...rest,
    'content-security-policy': existing === undefined ? DOCUMENT_POLICY : `${existing[1]}, ${DOCUMENT_POLICY}`,
  };
}

/**
 * The method of the request a browser makes after a redirect of `status`, and whether it drops the body
 * (the Fetch standard's HTTP-redirect fetch): a 303 makes any method but GET and HEAD a GET, a 301 or 302
 * makes a POST a GET, and a 307 or 308 keeps the method and body.
 */
export function redirectedRequest(status: number, method: string): { method: string; isBodyDropped: boolean } {
  const upper = method.toUpperCase();
  if ((status === 303 && !READ_METHODS.includes(upper)) || ((status === 301 || status === 302) && upper === 'POST')) {
    return { method: 'GET', isBodyDropped: true };
  }
  return { method: upper, isBodyDropped: false };
}

const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location'];
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization'];

/**
 * The headers of a redirect hop's request: without the body's headers when the hop drops the body, and
 * without Authorization when the hop goes to another origin, as a browser does. The Cookie header is never
 * copied: the context's cookie jar gives the cookies of the hop's own URL.
 */
export function hopHeaders(
  headers: Record<string, string>,
  { isBodyDropped, isCrossOrigin }: { isBodyDropped: boolean; isCrossOrigin: boolean }
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const lower = name.toLowerCase();
      if (lower === 'cookie' || lower === 'host') return false;
      if (isBodyDropped && BODY_HEADERS.includes(lower)) return false;
      return !(isCrossOrigin && CREDENTIAL_HEADERS.includes(lower));
    })
  );
}

/** Whether `egress` lets a request of `method` reach `url`. */
export function allows(egress: Egress, url: string, method: string): boolean {
  if (isAllowed(url, egress.http)) return true;
  return READ_METHODS.includes(method.toUpperCase()) && isAllowed(url, egress.readOnly ?? new Set());
}

/** Applies `egress` to `context`, and records each blocked request and redirect in `blocked`. */
export async function applyEgress(context: BrowserContext, egress: Egress, blocked: BlockedRequest[]): Promise<void> {
  await context.route('**', async (route) => {
    const request = route.request();
    let url = request.url();
    let method = request.method();
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    if (!allows(egress, url, method)) {
      blocked.push({ kind: 'http', url: withoutQuery(url), method });
      return route.abort('blockedbyclient');
    }
    // The first request goes as the browser made it. Each redirect hop is a request of its own, built here
    // in full and sent through the context's request API with a URL, not the routed request: `route.fetch`
    // reuses the routed request's body whenever none is given, which a hop that drops the body must not.
    let headers = request.headers();
    let body: Buffer | undefined = request.postDataBuffer() ?? undefined;
    for (let redirects = 0; ; redirects++) {
      let response;
      try {
        // No timeout: a screening request the stub holds stays open until the page gives up on it.
        response =
          redirects === 0
            ? await route.fetch({ maxRedirects: 0, timeout: 0 })
            : await context.request.fetch(url, { method, headers, data: body, maxRedirects: 0, timeout: 0 });
      } catch {
        // The page went away, or the server closed the connection.
        return route.abort('failed').catch(() => undefined);
      }
      const location = response.headers()['location'];
      if (response.status() < 300 || response.status() > 399 || location === undefined) {
        const isDocument = request.resourceType() === 'document';
        return route
          .fulfill({ response, headers: isDocument ? withDocumentPolicy(response.headers()) : undefined })
          .catch(() => undefined);
      }
      const next = new URL(location, url).href;
      const hop = redirectedRequest(response.status(), method);
      if (redirects >= MAX_REDIRECTS || !allows(egress, next, hop.method)) {
        blocked.push({ kind: 'redirect', url: withoutQuery(next), from: withoutQuery(url), method: hop.method });
        return route.abort('blockedbyclient').catch(() => undefined);
      }
      headers = hopHeaders(headers, {
        isBodyDropped: hop.isBodyDropped,
        isCrossOrigin: originOf(next) !== originOf(url),
      });
      if (hop.isBodyDropped) body = undefined;
      method = hop.method;
      url = next;
    }
  });
  await context.routeWebSocket(/.*/, (webSocket) => {
    const url = webSocket.url();
    const origin = originOf(url);
    if (origin !== undefined && egress.webSocket.has(origin)) {
      webSocket.connectToServer();
      return;
    }
    blocked.push({ kind: 'websocket', url: withoutQuery(url) });
    void webSocket.close({ code: 1008, reason: 'blocked by the browser harness' });
  });
}

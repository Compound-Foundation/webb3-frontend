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
export type BlockedRequest = {
  kind: 'http' | 'redirect' | 'websocket' | 'popup';
  url: string;
  method?: string;
  from?: string;
};

/**
 * Lets pages at `origin` open a WebSocket to a loopback address, for Vite's HMR on the dev server. The route
 * fulfills every document, and a fulfilled document has no network address, so Chromium's Local Network
 * Access check counts it as public and blocks its WebSocket to 127.0.0.1. Without HMR, Vite cannot reload a
 * page after it re-optimizes dependencies, and the page loads two copies of React.
 *
 * The permission is for the dev server's top-level origin: a top-level page from another origin still gets
 * the check. Frames under a dev page inherit the permission, whatever their origin, the extension frame
 * included. So the check is no boundary for frames. The enforced boundaries there are the route, which
 * decides each HTTP request, `routeWebSocket`, which decides each WebSocket a page or frame opens, and the
 * worker policy (`DOCUMENT_POLICY`).
 */
export async function allowLoopbackWebSocket(context: BrowserContext, origin: string): Promise<void> {
  await context.grantPermissions(['local-network-access'], { origin });
}

/**
 * Closes every page in `context` that the harness did not open itself with `context.newPage()`, as soon as
 * it appears, and records it in `blocked`. A page-created popup is such a page. One opened `noopener` on
 * `about:blank` gets no network response, so the route never fulfills it with the worker policy, and in
 * this Chromium its blank document does not inherit the opener's policy. The opening page cannot reach it
 * (its reference is null), and page-only attempts through such popups reached nothing in the tests, but
 * code that automation injected there could start a worker. So no such page is left open.
 */
export function closePagesItDidNotOpen(context: BrowserContext, blocked: BlockedRequest[]): void {
  // Playwright emits the context's `page` event for a page before `context.newPage()` resolves with it, so
  // each call expects one event, which the handler takes.
  let expectedPages = 0;
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    expectedPages += 1;
    try {
      return await newPage();
    } catch (error) {
      expectedPages = Math.max(0, expectedPages - 1);
      throw error;
    }
  };
  context.on('page', (page) => {
    if (expectedPages > 0) {
      expectedPages -= 1;
      return;
    }
    blocked.push({ kind: 'popup', url: withoutQuery(page.url()) });
    void page.close().catch(() => undefined);
  });
}

/** The most redirects the route follows for one request, as a guard against a redirect loop. */
export const MAX_REDIRECTS = 5;
const READ_METHODS = ['GET', 'HEAD'];

/** `url` without its query and fragment, so that a recorded URL cannot carry a credential in either. */
export function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url);
    if (['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return `${parsed.origin}${parsed.pathname}`;
    if (parsed.protocol === 'about:') return `about:${parsed.pathname}`;
    // A blob URL by the origin that made it; any other scheme, such as data: or javascript:, by name only.
    if (parsed.protocol === 'blob:') return `blob:${new URL(parsed.pathname).origin}/…`;
    return `${parsed.protocol}…`;
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
 *
 * One document has no policy: a popup a page opens `noopener` on `about:blank`. It gets no network
 * response, so the route never fulfills it, and in this Chromium its blank document does not inherit the
 * opener's policy. The page cannot reach it, since its reference is null, and the page-only variants the
 * tests try (`javascript:`, `data:` and `blob:` URLs, `noopener` links, a named popup reacquired, an
 * opener cleared) reached nothing. Code that automation injected into it could start a worker. So a
 * harness context closes every page it did not open (`closePagesItDidNotOpen`).
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

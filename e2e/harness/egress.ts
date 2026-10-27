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
 * Chromium's launch arguments for a harness browser. The route fulfills every document, and a fulfilled
 * document has no network address, so Chromium's Local Network Access check counts it as public and blocks
 * its WebSocket to 127.0.0.1, Vite's HMR among them. Without HMR, Vite cannot reload a page after it
 * re-optimizes dependencies, and the page loads two copies of React. The route already decides every
 * request and WebSocket, so the check adds nothing here.
 */
export const BROWSER_ARGS = ['--disable-features=LocalNetworkAccessChecks'];

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
    let postData = request.postDataBuffer() ?? undefined;
    for (let redirects = 0; ; redirects++) {
      let response;
      try {
        // No timeout: a screening request the stub holds stays open until the page gives up on it.
        response = await route.fetch({ url, method, postData, maxRedirects: 0, timeout: 0 });
      } catch {
        // The page went away, or the server closed the connection.
        return route.abort('failed').catch(() => undefined);
      }
      const location = response.headers()['location'];
      if (response.status() < 300 || response.status() > 399 || location === undefined) {
        return route.fulfill({ response }).catch(() => undefined);
      }
      const next = new URL(location, url).href;
      // 307 and 308 keep the method and body. The other redirects become a GET without a body, as a browser
      // makes them.
      if (![307, 308].includes(response.status())) {
        method = method === 'HEAD' ? 'HEAD' : 'GET';
        postData = undefined;
      }
      if (redirects >= MAX_REDIRECTS || !allows(egress, next, method)) {
        blocked.push({ kind: 'redirect', url: withoutQuery(next), from: withoutQuery(url), method });
        return route.abort('blockedbyclient').catch(() => undefined);
      }
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

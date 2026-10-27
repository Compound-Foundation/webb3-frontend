// The browser's network boundary. A context reaches only the exact origins a test needs: the app, the
// HTTPS RPC proxy and the screening stub, plus Vite's HMR WebSocket on the dev server. Every other HTTP
// request is aborted and every other WebSocket is closed, including the raw anvil fork, the upstream proxy,
// the wallet server and every production host. Service workers are blocked by the context options
// (`serviceWorkers: 'block'`), because Playwright's routes do not see their requests.
import type { BrowserContext } from '@playwright/test';

export type Egress = { http: ReadonlySet<string>; webSocket: ReadonlySet<string> };
export type BlockedRequest = { kind: 'http' | 'websocket'; url: string };

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

/** Applies `egress` to `context`, and records each blocked request in `blocked`. */
export async function applyEgress(context: BrowserContext, egress: Egress, blocked: BlockedRequest[]): Promise<void> {
  await context.route('**', (route) => {
    const url = route.request().url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    if (isAllowed(url, egress.http)) return route.continue();
    blocked.push({ kind: 'http', url: withoutQuery(url) });
    return route.abort('blockedbyclient');
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

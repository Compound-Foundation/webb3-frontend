// The provider that Playwright injects into the app page with `addInitScript`. It announces itself over
// EIP-6963 as `io.metamask`, so the app lists it through its existing wallet list (`KNOWN_WALLETS`) with no
// change under `src/`. It holds no key, no token and no address of any harness service: every call goes
// through the Playwright binding named `bindingName`, whose handler runs in the test worker.
//
// `installHarnessProvider` is serialized into the page, so it must not use imports or anything outside its
// own body.

export const BINDING_NAME = '__compoundHarnessWallet';
export const PROVIDER_NAME = 'MetaMask (harness)';
export const PROVIDER_RDNS = 'io.metamask';
/** A plain grey square, as a data URI, because the app drops any icon that is not one. */
export const PROVIDER_ICON =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#888"/></svg>'
  ).toString('base64');

export type ProviderArguments = { appOrigin: string; bindingName: string; name: string; icon: string; rdns: string };

export function installHarnessProvider(args: ProviderArguments): void {
  // Only the app's own top frame gets the provider: never an extension frame or another origin.
  if (window.top !== window || window.location.origin !== args.appOrigin) return;

  type Listener = (data: unknown) => void;
  type Answer = { result?: unknown; error?: { code: number; message: string; data?: unknown } };
  const binding = () =>
    (
      window as unknown as Record<
        string,
        (payload: unknown) => Promise<Answer & { cursor?: number; events?: unknown[] }>
      >
    )[args.bindingName];
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, data: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      try {
        listener(data);
      } catch (error) {
        console.error('harness provider listener failed', error);
      }
    }
  };

  const provider = {
    selectedAddress: null as string | null,
    chainId: null as string | null,
    async request({ method, params }: { method: string; params?: unknown }) {
      const answer = await binding()({ kind: 'rpc', method, params: params === undefined ? [] : params });
      if (answer.error !== undefined) {
        const error = new Error(answer.error.message) as Error & { code: number; data?: unknown };
        error.code = answer.error.code;
        if (answer.error.data !== undefined) error.data = answer.error.data;
        throw error;
      }
      if (method === 'eth_chainId') provider.chainId = answer.result as string;
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        provider.selectedAddress = (answer.result as string[])[0] ?? null;
      }
      return answer.result;
    },
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(listener);
      return provider;
    },
    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
      return provider;
    },
  };

  // One uuid for the page's life: the app flags an rdns announced under two uuids as a conflict.
  const info = Object.freeze({ uuid: crypto.randomUUID(), name: args.name, icon: args.icon, rdns: args.rdns });
  const announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  // The wallet's events, in the server's order, by long poll.
  void (async () => {
    let cursor: number | undefined;
    for (;;) {
      try {
        if (typeof binding() !== 'function') throw new Error('binding not ready');
        const answer = await binding()({ kind: 'events', cursor });
        if (answer.error !== undefined) throw new Error(answer.error.message);
        cursor = answer.cursor;
        for (const event of (answer.events ?? []) as { type: string; data: unknown }[]) {
          if (event.type === 'accountsChanged') provider.selectedAddress = (event.data as string[])[0] ?? null;
          if (event.type === 'chainChanged') provider.chainId = event.data as string;
          emit(event.type, event.data);
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  })();
}

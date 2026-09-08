(function () {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).global ||= window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.global as any) = globalThis;
})();

// React 19's dev-build performance instrumentation JSON.stringifies component prop
// diffs, and throws on our BigInt-heavy market data ("Do not know how to serialize
// a BigInt"), crashing the commit phase mid-render (facebook/react#35004). Teach
// JSON.stringify to serialize BigInts in dev builds until React ships a fix.
if (import.meta.env.DEV) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (BigInt.prototype as any).toJSON ??= function (this: bigint) {
    return this.toString();
  };
}

export {};

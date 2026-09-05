type Watcher = typeof import('@helpers/eip6963Security');

// Fresh module per test: the watcher is a singleton behind an idempotency flag.
function loadWatcher(): Watcher {
  let watcher: Watcher | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    watcher = require('@helpers/eip6963Security');
  });
  const loaded = watcher as Watcher;
  loaded.startEip6963Watcher();
  return loaded;
}

function announce(rdns: string, uuid: string) {
  const detail = {
    info: { rdns, uuid, name: rdns, icon: 'data:image/png;base64,AA' },
    provider: { isFake: true },
  };
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  return detail;
}

describe('eip6963Security', () => {
  test('same rdns announced under two uuids is conflicted, and subscribers hear it once', () => {
    const watcher = loadWatcher();
    const listener = jest.fn();
    watcher.subscribeToConflicts(listener);

    announce('io.metamask', 'uuid-real');
    announce('io.metamask', 'uuid-fake');
    announce('io.metamask', 'uuid-fake'); // already conflicted: no second notification

    expect(watcher.getConflictedRdns().has('io.metamask')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('re-announcement with the same uuid is not a conflict', () => {
    const watcher = loadWatcher();

    announce('io.rabby', 'uuid-1');
    announce('io.rabby', 'uuid-1');

    expect(watcher.getConflictedRdns().size).toBe(0);
  });

  test('distinct wallets do not conflict with each other', () => {
    const watcher = loadWatcher();

    announce('io.metamask', 'uuid-1');
    announce('io.rabby', 'uuid-2');

    expect(watcher.getConflictedRdns().size).toBe(0);
  });

  test('freezes the announced detail and info, but not the provider', () => {
    loadWatcher();

    const detail = announce('io.metamask', 'uuid-1');

    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(detail.info)).toBe(true);
    expect(Object.isFrozen(detail.provider)).toBe(false);
  });

  test('ignores malformed announcements without throwing', () => {
    const watcher = loadWatcher();

    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: null }));
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: {} }));
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns: 42, uuid: 'u' } } }),
    );

    expect(watcher.getConflictedRdns().size).toBe(0);
  });

  test('snapshot reference is stable until a conflict changes it', () => {
    const watcher = loadWatcher();

    const before = watcher.getConflictedRdns();
    announce('io.metamask', 'uuid-1');
    expect(watcher.getConflictedRdns()).toBe(before);

    announce('io.metamask', 'uuid-2');
    expect(watcher.getConflictedRdns()).not.toBe(before);
    expect(watcher.getConflictedRdns()).toBe(watcher.getConflictedRdns());
  });

  test('startEip6963Watcher is idempotent', () => {
    const watcher = loadWatcher();
    watcher.startEip6963Watcher(); // second call must not double-register

    const listener = jest.fn();
    watcher.subscribeToConflicts(listener);
    announce('io.metamask', 'uuid-1');
    announce('io.metamask', 'uuid-2');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('requests re-announcement on start, so it hears wallets that announced first', () => {
    // A wallet that announced before the watcher started re-announces (same uuid, per
    // spec) when it hears eip6963:requestProvider.
    const wallet = (rdns: string, uuid: string) => () => announce(rdns, uuid);
    window.addEventListener('eip6963:requestProvider', wallet('io.metamask', 'uuid-early'));

    const watcher = loadWatcher();
    announce('io.metamask', 'uuid-impostor');

    expect(watcher.getConflictedRdns().has('io.metamask')).toBe(true);
  });
});

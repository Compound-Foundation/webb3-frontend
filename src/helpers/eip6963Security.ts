import { useSyncExternalStore } from 'react';

/**
 * Passive EIP-6963 anomaly watcher. It never connects to anything — wagmi's discovery
 * remains the only connection path. It exists because wagmi keeps the FIRST connector
 * per RDNS and silently drops later announcements, so a malicious extension that
 * announces a known wallet's RDNS before the real one replaces it with no signal.
 * We listen to the same announcements, freeze them, and flag any RDNS announced under
 * two different uuids so the UI can warn instead of silently dropping.
 */

type AnnouncedDetail = { info: { rdns: string; uuid: string }; provider: unknown };

const announcedUuidByRdns = new Map<string, string>();
// Frozen snapshots, replaced (never mutated) on change, so useSyncExternalStore sees a
// stable reference between changes.
let conflictedSnapshot: ReadonlySet<string> = Object.freeze(new Set<string>());
let announcedSnapshot: ReadonlySet<string> = Object.freeze(new Set<string>());
const conflictListeners = new Set<() => void>();
let started = false;

function notifyListeners() {
  conflictListeners.forEach((listener) => {
    // One subscriber throwing must not swallow the change for the others — this is the
    // notification that makes the UI warn and the live session disconnect.
    try {
      listener();
    } catch (error) {
      console.error('EIP-6963 listener failed:', error);
    }
  });
}

function isAnnouncedDetail(detail: unknown): detail is AnnouncedDetail {
  if (detail === null || typeof detail !== 'object') return false;
  const info = (detail as { info?: unknown }).info;
  if (info === null || info === undefined || typeof info !== 'object') return false;
  const { rdns, uuid } = info as { rdns?: unknown; uuid?: unknown };
  return typeof rdns === 'string' && rdns.length > 0 && typeof uuid === 'string' && uuid.length > 0;
}

function onAnnounce(event: Event) {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!isAnnouncedDetail(detail)) return;

  // Wagmi's store holds this same object, so freezing here stops any script that runs
  // AFTER us from swapping `detail.provider` or rewriting `detail.info`. It is not a
  // guarantee against a listener registered before ours, which sees the object first —
  // starting the watcher ahead of `createConfig` is the most we can do about that.
  // The provider itself stays mutable: wallets legitimately reassign
  // `selectedAddress`/`chainId` on it, and freezing it would break them.
  // Each freeze is guarded separately so an exotic (throwing Proxy) outer object still
  // leaves `info` frozen.
  try {
    Object.freeze(detail);
  } catch {
    // Unfreezable, but still trackable below.
  }
  try {
    Object.freeze(detail.info);
  } catch {
    // Same.
  }

  const { rdns, uuid } = detail.info;
  const knownUuid = announcedUuidByRdns.get(rdns);
  if (knownUuid === undefined) {
    announcedUuidByRdns.set(rdns, uuid);
    const nextAnnounced = new Set(announcedSnapshot);
    nextAnnounced.add(rdns);
    announcedSnapshot = Object.freeze(nextAnnounced);
    notifyListeners();
    return;
  }
  // Re-announcements reuse the page-lifetime uuid; a different uuid means two distinct
  // providers are claiming the same identity.
  if (knownUuid === uuid || conflictedSnapshot.has(rdns)) return;

  const next = new Set(conflictedSnapshot);
  next.add(rdns);
  conflictedSnapshot = Object.freeze(next);
  notifyListeners();
}

/**
 * Idempotent; call before wagmi's `createConfig` so no announcement is missed. A wallet
 * that (violating the spec) regenerates its uuid per announcement will false-positive
 * here — that fails safe: the wallet is hidden and the user told to check extensions.
 */
export function startEip6963Watcher(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  // Wallets that announced before we registered re-announce on request, with the same
  // uuid, so this cannot create false conflicts.
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

/** RDNS values announced under more than one uuid this page load. */
export function getConflictedRdns(): ReadonlySet<string> {
  return conflictedSnapshot;
}

/**
 * Every rdns announced this page load, conflicted or not, allowlisted or not. This is
 * the announcement source itself, unlike wagmi's connector list, which drops any rdns a
 * configured connector already claims (the Coinbase SDK claims `com.coinbase.wallet`).
 * Callers deciding "did anything announce at all" must use this.
 */
export function getAnnouncedRdns(): ReadonlySet<string> {
  return announcedSnapshot;
}

export function subscribeToConflicts(listener: () => void): () => void {
  conflictListeners.add(listener);
  return () => {
    conflictListeners.delete(listener);
  };
}

export function useConflictedRdns(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeToConflicts, getConflictedRdns, getConflictedRdns);
}

export function useAnnouncedRdns(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeToConflicts, getAnnouncedRdns, getAnnouncedRdns);
}

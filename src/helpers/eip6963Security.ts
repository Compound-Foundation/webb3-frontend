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
// Frozen snapshot, replaced (never mutated) on change, so useSyncExternalStore sees a
// stable reference between conflicts.
let conflictedSnapshot: ReadonlySet<string> = Object.freeze(new Set<string>());
const conflictListeners = new Set<() => void>();
let started = false;

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

  // Wagmi's store holds this same object, so freezing here stops any later script from
  // swapping `detail.provider` or rewriting `detail.info`. The provider itself stays
  // mutable: wallets legitimately reassign `selectedAddress`/`chainId` on it.
  try {
    Object.freeze(detail);
    Object.freeze(detail.info);
  } catch {
    // An exotic object (a throwing Proxy) that can't be frozen can still be tracked.
  }

  const { rdns, uuid } = detail.info;
  const knownUuid = announcedUuidByRdns.get(rdns);
  if (knownUuid === undefined) {
    announcedUuidByRdns.set(rdns, uuid);
    return;
  }
  // Re-announcements reuse the page-lifetime uuid; a different uuid means two distinct
  // providers are claiming the same identity.
  if (knownUuid === uuid || conflictedSnapshot.has(rdns)) return;

  const next = new Set(conflictedSnapshot);
  next.add(rdns);
  conflictedSnapshot = Object.freeze(next);
  conflictListeners.forEach((listener) => listener());
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

export function subscribeToConflicts(listener: () => void): () => void {
  conflictListeners.add(listener);
  return () => {
    conflictListeners.delete(listener);
  };
}

export function useConflictedRdns(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeToConflicts, getConflictedRdns, getConflictedRdns);
}

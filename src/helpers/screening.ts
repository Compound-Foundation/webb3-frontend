/**
 * Wallet address screening client.
 *
 * On wallet connect (and on the `?account=` view-as path), `useAddressScreening`
 * calls this against a Cloudflare Worker that lives in a SEPARATE repo. This module
 * is the single source of truth for the request/response contract — change it here
 * if the worker changes.
 *
 * Contract:
 *   Request:  GET ${VITE_SCREENING_ENDPOINT}?address=<lowercased-addr>
 *   Response: 200 { flagged: boolean }   // true = on the list; threat detail is not exposed
 *
 * "Allowed" means strictly `flagged === false`. Everything else is BLOCKED
 * (fail-closed): flagged === true, a missing/non-boolean `flagged` field,
 * non-2xx, malformed body, network error, or the AbortController timeout. There is
 * deliberately no path where an error or unexpected shape lets a wallet through.
 *
 * The worker gates abuse with a CORS Origin allowlist + per-IP rate limiting, so the
 * app's origin must be allowlisted on the worker side (else requests fail closed).
 */
import { SCREENING_URL } from '../../envVars';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Screen an address against the screening endpoint. Fail-closed: any error,
 * non-2xx, malformed body, or timeout resolves to `false` (blocked).
 */
export async function screenAddress(address: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${SCREENING_URL}?address=${encodeURIComponent(address.toLowerCase())}`;
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) return false;
    const data = await res.json();
    // Worker returns { flagged }; "allowed" means strictly not flagged.
    // A missing/non-boolean field → not `=== false` → blocked (fail-closed).
    return data?.flagged === false;
  } catch (error) {
    console.error('Address screening failed (fail-closed):', error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parent origins we accept as Safe{Wallet} when the app runs as a Safe App.
 *
 * Inside a Safe the parent frame is the signer: it reports the account and receives
 * every transaction request. Without an allowlist the Safe SDK trusts any page that
 * frames us, leaving the edge worker's CSP `frame-ancestors` as the only check. This
 * keeps a second, independent one in the app.
 *
 * Anchored and escaped on purpose: an unanchored `/app.safe.global$/` also matches
 * lookalikes such as `https://myapp-safe.global`. Keep in sync with `frame-ancestors`
 * in frontend-devops' pinata-ipfs-worker.
 */
export const SAFE_ALLOWED_DOMAINS: RegExp[] = [/^https:\/\/app\.safe\.global$/];

// The harness's private configuration from the environment. None of it is a `VITE_*` variable, so none of it
// reaches the app's bundle unless the harness passes it on deliberately.

/**
 * The optional production v3 API: a public, credential-free HTTPS base URL, with no user, query or fragment,
 * and no path segment that looks like a key. Its displays are production data, not fork state.
 */
export function v3ApiUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.BROWSER_TEST_V3_API_URL;
  if (value === undefined || value === '') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('BROWSER_TEST_V3_API_URL is not a URL.');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    segments.some((segment) => segment.length >= 6 && !/^[A-Za-z]+(?:[-_.][A-Za-z]+)*$/.test(segment))
  ) {
    throw new Error(
      'BROWSER_TEST_V3_API_URL must be a public HTTPS base URL with no credentials, query, fragment or key-like path. ' +
        'Keep a credentialed API behind a proxy of your own.'
    );
  }
  return url.href.replace(/\/$/, '');
}

/** The v3 API paths the app reads (`src/helpers/urls.ts`). The browser may only GET or HEAD under these. */
export const V3_API_READ_PATHS = ['/market', '/governance', '/account', '/legacy'];

/** The read-only egress prefixes for a v3 API base URL. */
export const v3ApiReadPrefixes = (base: string | null) =>
  base === null ? [] : V3_API_READ_PATHS.map((each) => `${base}${each}`);

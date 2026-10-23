// The rules and the upstream proxy of the wrapped lending fork runner, `scripts/test-wrapped-lending-fork.js`.
// They live apart from the runner so that its own tests, `yarn test:fork-runner`, can check them without a fork:
// - the upstream endpoints, and the redaction of the private URL
// - the proxy that holds the URL, its read-only method allowlist, and its check of a private upstream's results
// - each matrix cell held to Jest's own result for its test
// - the retry rule, for a fork that could not start and for a suite that failed on the upstream
// - the verdict
import http from 'http';
import { StringDecoder } from 'string_decoder';

/** The block docs/anchorage-wrapper-registry.md records its deployment reads at, and its hash. */
export const PINNED_BLOCK = 26244888;
export const PINNED_HASH = '0x440c51a6a6953b880568c1b60e4ad59044f3fa783e340e34d66793e466883839';
/** Public endpoints, in order of preference. Some of them serve old state, and some only recent state. */
export const PUBLIC_ENDPOINTS = [
  'https://eth.drpc.org',
  'https://mainnet.gateway.tenderly.co',
  'https://eth-mainnet.public.blastapi.io',
  'https://rpc.mevblocker.io',
  'https://ethereum-rpc.publicnode.com',
];
export const MARKET_COLUMNS = ['USDC', 'USDT', 'institutional USDC', 'factory'];
/**
 * anvil's own error when it cannot fetch the fork's state from the upstream. Its fork backend words
 * it as `failed to get account for <address>: <the upstream's error>`, and the same for storage, a
 * block hash, a full block and a transaction. A test's failure reason carries it when ethers passes
 * anvil's answer on.
 */
export const FORK_FETCH_ERROR = /failed to get (?:account for|storage for|block hash for|full block for|transaction) /;
/**
 * anvil's own error when it cannot fetch what it reads from the upstream to start the fork: the
 * chain ID, the fork block, or a genesis account's state. anvil 1.2.3 words the last as `failed to
 * create genesis`, over `failed to get account for <address>: <the upstream's error>`.
 */
export const FORK_STARTUP_FETCH_ERROR = new RegExp(
  `${FORK_FETCH_ERROR.source}|failed to fetch network chain ID|failed to get fork block|[Ff]ailed to get block for block number`
);
/**
 * A refusal by the chain itself: anvil's revert error, ethers' decoded revert of an `eth_call`, or a
 * gas estimate that a revert stopped. A cell that failed on one failed in the app or the test,
 * whatever the upstream did. A fetch failure in an `eth_call` reaches ethers as `missing revert
 * data in call exception`, which this does not match, with anvil's fetch error inside.
 */
export const CHAIN_REFUSAL = /execution reverted|call revert exception|UNPREDICTABLE_GAS_LIMIT/;
/** The largest JSON-RPC body the proxy forwards: far above anything anvil sends. */
export const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;
/**
 * The JSON-RPC methods the proxy forwards: the reads anvil makes to fork mainnet state, and the gas
 * price anvil reads once at start-up. The proxy refuses every other method. Otherwise any local
 * process can send a transaction to mainnet, or a costly call, through the proxy and the key behind it.
 */
export const UPSTREAM_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
]);

/**
 * A part of the private URL that can be a key: 16 characters or more, digits only included. A
 * shorter part, such as `v2`, `eth` or a port, also occurs in ordinary text and figures, and a
 * redaction of it corrupts them. A path segment or a query field can be a shorter key (see
 * `isKeyLikeSegmentOrValue`).
 */
export const isKeyLike = (part) => part.length >= 16;

/**
 * A path segment, a query field, or a query field's name or value, that can be a key. RPC providers
 * put the key in one of these places, and a key there can be short, such as a 12-digit number. So
 * such a part is key-like from 6 characters, unless it is a word of letters only, such as `ethereum`
 * or `eth-mainnet`. Ordinary output carries such words, and a redaction of them corrupts it. A part
 * of at most 5 characters, such as `v2`, `eth` or a chain ID, is too short to be a key.
 */
export const isKeyLikeSegmentOrValue = (part) =>
  isKeyLike(part) || (part.length >= 6 && !/^[A-Za-z]+(?:[-_.][A-Za-z]+)*$/.test(part));

/** `text` with each character that a regular expression reads specially escaped. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A pattern for the hex digits `hex` in either case. */
const eitherCase = (hex) =>
  [...hex].map((digit) => (/[a-f]/.test(digit) ? `[${digit}${digit.toUpperCase()}]` : digit)).join('');

/**
 * A pattern for `character` in each form that an echo of a URL can give it: the character itself,
 * percent-encoded once or twice with hex digits in either case, or a JSON `\u` escape. A JSON
 * string can also write `/`, `"` and `\` after a backslash. A `+` and a space each also match the
 * other, because a form-encoded query writes a space as `+`. `createRedactor` matches letters in
 * either case.
 */
function characterPattern(character) {
  const forms = (character === '+' || character === ' ' ? ['+', ' '] : [character]).flatMap((each) => {
    const bytes = [...Buffer.from(each, 'utf8')].map((byte) => eitherCase(byte.toString(16).padStart(2, '0')));
    const units = [...Array(each.length).keys()].map((index) =>
      eitherCase(each.charCodeAt(index).toString(16).padStart(4, '0'))
    );
    return [
      escapeRegExp(each),
      bytes.map((byte) => `%${byte}`).join(''),
      bytes.map((byte) => `%25${byte}`).join(''),
      units.map((unit) => `\\\\u${unit}`).join(''),
      ...(each === '/' || each === '"' || each === '\\' ? [`\\\\${escapeRegExp(each)}`] : []),
    ];
  });
  return `(?:${forms.join('|')})`;
}

/** `text` percent-decoded, or undefined when its percent-encoding is malformed. */
function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/**
 * The parts of a private URL that can each carry a key, both as the URL is written and as the URL
 * parser reads it:
 * - `segmentsAndFields`: each path segment, and each query field with its name and value
 * - `otherParts`: the host and each of its labels, the query, and the fragment
 */
function urlParts(privateUrl, url) {
  // RFC 3986, appendix B: the URL's parts as written, before the parser normalizes them.
  const [, authority = '', pathname = '', query = '', fragment = ''] =
    /^(?:[^:/?#]+:)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s.exec(privateUrl);
  const fields = (text) =>
    text.split(/[&;]/).flatMap((field) => {
      const equals = field.indexOf('=');
      return equals === -1 ? [field] : [field, field.slice(0, equals), field.slice(equals + 1)];
    });
  return {
    segmentsAndFields: [
      ...pathname.split('/'),
      ...url.pathname.split('/'),
      ...fields(query),
      ...fields(url.search.slice(1)),
      ...[...url.searchParams].flat(),
    ],
    otherParts: [
      authority,
      ...authority.split(/[.:@]/),
      url.host,
      ...url.hostname.split('.'),
      query,
      fragment,
      url.hash.slice(1),
    ],
  };
}

/**
 * The patterns of the secrets in a private URL: the whole URL, and each key-like part of it, as
 * written and decoded. A path segment or a query field is key-like as `isKeyLikeSegmentOrValue`
 * decides, and any other part as `isKeyLike` decides. The part as written decides, so a part whose
 * percent-encoding hides a word is key-like in both forms. Each pattern matches its secret in any
 * mix of the forms that `characterPattern` lists. So an upstream's echo of a key, encoded, decoded or
 * escaped, matches it.
 */
function secretPatternsOf(privateUrl, url) {
  const { segmentsAndFields, otherParts } = urlParts(privateUrl, url);
  const parts = [...segmentsAndFields.filter(isKeyLikeSegmentOrValue), ...otherParts.filter(isKeyLike)].flatMap(
    (part) => [part, decoded(part)].filter((form) => form !== undefined)
  );
  return [...new Set([privateUrl, url.href, ...parts])].map((secret) => [...secret].map(characterPattern).join(''));
}

/**
 * The upstream endpoints to try. A private URL is labelled. The runner redacts from every output
 * the whole URL, and each part of it that can carry a key, in each form an upstream can echo it.
 * For a private endpoint, the runner also prints no text of the upstream's (see `rpc` and
 * `startUpstreamProxy`).
 */
export function upstreamEndpoints(env = process.env) {
  const privateUrl = env.WRAPPED_FORK_RPC_URL;
  if (privateUrl !== undefined && privateUrl !== '') {
    const url = new URL(privateUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('WRAPPED_FORK_RPC_URL must be an HTTP(S) URL.');
    }
    // fetch refuses a URL with credentials, and its error quotes the URL.
    if (url.username !== '' || url.password !== '') {
      throw new Error('WRAPPED_FORK_RPC_URL must not carry a user name or password. Put the key in its path or query.');
    }
    return [
      {
        label: 'WRAPPED_FORK_RPC_URL (private, not printed)',
        url: privateUrl,
        isPrivate: true,
        secretPatterns: secretPatternsOf(privateUrl, url),
      },
    ];
  }
  return PUBLIC_ENDPOINTS.map((url) => ({ label: `${url} (public)`, url, isPrivate: false, secretPatterns: [] }));
}

/**
 * The redaction of the secrets that `secretPatterns` match from the runner's outputs. It replaces
 * each stretch of text that one or more patterns match with `<redacted>`. Two matches that overlap
 * or touch become one stretch, so no part of either secret stays. It matches letters in either
 * case, because an upstream can echo a key in another case.
 */
export function createRedactor(secretPatterns) {
  const expressions = [...new Set(secretPatterns)].map((source) => new RegExp(source, 'gi'));
  const redact = (value) => {
    const text = String(value);
    const matches = [];
    for (const expression of expressions) {
      expression.lastIndex = 0;
      for (let match = expression.exec(text); match !== null; match = expression.exec(text)) {
        if (match[0] !== '') matches.push([match.index, match.index + match[0].length]);
        // The next search starts one character on, so that it also finds an overlapping match.
        expression.lastIndex = match.index + 1;
      }
    }
    matches.sort(([startA], [startB]) => startA - startB);
    const stretches = [];
    for (const [start, end] of matches) {
      const last = stretches[stretches.length - 1];
      if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
      else stretches.push([start, end]);
    }
    let redacted = '';
    let position = 0;
    for (const [start, end] of stretches) {
      redacted += `${text.slice(position, start)}<redacted>`;
      position = end;
    }
    return redacted + text.slice(position);
  };

  /** `value` with each string in it redacted. A redaction of the JSON text instead can break its syntax. */
  function redactStrings(value) {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(redactStrings);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactStrings(entry)]));
    }
    return value;
  }

  /**
   * Writes a child's output to `write` a whole line at a time, each line redacted. A pipe can split a
   * line, and the URL in it, across two chunks, and neither half matches the URL. It can also split
   * a character's UTF-8 bytes, so one decoder reads the whole stream.
   */
  function lineRedactor(write) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    return {
      write: (chunk) => {
        pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
        const end = pending.lastIndexOf('\n');
        if (end === -1) return;
        write(redact(pending.slice(0, end + 1)));
        pending = pending.slice(end + 1);
      },
      end: () => {
        pending += decoder.end();
        if (pending !== '') write(redact(pending));
        pending = '';
      },
    };
  }

  /**
   * `text`, redacted, as one line of printable ASCII of at most 200 characters, for the summary. The
   * redaction comes first, so the cut cannot split a secret that the redaction then misses.
   */
  const printable = (text) =>
    redact(String(text))
      .replace(/[^\x20-\x7e]/g, ' ')
      .slice(0, 200);

  return { redact, redactStrings, lineRedactor, printable };
}

/**
 * A private upstream's JSON-RPC error code, or undefined when it has no integer code of at most five
 * digits. JSON-RPC's codes and the upstreams' own, such as -32000, -32012, 429 or 15, have at most
 * five. An upstream can echo a numeric key as the code, and the redaction misses a code of more than
 * 15 digits, which loses digits when parsed. So the runner neither prints nor relays a longer code.
 */
const errorCode = (error) => (Number.isInteger(error?.code) && Math.abs(error.code) <= 99_999 ? error.code : undefined);

/** A private upstream's JSON-RPC error named by its code alone, so that none of the upstream's text goes with it. */
function describedError(error) {
  if (!Number.isInteger(error?.code)) return 'a JSON-RPC error';
  const code = errorCode(error);
  return code === undefined
    ? 'a JSON-RPC error with a code of more than five digits, withheld'
    : `a JSON-RPC error with code ${code}`;
}

/** Why `fetch` got no answer, by the cause's code alone. A cause's message can name the host. */
function noAnswer(error, timeoutMs) {
  if (error?.name === 'TimeoutError') return `no answer within ${timeoutMs / 1000} s`;
  const code = error?.cause?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? `no connection (${code})` : 'no connection';
}

/**
 * Calls `method` on the JSON-RPC endpoint at `url` and returns the result. A failure throws an
 * error that names the method, and the HTTP status or the reason there was no answer. For a private
 * endpoint (`isPrivate`), the error names a JSON-RPC error by its code alone. An upstream's error
 * text can echo the key, in any encoding, so the runner never prints a private upstream's text.
 */
export async function rpc(url, method, params = [], { timeoutMs = 20_000, isPrivate = false } = {}) {
  let response;
  let text;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    if (response !== undefined && !response.ok) throw error;
    throw new Error(`${method}: ${noAnswer(error, timeoutMs)}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method}: HTTP ${response.status}, an answer that is not JSON`);
  }
  if (body?.error !== undefined && body?.error !== null) {
    throw new Error(
      isPrivate
        ? `${method}: HTTP ${response.status}, ${describedError(body.error)}`
        : `${method}: ${body.error.message ?? JSON.stringify(body.error)}`
    );
  }
  return body?.result;
}

/**
 * The phrases that anvil's retry rule reads in a JSON-RPC error's message: alloy's
 * `ErrorPayload::is_retry_err`, in the alloy 0.12.6 that anvil 1.2.3 is built with. anvil retries a
 * call whose error message contains one of them. For `credits`, it also needs the error code
 * -32012, which the proxy relays. The rule's other phrases, such as `request limit reached` with
 * -32007, contain one of these.
 */
const RETRY_PHRASES = [
  'rate limit',
  'rate exceeded',
  'too many requests',
  'credits limited',
  'credits',
  'request limit',
];
/** The messages that anvil's retry rule matches only whole. */
const RETRY_MESSAGES = ['header not found', 'daily request count exceeded, request rate limited'];

/**
 * The message that anvil gets in place of a private upstream's JSON-RPC error message: only the
 * phrases of anvil's retry rule that the message holds. anvil then retries the call as it would
 * have, and no other text of the upstream's reaches anvil.
 */
export function withheldMessage(message) {
  const text = typeof message === 'string' ? message : '';
  if (RETRY_MESSAGES.includes(text)) return text;
  const phrases = RETRY_PHRASES.filter((phrase) => text.includes(phrase));
  return phrases.length === 0
    ? "the private upstream's message is withheld"
    : `${phrases.join('; ')} (the rest of the private upstream's message is withheld)`;
}

/** `method` if it is a JSON-RPC method name, so that a request cannot write other text into the summary. */
export const methodName = (method) =>
  typeof method === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(method) ? method : '<invalid>';

export const countIn = (counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1);

const hasError = (entry) => entry?.error !== undefined && entry?.error !== null;
const isResponse = (entry) =>
  entry !== null && typeof entry === 'object' && !Array.isArray(entry) && ('result' in entry || 'error' in entry);
/**
 * Whether `parsed` is a bare JSON-RPC error, `{ code, message }`, which some upstreams answer with in
 * place of a response. anvil reads such an answer as an error, and retries it by its code.
 */
const isBareError = (parsed) =>
  parsed !== null &&
  typeof parsed === 'object' &&
  !Array.isArray(parsed) &&
  Number.isInteger(parsed.code) &&
  typeof parsed.message === 'string' &&
  !isResponse(parsed);

/**
 * anvil's backoff hint in a JSON-RPC error's data, `data.rate.backoff_seconds`, as Infura sends it,
 * rounded up to whole seconds, or undefined. anvil prints an error's data in its log, so a hint of
 * more than five digits, or its digits after the point, could carry a numeric key, as a code can
 * (see `errorCode`). A hint of a day, 86400 s, has five.
 */
function backoffSeconds(error) {
  const seconds = error?.data?.rate?.backoff_seconds;
  return typeof seconds === 'number' && seconds >= 0 && seconds <= 99_999 ? Math.ceil(seconds) : undefined;
}

/**
 * A private upstream's JSON-RPC error without its text: its code, `withheldMessage`, and anvil's
 * backoff hint if it has one. An error with no code that `errorCode` keeps gets -32603, the internal
 * error. anvil's retry rule reads only codes of at most five digits, so it retries as it would have.
 */
function withheldError(error) {
  const seconds = backoffSeconds(error);
  return {
    code: errorCode(error) ?? -32603,
    message: withheldMessage(error !== null && typeof error === 'object' ? error.message : undefined),
    ...(seconds === undefined ? {} : { data: { rate: { backoff_seconds: seconds } } }),
  };
}

/** Whether `value` is a hex number of at most 256 bits, as anvil reads a block number, a balance or a storage word. */
const isQuantity = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value);

/** Whether `value` is hex data in whole bytes, as anvil reads an account's code. */
const isData = (value) => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);

/**
 * The deepest that a field of a block, a transaction or a receipt can be. A block's transaction's
 * access list's storage key is at depth 6.
 */
const MAX_FIELD_DEPTH = 8;

/**
 * Whether `value`, at `depth` inside a block, a transaction or a receipt, is a hex field: a hex
 * string, a boolean, null, or an array or a record of hex fields.
 */
function isHexField(value, depth) {
  if (depth > MAX_FIELD_DEPTH) return false;
  if (typeof value === 'string') return /^0x[0-9a-fA-F]*$/.test(value);
  if (typeof value === 'boolean' || value === null) return true;
  if (Array.isArray(value)) return value.every((item) => isHexField(item, depth + 1));
  return isHexRecord(value, depth);
}

/**
 * Whether `value` is a record of hex fields, as anvil reads a block, a transaction or a receipt: an
 * object whose field names are letters and digits, and whose fields are `isHexField`.
 */
function isHexRecord(value, depth = 0) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([name, field]) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) && isHexField(field, depth + 1)
    )
  );
}

/** Whether `value` is null, as for a block or a transaction that the upstream does not know, or a record of hex fields. */
const isRecordOrNull = (value) => value === null || isHexRecord(value);

/**
 * The shape of the result of each method in `UPSTREAM_METHODS`, as anvil reads it. anvil prints a
 * result that it cannot parse, in its log and in its errors to the tests. A private upstream can
 * answer with text in place of a result, such as an error message that echoes the key.
 */
const RESULT_SHAPES = {
  eth_chainId: isQuantity,
  eth_blockNumber: isQuantity,
  eth_gasPrice: isQuantity,
  eth_getBalance: isQuantity,
  eth_getTransactionCount: isQuantity,
  eth_getStorageAt: isQuantity,
  eth_getCode: isData,
  eth_getBlockByNumber: isRecordOrNull,
  eth_getBlockByHash: isRecordOrNull,
  eth_getTransactionByHash: isRecordOrNull,
  eth_getTransactionReceipt: isRecordOrNull,
};

/** Whether `result` has the shape that `RESULT_SHAPES` gives for `method`. */
const hasResultShape = (method, result) => Object.hasOwn(RESULT_SHAPES, method) && RESULT_SHAPES[method](result);

/** The error that anvil gets in place of a private upstream's result that has the wrong shape. */
const MALFORMED_RESULT = { code: -32603, message: "the private upstream's malformed result is withheld" };

/**
 * What the proxy relays to anvil for the upstream's answer, and what it records: an HTTP error as a
 * failure, and each call answered with an error, a bare error included. For a public endpoint, the
 * answer goes to anvil unchanged, and the record keeps each error's message, as `printable` gives it.
 *
 * For a private endpoint, no text of the upstream's reaches anvil. anvil prints the upstream's
 * answer in its log and in its errors to the tests, and an upstream can echo the key there in any
 * encoding. So the proxy rebuilds each answer, and the record names only a status, an error code or
 * a kind of answer:
 * - an HTTP error goes on with its status and no body
 * - each JSON-RPC error, and a bare error, goes on as `withheldError` gives it
 * - each result goes on alone, in its own JSON-RPC response, when it has the shape that its call's
 *   method returns (see `RESULT_SHAPES`). `methodOf` gives the method of a response's call. Any
 *   other result goes on as `MALFORMED_RESULT`, and the record counts it as a call answered with an
 *   error.
 * - an answer that is not JSON, or not a JSON-RPC response, becomes HTTP 502 with no body
 */
function relayed(status, contentType, answer, { isPrivate, printable, methodOf }) {
  const withheld = (error) => ({ status: 502, contentType: 'text/plain', body: Buffer.alloc(0), errors: [error] });
  if (status >= 400) {
    return isPrivate
      ? { status, contentType: 'text/plain', body: Buffer.alloc(0), failure: `HTTP ${status}`, errors: [] }
      : { status, contentType, body: answer, failure: `HTTP ${status}`, errors: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(answer.toString('utf8'));
  } catch {
    return isPrivate
      ? withheld('an answer that is not JSON')
      : { status, contentType, body: answer, errors: ['an answer that is not JSON'] };
  }
  if (isBareError(parsed)) {
    return isPrivate
      ? {
          status,
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify(withheldError(parsed))),
          errors: [describedError(parsed)],
        }
      : { status, contentType, body: answer, errors: [printable(parsed.message)] };
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (!isPrivate) {
    const errors = entries
      .filter(hasError)
      .map((entry) => printable(entry.error.message ?? JSON.stringify(entry.error)));
    return { status, contentType, body: answer, errors };
  }
  if (entries.length === 0 || !entries.every(isResponse)) return withheld('an answer that is not a JSON-RPC response');
  const errors = [];
  const relayedEntries = entries.map((entry) => {
    // An id above 2^53 loses digits when parsed, as a code does (see `errorCode`).
    const id = Number.isSafeInteger(entry.id) ? entry.id : null;
    if (hasError(entry)) {
      errors.push(describedError(entry.error));
      return { jsonrpc: '2.0', id, error: withheldError(entry.error) };
    }
    const method = methodOf(entry);
    if (hasResultShape(method, entry.result)) return { jsonrpc: '2.0', id, result: entry.result };
    errors.push(`a malformed ${method ?? 'JSON-RPC'} result`);
    return { jsonrpc: '2.0', id, error: MALFORMED_RESULT };
  });
  const body = Buffer.from(JSON.stringify(Array.isArray(parsed) ? relayedEntries : relayedEntries[0]));
  return { status, contentType: 'application/json', body, errors };
}

/**
 * Forwards anvil's JSON-RPC requests to the upstream `endpoint`, so that only this process holds the
 * upstream URL. It listens on 127.0.0.1, and it refuses these requests:
 * - a request with an Origin header, which a web page sends
 * - a method other than POST
 * - a content type other than JSON, or a body that is not JSON
 * - a body over 10 MB
 * - an empty batch, or a request or batch that calls a method outside `UPSTREAM_METHODS`
 *
 * It sends anvil no text of its own errors, which can name the upstream URL. A public endpoint's
 * answers reach anvil unchanged. A private endpoint's answers reach anvil without the upstream's
 * text (see `relayed`), and the runner redacts every output. The proxy counts the methods it forwards
 * and each refusal, by its method or reason. It also counts the requests that the upstream failed
 * and the calls it answered with an error. It keeps the first such error for the summary.
 *
 * The proxy waits `timeoutMs` for the upstream's answer, 40 s by default. The runner starts anvil
 * with `--timeout 45000`, so anvil waits 45 s for the proxy. The proxy gives up 5 s sooner, answers
 * anvil with 502, and counts the upstream's failure before anvil reports its own. Otherwise an
 * upstream that never answers leaves the retry rule with no upstream failure to see.
 */
export function startUpstreamProxy(endpoint, { printable, timeoutMs = 40_000 }) {
  const stats = {
    requests: 0,
    failures: 0,
    errorAnswers: 0,
    firstError: undefined,
    // The requests to the upstream that have not settled, and the time of its last failure or error.
    pending: 0,
    lastFailureAt: undefined,
    methods: new Map(),
    refused: new Map(),
  };
  const server = http.createServer((request, response) => {
    const refuse = (status, reason) => {
      if (reason !== undefined) countIn(stats.refused, reason);
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end();
    };
    if (request.headers.origin !== undefined) return refuse(403, '<an Origin header>');
    if (request.method !== 'POST') return refuse(405, '<a method other than POST>');
    if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
      return refuse(415, '<a content type other than JSON>');
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_PROXY_BODY_BYTES) chunks.push(chunk);
      else if (!request.destroyed) {
        countIn(stats.refused, '<a body over 10 MB>');
        request.destroy();
      }
    });
    request.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return refuse(400, '<a body that is not JSON>');
      }
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      const methods = calls.map((call) => methodName(call?.method));
      if (methods.length === 0) return refuse(403, '<an empty batch>');
      const outside = methods.filter((method) => !UPSTREAM_METHODS.has(method));
      if (outside.length > 0) {
        for (const method of outside) countIn(stats.refused, method);
        return refuse(403);
      }
      // The calls the proxy checked, rebuilt from their four JSON-RPC members. A raw body can name a
      // method twice, or under a key in another case, such as `Method`. An upstream can read that name
      // instead of the one that the proxy checked.
      const checked = calls.map(({ jsonrpc, id, method, params }) => ({ jsonrpc, id, method, params }));
      for (const method of methods) countIn(stats.methods, method);
      stats.requests += 1;
      stats.pending += 1;
      try {
        const upstream = await fetch(endpoint.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(Array.isArray(parsed) ? checked : checked[0]),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const answer = Buffer.from(await upstream.arrayBuffer());
        const contentType = upstream.headers.get('content-type') ?? 'application/json';
        // The method of a response's call: the one call, or in a batch, the call with the response's id.
        const methodOf = Array.isArray(parsed)
          ? (entry) => checked.find(({ id }) => id === entry.id)?.method
          : () => checked[0].method;
        const relay = relayed(upstream.status, contentType, answer, {
          isPrivate: endpoint.isPrivate,
          printable,
          methodOf,
        });
        if (relay.failure !== undefined) {
          stats.failures += 1;
          stats.firstError ??= relay.failure;
        }
        stats.errorAnswers += relay.errors.length;
        stats.firstError ??= relay.errors[0];
        if (relay.failure !== undefined || relay.errors.length > 0) stats.lastFailureAt = Date.now();
        response.writeHead(relay.status, { 'content-type': relay.contentType });
        response.end(relay.body);
      } catch {
        stats.failures += 1;
        stats.firstError ??= `no answer within ${timeoutMs / 1000} s, or no connection`;
        stats.lastFailureAt = Date.now();
        refuse(502);
      } finally {
        stats.pending -= 1;
      }
    });
  });
  // anvil's HTTP client keeps an idle connection open for up to 90 s. By default, Node's server
  // closes an idle connection after 5 s. A request that anvil sends as the proxy closes the
  // connection fails before the proxy reads it. So the proxy never closes an idle connection.
  server.keepAliveTimeout = 0;
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, stats, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

/** The scenario and market of a matrix cell's test title, `<scenario> (<market>)`, or undefined. */
export function cellOf(title) {
  const market = MARKET_COLUMNS.find((column) => title.endsWith(` (${column})`));
  return market === undefined ? undefined : { scenario: title.slice(0, -(market.length + 3)), market };
}

/**
 * The cells, each held to Jest's own result for its test. A scenario records its cell when its body
 * settles, which can come after Jest failed the test, for example on a timeout. Such a cell fails.
 * A test that Jest failed can also have recorded no cell. Its `beforeAll` or `beforeEach` hook
 * failed, or its scenario never settled before Jest timed it out. It gets a failed cell, with Jest's
 * failure as the reason.
 */
export function heldToJest(results, jest) {
  const failures = new Map(
    (jest?.tests ?? []).filter((test) => test.status === 'failed').map((test) => [test.title, test.failure])
  );
  const held = results.map((result) => {
    const failure = failures.get(`${result.scenario} (${result.market})`);
    if (failure === undefined || result.status === 'fail') return result;
    return {
      ...result,
      status: 'fail',
      reason: `Jest failed this test after its scenario recorded ${result.status}: ${failure}`,
    };
  });
  const recorded = new Set(results.map((result) => `${result.scenario} (${result.market})`));
  for (const [title, failure] of failures) {
    const cell = cellOf(title);
    if (cell === undefined || recorded.has(title)) continue;
    held.push({
      ...cell,
      status: 'fail',
      reason: `Jest failed this test, and its scenario recorded no cell: ${failure}`,
    });
  }
  return held;
}

/**
 * Whether `run` failed only because the upstream failed to serve the fork's state. At least one
 * cell must have failed, and every failed cell must carry anvil's fetch error and no refusal by the
 * chain. Jest must have reported its results and failed no other test. No suite must have failed
 * outside its tests, as one does when it fails to load or its `afterAll` hook throws. anvil must not
 * have exited. The proxy must have seen the upstream fail or answer with an error.
 */
export function failedOnUpstreamOnly(run) {
  const failed = run.results.filter((result) => result.status === 'fail');
  return (
    run.exitCode !== 0 &&
    !run.anvilExited &&
    failed.length > 0 &&
    run.jest !== undefined &&
    run.jest.numRuntimeErrorTestSuites === 0 &&
    failed.length === run.jest.numFailedTests &&
    run.stats.failures + run.stats.errorAnswers > 0 &&
    failed.every((result) => FORK_FETCH_ERROR.test(result.reason ?? '') && !CHAIN_REFUSAL.test(result.reason ?? ''))
  );
}

/**
 * Whether anvil could not start the fork only because the upstream failed to serve what anvil reads
 * at start-up. The proxy must have seen the upstream fail a request or answer a call with an error,
 * and one of these must hold:
 * - anvil's `output` names a failed fetch. A refusal by the proxy is not an upstream failure, and an
 *   error of anvil's own, such as a port in use, names no fetch.
 * - The runner stopped anvil at its deadline (`isTimedOut`) while the upstream was failing it. anvil
 *   names a failed fetch only when it gives up, and an upstream that fails slowly keeps anvil
 *   retrying past the deadline. So at the deadline, a request to the upstream must still be open,
 *   or the upstream must have failed within the last 45 s, the time anvil waits for an answer.
 *   An upstream failure long before the deadline points to anvil, such as output the runner does
 *   not read as ready.
 */
export const failedToStartOnUpstream = ({ stats, output, isTimedOut = false, now = Date.now() }) =>
  stats.failures + stats.errorAnswers > 0 &&
  (FORK_STARTUP_FETCH_ERROR.test(output) ||
    (isTimedOut && (stats.pending > 0 || now - (stats.lastFailureAt ?? -Infinity) <= 45_000)));

/** The last second that a JavaScript date can hold: 8.64e15 ms after 1970. */
const LAST_DATE_SECONDS = 8.64e12;

/**
 * Whether `answer`, an upstream's latest block number, is a hex number below 2^32. The runner
 * prints the block it forks, and a longer number can be a numeric key that no redaction matches
 * once the runner subtracts its lag from it.
 */
export const isBlockNumber = (answer) => typeof answer === 'string' && /^0x[0-9a-fA-F]{1,8}$/.test(answer);

/**
 * Whether the block `header` that an upstream reports has a 32-byte hash and a hex timestamp that a
 * date can hold. The runner prints both in its header. Otherwise a private upstream's text can reach
 * the console in them, and a timestamp that is not a date stops the run after anvil started.
 */
export const isBlockHeader = (header) =>
  /^0x[0-9a-fA-F]{64}$/.test(header?.hash ?? '') &&
  /^0x[0-9a-fA-F]{1,16}$/.test(header?.timestamp ?? '') &&
  Number(header.timestamp) <= LAST_DATE_SECONDS;

/**
 * Whether the runner runs the suite once more after `run`: anvil could not start the fork on the
 * upstream, or the suite failed only on the upstream. The runner runs the suite at most twice.
 */
export const isRetryable = (run) => run.startupFailure !== undefined || failedOnUpstreamOnly(run);

/** `endpoints` with `last` moved to the end, so that a retry tries the other endpoints first. */
export const withLast = (endpoints, last) => [...endpoints.filter((endpoint) => endpoint !== last), last];

/**
 * The block and the endpoints that the retry after `failedRun` forks from. A recent block can leave
 * the endpoint's window of recent state during a run, so a recent-block run retries from a fresh
 * recent block. The pinned block, or a given one, stays, so that the retry tests the same state. It
 * tries the other endpoints first and the failed one last.
 */
export function retryFork(blockOption, failedRun, endpoints) {
  const isRecentBlockRun = blockOption === 'recent' || (blockOption === 'auto' && failedRun.target.mode === 'recent');
  return isRecentBlockRun
    ? { block: 'recent', endpoints }
    : { block: String(failedRun.target.number), endpoints: withLast(endpoints, failedRun.endpoint) };
}

/**
 * The matrix's scenarios, in the order a reader follows them. When no run starts the fork, the
 * runner records each of them as not exercised. A scenario not listed here comes last in the matrix.
 */
export const SCENARIO_ORDER = [
  'deployment',
  'source-build',
  'supply-zero-allowance',
  'supply-sufficient-allowance',
  'supply-insufficient-allowance',
  'accrued-value',
  'partial-exit',
  'partial-exit-delayed',
  'partial-exit-held-open',
  'partial-exit-held-too-long',
  'full-exit',
  'dust',
  'pause',
  'insufficient-liquidity',
  'excessive-debit',
  'estimate-rose',
  'stale-state',
  'session-races',
  'other-connectors-and-watch-only',
  'direct-alongside',
  'standard-route-lending',
];

/**
 * Every cell of the full matrix: each scenario on each wrapped market, and the factory's
 * `source-build`, the one scenario that the suite runs on the factory.
 */
export const MATRIX_CELLS = SCENARIO_ORDER.flatMap((scenario) =>
  MARKET_COLUMNS.filter((market) => market !== 'factory' || scenario === 'source-build').map((market) => ({
    scenario,
    market,
  }))
);

/** Every cell of the full matrix, not exercised, with `reason`. */
export const notExercisedCells = (reason) => MATRIX_CELLS.map((cell) => ({ ...cell, status: 'not-exercised', reason }));

/**
 * The verdict on `runs`. It comes from the final run: the last run that ran the suite, or the last
 * run when none did.
 * - When no run started the fork, every cell was not exercised, and the result is NOT EXERCISED.
 * - A cell that failed only because the upstream failed to serve the fork's state was not
 *   exercised, and the result is NOT EXERCISED.
 * - The result is PASS only when Jest passed, and the run recorded cells, none of which failed.
 *   Otherwise it is FAIL.
 */
export function finalVerdict(runs) {
  const final = runs.findLast((run) => run.startupFailure === undefined) ?? runs[runs.length - 1];
  if (final.startupFailure !== undefined) {
    return { final, results: final.results, exitCode: 1, verdict: 'NOT EXERCISED' };
  }
  const isUpstreamOnly = failedOnUpstreamOnly(final);
  const results = isUpstreamOnly
    ? final.results.map((result) =>
        result.status === 'fail'
          ? {
              ...result,
              status: 'not-exercised',
              reason: `the upstream failed to serve the fork's state: ${result.reason}`,
            }
          : result
      )
    : final.results;
  const hasFailed = results.length === 0 || results.some((result) => result.status === 'fail');
  const exitCode = final.exitCode === 0 && hasFailed ? 1 : final.exitCode;
  return { final, results, exitCode, verdict: exitCode === 0 ? 'PASS' : isUpstreamOnly ? 'NOT EXERCISED' : 'FAIL' };
}

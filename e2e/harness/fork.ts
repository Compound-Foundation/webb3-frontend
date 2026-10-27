// The browser harness's mainnet fork: the upstream endpoints, the redaction of a private upstream URL, the
// read-only upstream proxy that anvil forks through, and anvil's start, identity check and stop.
//
// Adapted from COM-289's wrapped lending fork runner at commit 2fa1c72 (PR #67):
// `scripts/lib/wrapped-fork-runner.js` (endpoints, redaction, `rpc`, the upstream proxy and its check of a
// private upstream's results) and `scripts/test-wrapped-lending-fork.js` (`forkTarget`, `startFork`,
// `verifyFork`, `stopped`). It is a copy, so that this harness does not depend on #67; the two are to be
// merged into one module once #67 is on main. The changes from the source:
// - The private URL comes from BROWSER_FORK_RPC_URL.
// - The proxy also forwards a bounded `eth_getLogs` (`isBoundedLogQuery`), because anvil forwards a
//   historical log query upstream. A private upstream's answer to it must be a bounded array of logs
//   (`isLogArray`). The proxy reads at most 64 MB of any answer.
// - anvil starts with `--accounts 0`, so it holds no unlocked account and can sign nothing.
// - The matrix, verdict and retry rules of the wrapped lending suite are left out.
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** COM-289's pinned block, and its hash. */
export const PINNED_BLOCK = 26244888;
export const PINNED_HASH = '0x440c51a6a6953b880568c1b60e4ad59044f3fa783e340e34d66793e466883839';
/** Public endpoints, in order of preference. Some serve old state, and some only recent state. */
export const PUBLIC_ENDPOINTS = [
  'https://eth.drpc.org',
  'https://mainnet.gateway.tenderly.co',
  'https://eth-mainnet.public.blastapi.io',
  'https://rpc.mevblocker.io',
  'https://ethereum-rpc.publicnode.com',
];
/** A recent fork stays this many blocks behind the endpoint's latest. */
export const RECENT_BLOCK_LAG = 8;
/** The EVM rules the fork runs: Prague, the latest that anvil 1.2.3 knows. Mainnet runs Osaka. */
export const HARDFORK = 'prague';
/** The largest JSON-RPC body the proxy forwards. */
export const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;
/** The most logs the proxy relays in one private `eth_getLogs` answer. */
export const MAX_RELAYED_LOGS = 10_000;
/** The widest block range of an `eth_getLogs` query the proxy forwards. */
export const MAX_LOG_BLOCK_RANGE = 10_000;
/** The largest upstream answer the proxy reads. */
export const MAX_UPSTREAM_ANSWER_BYTES = 64 * 1024 * 1024;

/**
 * anvil's own error when it cannot fetch what it reads from the upstream to start the fork.
 */
export const FORK_STARTUP_FETCH_ERROR =
  /failed to get (?:account for|storage for|block hash for|full block for|transaction) |failed to fetch network chain ID|failed to get fork block|[Ff]ailed to get block for block number/;

/**
 * The JSON-RPC methods the proxy forwards: the reads anvil makes to fork mainnet state. The proxy refuses
 * every other method, so no local process can send a transaction through it. `eth_getLogs` is the one
 * costly read, so the proxy forwards only a bounded query (`isBoundedLogQuery`).
 */
export const UPSTREAM_METHODS: ReadonlySet<string> = new Set([
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
  'eth_getLogs',
]);

/**
 * Whether `params` is an `eth_getLogs` query the proxy forwards: by block hash, or for named addresses over
 * at most `MAX_LOG_BLOCK_RANGE` blocks given as numbers. A query of every address over the chain's history
 * would spend a private key's credits.
 */
export function isBoundedLogQuery(params: unknown): boolean {
  const [filter] = Array.isArray(params) ? params : [];
  if (filter === null || typeof filter !== 'object') return false;
  const { blockHash, address, fromBlock, toBlock } = filter as Record<string, unknown>;
  if (typeof blockHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(blockHash)) return true;
  const hasAddress =
    (typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address)) ||
    (Array.isArray(address) &&
      address.length > 0 &&
      address.length <= 20 &&
      address.every((each) => typeof each === 'string'));
  const isNumber = (value: unknown): value is string =>
    typeof value === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(value);
  return (
    hasAddress &&
    isNumber(fromBlock) &&
    isNumber(toBlock) &&
    Number(toBlock) - Number(fromBlock) <= MAX_LOG_BLOCK_RANGE &&
    Number(toBlock) >= Number(fromBlock)
  );
}

/** Reads a response body, and throws once it passes `limit` bytes. */
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body === null) return Buffer.alloc(0);
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > limit) throw new Error('an answer over the size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export type Endpoint = { label: string; url: string; isPrivate: boolean; secretPatterns: string[] };

/** A part of the private URL that can be a key: 16 characters or more. */
export const isKeyLike = (part: string) => part.length >= 16;

/**
 * A path segment or a query field that can be a key: key-like from 6 characters, unless it is a word of
 * letters only, such as `ethereum` or `eth-mainnet`.
 */
export const isKeyLikeSegmentOrValue = (part: string) =>
  isKeyLike(part) || (part.length >= 6 && !/^[A-Za-z]+(?:[-_.][A-Za-z]+)*$/.test(part));

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const eitherCase = (hex: string) =>
  [...hex].map((digit) => (/[a-f]/.test(digit) ? `[${digit}${digit.toUpperCase()}]` : digit)).join('');

/**
 * A pattern for `character` in each form an echo of a URL can give it: itself, percent-encoded once or
 * twice, or a JSON `\u` escape. `+` and a space each also match the other.
 */
function characterPattern(character: string): string {
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

function decoded(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** The parts of a private URL that can each carry a key, as written and as the URL parser reads it. */
function urlParts(privateUrl: string, url: URL) {
  // RFC 3986, appendix B: the URL's parts as written, before the parser normalizes them.
  const match = /^(?:[^:/?#]+:)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s.exec(privateUrl) ?? [];
  const [, authority = '', pathname = '', query = '', fragment = ''] = match;
  const fields = (text: string) =>
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

/** The patterns of the secrets in a private URL: the whole URL, and each key-like part, as written and decoded. */
export function secretPatternsOf(privateUrl: string): string[] {
  const url = new URL(privateUrl);
  const { segmentsAndFields, otherParts } = urlParts(privateUrl, url);
  const parts = [...segmentsAndFields.filter(isKeyLikeSegmentOrValue), ...otherParts.filter(isKeyLike)].flatMap(
    (part) => [part, decoded(part)].filter((form): form is string => form !== undefined)
  );
  return [...new Set([privateUrl, url.href, ...parts])].map((secret) => [...secret].map(characterPattern).join(''));
}

/**
 * Checks a private URL from the environment: HTTP(S), with no user name or password. `name` is the
 * variable's name, which the error names in place of the URL.
 */
export function checkedPrivateUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${name} must be an HTTP(S) URL.`);
  // fetch refuses a URL with credentials, and its error quotes the URL.
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${name} must not carry a user name or password. Put the key in its path or query.`);
  }
  return url;
}

/** The upstream endpoints to try: the private BROWSER_FORK_RPC_URL alone, or the public endpoints in order. */
export function upstreamEndpoints(env: NodeJS.ProcessEnv = process.env): Endpoint[] {
  const privateUrl = env.BROWSER_FORK_RPC_URL;
  if (privateUrl !== undefined && privateUrl !== '') {
    checkedPrivateUrl(privateUrl, 'BROWSER_FORK_RPC_URL');
    return [
      {
        label: 'BROWSER_FORK_RPC_URL (private, not printed)',
        url: privateUrl,
        isPrivate: true,
        secretPatterns: secretPatternsOf(privateUrl),
      },
    ];
  }
  return PUBLIC_ENDPOINTS.map((url) => ({ label: `${url} (public)`, url, isPrivate: false, secretPatterns: [] }));
}

export type Redactor = ReturnType<typeof createRedactor>;

/**
 * The redaction of the secrets that `secretPatterns` match. It replaces each stretch of text that one or
 * more patterns match with `<redacted>`, in either letter case. `literals` are matched as written.
 */
export function createRedactor(secretPatterns: readonly string[], literals: readonly string[] = []) {
  const sources = [...new Set([...secretPatterns, ...literals.filter((each) => each !== '').map(escapeRegExp)])];
  const expressions = sources.map((source) => new RegExp(source, 'gi'));
  const redact = (value: unknown): string => {
    const text = String(value);
    const matches: [number, number][] = [];
    for (const expression of expressions) {
      expression.lastIndex = 0;
      for (let match = expression.exec(text); match !== null; match = expression.exec(text)) {
        if (match[0] !== '') matches.push([match.index, match.index + match[0].length]);
        expression.lastIndex = match.index + 1;
      }
    }
    matches.sort(([startA], [startB]) => startA - startB);
    const stretches: [number, number][] = [];
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

  /** Writes a stream to `write` a whole line at a time, each line redacted. */
  function lineRedactor(write: (text: string) => void) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    return {
      write: (chunk: Buffer | string) => {
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

  /** `text`, redacted, as one line of printable ASCII of at most 200 characters. */
  const printable = (text: unknown) =>
    redact(String(text))
      .replace(/[^\x20-\x7e]/g, ' ')
      .slice(0, 200);

  return { redact, lineRedactor, printable };
}

type RpcError = { code?: unknown; message?: unknown; data?: unknown };

/** A JSON-RPC error code of at most five digits, or undefined. A longer one can be a numeric key. */
const errorCode = (error: RpcError | undefined) =>
  Number.isInteger(error?.code) && Math.abs(error?.code as number) <= 99_999 ? (error?.code as number) : undefined;

function describedError(error: RpcError | undefined): string {
  if (!Number.isInteger(error?.code)) return 'a JSON-RPC error';
  const code = errorCode(error);
  return code === undefined
    ? 'a JSON-RPC error with a code of more than five digits, withheld'
    : `a JSON-RPC error with code ${code}`;
}

function noAnswer(error: unknown, timeoutMs: number): string {
  const { name, cause } = (error ?? {}) as { name?: string; cause?: { code?: unknown } };
  if (name === 'TimeoutError') return `no answer within ${timeoutMs / 1000} s`;
  const code = cause?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? `no connection (${code})` : 'no connection';
}

/**
 * Calls `method` on the JSON-RPC endpoint at `url` and returns the result. For a private endpoint, an error
 * names a JSON-RPC error by its code alone, because an upstream's text can echo the key. Redirects are
 * refused, so a local node cannot hand a call on to another host.
 */
export async function rpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = [],
  { timeoutMs = 20_000, isPrivate = false }: { timeoutMs?: number; isPrivate?: boolean } = {}
): Promise<T> {
  let response: Response | undefined;
  let text: string;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    text = await response.text();
  } catch (error) {
    if (response !== undefined && !response.ok) throw error;
    throw new Error(`${method}: ${noAnswer(error, timeoutMs)}`);
  }
  let body: { result?: T; error?: RpcError | null };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method}: HTTP ${response.status}, an answer that is not JSON`);
  }
  if (body?.error !== undefined && body?.error !== null) {
    const error = new Error(
      isPrivate
        ? `${method}: HTTP ${response.status}, ${describedError(body.error)}`
        : `${method}: ${String(body.error.message ?? JSON.stringify(body.error))}`
    ) as Error & { code?: number; data?: unknown; nodeMessage?: string };
    error.code = errorCode(body.error);
    // A public or local node's error data, such as revert data, stays for the caller to decode.
    if (!isPrivate) {
      error.data = body.error.data;
      error.nodeMessage = typeof body.error.message === 'string' ? body.error.message : undefined;
    }
    throw error;
  }
  return body?.result as T;
}

/** The phrases anvil's retry rule reads in an error's message (alloy 0.12.6, in anvil 1.2.3). */
const RETRY_PHRASES = [
  'rate limit',
  'rate exceeded',
  'too many requests',
  'credits limited',
  'credits',
  'request limit',
];
const RETRY_MESSAGES = ['header not found', 'daily request count exceeded, request rate limited'];

/** The message anvil gets in place of a private upstream's error message: only the retry phrases it holds. */
export function withheldMessage(message: unknown): string {
  const text = typeof message === 'string' ? message : '';
  if (RETRY_MESSAGES.includes(text)) return text;
  const phrases = RETRY_PHRASES.filter((phrase) => text.includes(phrase));
  return phrases.length === 0
    ? "the private upstream's message is withheld"
    : `${phrases.join('; ')} (the rest of the private upstream's message is withheld)`;
}

/** `method` if it is a JSON-RPC method name, so that a request cannot write other text into a record. */
export const methodName = (method: unknown) =>
  typeof method === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(method) ? method : '<invalid>';

export const countIn = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

type Entry = { id?: unknown; result?: unknown; error?: RpcError | null };

const hasError = (entry: Entry) => entry?.error !== undefined && entry?.error !== null;
const isResponse = (entry: unknown): entry is Entry =>
  entry !== null && typeof entry === 'object' && !Array.isArray(entry) && ('result' in entry || 'error' in entry);
const isBareError = (parsed: unknown): parsed is { code: number; message: string } =>
  parsed !== null &&
  typeof parsed === 'object' &&
  !Array.isArray(parsed) &&
  Number.isInteger((parsed as RpcError).code) &&
  typeof (parsed as RpcError).message === 'string' &&
  !isResponse(parsed);

function backoffSeconds(error: RpcError | undefined): number | undefined {
  const seconds = (error?.data as { rate?: { backoff_seconds?: unknown } } | undefined)?.rate?.backoff_seconds;
  return typeof seconds === 'number' && seconds >= 0 && seconds <= 99_999 ? Math.ceil(seconds) : undefined;
}

function withheldError(error: RpcError | undefined) {
  const seconds = backoffSeconds(error);
  return {
    code: errorCode(error) ?? -32603,
    message: withheldMessage(error !== null && typeof error === 'object' ? error.message : undefined),
    ...(seconds === undefined ? {} : { data: { rate: { backoff_seconds: seconds } } }),
  };
}

const isQuantity = (value: unknown) => typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value);
const isData = (value: unknown) => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
const MAX_FIELD_DEPTH = 8;

function isHexField(value: unknown, depth: number): boolean {
  if (depth > MAX_FIELD_DEPTH) return false;
  if (typeof value === 'string') return /^0x[0-9a-fA-F]*$/.test(value);
  if (typeof value === 'boolean' || value === null) return true;
  if (Array.isArray(value)) return value.every((item) => isHexField(item, depth + 1));
  return isHexRecord(value, depth);
}

/** Whether `value` is a record of hex fields, as anvil reads a block, a transaction, a receipt or a log. */
function isHexRecord(value: unknown, depth = 0): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([name, field]) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) && isHexField(field, depth + 1)
    )
  );
}

const isRecordOrNull = (value: unknown) => value === null || isHexRecord(value);

/** Whether `value` is an `eth_getLogs` result: an array of at most `MAX_RELAYED_LOGS` records of hex fields. */
export const isLogArray = (value: unknown) =>
  Array.isArray(value) && value.length <= MAX_RELAYED_LOGS && value.every((log) => isHexRecord(log));

/** The shape of the result of each method in `UPSTREAM_METHODS`, as anvil reads it. */
const RESULT_SHAPES: Record<string, (value: unknown) => boolean> = {
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
  eth_getLogs: isLogArray,
};

export const hasResultShape = (method: string | undefined, result: unknown) =>
  method !== undefined && Object.hasOwn(RESULT_SHAPES, method) && RESULT_SHAPES[method](result);

const MALFORMED_RESULT = { code: -32603, message: "the private upstream's malformed result is withheld" };

type Relay = { status: number; contentType: string; body: Buffer; failure?: string; errors: string[] };

/**
 * What the proxy relays to anvil for the upstream's answer. A public endpoint's answer goes on unchanged.
 * A private endpoint's answer is rebuilt so that none of its text reaches anvil: an HTTP error keeps only
 * its status, an error keeps its code and anvil's retry phrases, and a result goes on only when it has its
 * method's shape. Anything else becomes HTTP 502 with no body.
 */
export function relayed(
  status: number,
  contentType: string,
  answer: Buffer,
  {
    isPrivate,
    printable,
    methodOf,
  }: { isPrivate: boolean; printable: (text: unknown) => string; methodOf: (entry: Entry) => string | undefined }
): Relay {
  const withheld = (error: string): Relay => ({
    status: 502,
    contentType: 'text/plain',
    body: Buffer.alloc(0),
    errors: [error],
  });
  if (status >= 400) {
    return isPrivate
      ? { status, contentType: 'text/plain', body: Buffer.alloc(0), failure: `HTTP ${status}`, errors: [] }
      : { status, contentType, body: answer, failure: `HTTP ${status}`, errors: [] };
  }
  let parsed: unknown;
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
  const entries = (Array.isArray(parsed) ? parsed : [parsed]) as Entry[];
  if (!isPrivate) {
    const errors = entries
      .filter(hasError)
      .map((entry) => printable(entry.error?.message ?? JSON.stringify(entry.error)));
    return { status, contentType, body: answer, errors };
  }
  if (entries.length === 0 || !entries.every(isResponse)) return withheld('an answer that is not a JSON-RPC response');
  const errors: string[] = [];
  const relayedEntries = entries.map((entry) => {
    const id = Number.isSafeInteger(entry.id) ? entry.id : null;
    if (hasError(entry)) {
      errors.push(describedError(entry.error ?? undefined));
      return { jsonrpc: '2.0', id, error: withheldError(entry.error ?? undefined) };
    }
    const method = methodOf(entry);
    if (hasResultShape(method, entry.result)) return { jsonrpc: '2.0', id, result: entry.result };
    errors.push(`a malformed ${method ?? 'JSON-RPC'} result`);
    return { jsonrpc: '2.0', id, error: MALFORMED_RESULT };
  });
  const body = Buffer.from(JSON.stringify(Array.isArray(parsed) ? relayedEntries : relayedEntries[0]));
  return { status, contentType: 'application/json', body, errors };
}

export type UpstreamStats = {
  requests: number;
  failures: number;
  errorAnswers: number;
  firstError: string | undefined;
  pending: number;
  lastFailureAt: number | undefined;
  methods: Map<string, number>;
  refused: Map<string, number>;
};

/**
 * Forwards anvil's JSON-RPC reads to the upstream `endpoint`, so that only this process holds the upstream
 * URL. It listens on 127.0.0.1 and refuses: an Origin header, a Host other than its own address, a method
 * other than POST, a content type other than JSON, a body over 10 MB, an empty batch, and any call to a
 * method outside `UPSTREAM_METHODS`. Each forwarded call is rebuilt from its four JSON-RPC members.
 */
export function startUpstreamProxy(
  endpoint: Endpoint,
  { printable, timeoutMs = 40_000 }: { printable: (text: unknown) => string; timeoutMs?: number }
): Promise<{ server: http.Server; stats: UpstreamStats; url: string }> {
  const stats: UpstreamStats = {
    requests: 0,
    failures: 0,
    errorAnswers: 0,
    firstError: undefined,
    pending: 0,
    lastFailureAt: undefined,
    methods: new Map(),
    refused: new Map(),
  };
  const server = http.createServer((request, response) => {
    const refuse = (status: number, reason?: string) => {
      if (reason !== undefined) countIn(stats.refused, reason);
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end();
    };
    if (request.headers.origin !== undefined) return refuse(403, '<an Origin header>');
    const { port } = server.address() as { port: number };
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(request.headers.host).toLowerCase())) {
      return refuse(403, "<a Host header other than the proxy's address>");
    }
    if (request.method !== 'POST') return refuse(405, '<a method other than POST>');
    if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) {
      return refuse(415, '<a content type other than JSON>');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_PROXY_BODY_BYTES) chunks.push(chunk);
      else if (!request.destroyed) {
        countIn(stats.refused, '<a body over 10 MB>');
        request.destroy();
      }
    });
    request.on('end', async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return refuse(400, '<a body that is not JSON>');
      }
      const calls = (Array.isArray(parsed) ? parsed : [parsed]) as { [key: string]: unknown }[];
      const methods = calls.map((call) => methodName(call?.method));
      if (methods.length === 0) return refuse(403, '<an empty batch>');
      const outside = methods.filter((method) => !UPSTREAM_METHODS.has(method));
      if (outside.length > 0) {
        for (const method of outside) countIn(stats.refused, method);
        return refuse(403);
      }
      if (calls.some((call) => call?.method === 'eth_getLogs' && !isBoundedLogQuery(call?.params))) {
        return refuse(403, '<an unbounded eth_getLogs>');
      }
      // Rebuilt from the four members the proxy checked, so a duplicate or differently cased `method`
      // key cannot reach the upstream.
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
          redirect: 'error',
        });
        const answer = await boundedBody(upstream, MAX_UPSTREAM_ANSWER_BYTES);
        const contentType = upstream.headers.get('content-type') ?? 'application/json';
        const methodOf = Array.isArray(parsed)
          ? (entry: Entry) => checked.find(({ id }) => id === entry.id)?.method as string | undefined
          : () => checked[0].method as string;
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
  // anvil keeps idle connections open for up to 90 s, so the proxy never closes one.
  server.keepAliveTimeout = 0;
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, stats, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` })
    );
  });
}

/** Whether anvil failed to start only because the upstream failed to serve what it reads at start-up. */
export const failedToStartOnUpstream = ({
  stats,
  output,
  isTimedOut = false,
  now = Date.now(),
}: {
  stats: Pick<UpstreamStats, 'failures' | 'errorAnswers' | 'pending' | 'lastFailureAt'>;
  output: string;
  isTimedOut?: boolean;
  now?: number;
}) =>
  stats.failures + stats.errorAnswers > 0 &&
  (FORK_STARTUP_FETCH_ERROR.test(output) ||
    (isTimedOut && (stats.pending > 0 || now - (stats.lastFailureAt ?? -Infinity) <= 45_000)));

const LAST_DATE_SECONDS = 8.64e12;

/** Whether `answer` is a hex block number below 2^32. */
export const isBlockNumber = (answer: unknown) => typeof answer === 'string' && /^0x[0-9a-fA-F]{1,8}$/.test(answer);

/** Whether `header` has a 32-byte hash and a hex timestamp that a date can hold. */
export const isBlockHeader = (header: unknown): header is { hash: string; timestamp: string } => {
  const { hash, timestamp } = (header ?? {}) as { hash?: unknown; timestamp?: unknown };
  return (
    typeof hash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(hash) &&
    typeof timestamp === 'string' &&
    /^0x[0-9a-fA-F]{1,16}$/.test(timestamp) &&
    Number(timestamp) <= LAST_DATE_SECONDS
  );
};

export const hex = (value: number | bigint) => `0x${value.toString(16)}`;

export type ForkTarget = { number: number; hash: string; timestamp: number; mode: 'pinned' | 'recent' };

/**
 * The block and hash to fork from on `endpoint`, or undefined when it cannot serve them. The pinned block
 * must have the recorded hash, and its state must be readable.
 */
export async function forkTarget(endpoint: Endpoint, block: 'pinned' | 'latest'): Promise<ForkTarget | undefined> {
  const call = <T>(method: string, params: unknown[] = []) =>
    rpc<T>(endpoint.url, method, params, { isPrivate: endpoint.isPrivate });
  if ((await call('eth_chainId')) !== '0x1') throw new Error('the endpoint is not Ethereum mainnet');
  if (block === 'pinned') {
    const header = await call<unknown>('eth_getBlockByNumber', [hex(PINNED_BLOCK), false]);
    if (header === null) return undefined;
    if (!isBlockHeader(header)) throw new Error(`block ${PINNED_BLOCK} has no valid hash or timestamp`);
    if (header.hash !== PINNED_HASH) throw new Error(`block ${PINNED_BLOCK} has another hash`);
    await call('eth_getBalance', ['0x0000000000000000000000000000000000000000', hex(PINNED_BLOCK)]);
    return { number: PINNED_BLOCK, hash: header.hash, timestamp: Number(header.timestamp), mode: 'pinned' };
  }
  const answer = await call<unknown>('eth_blockNumber');
  if (!isBlockNumber(answer)) throw new Error('eth_blockNumber: an answer that is not a block number');
  const number = Number(answer) - RECENT_BLOCK_LAG;
  const header = await call<unknown>('eth_getBlockByNumber', [hex(number), false]);
  if (!isBlockHeader(header)) throw new Error(`block ${number} has no valid hash or timestamp`);
  return { number, hash: header.hash, timestamp: Number(header.timestamp), mode: 'recent' };
}

export function toolVersion(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\n')[0].trim() : undefined;
}

export function findAnvil(env: NodeJS.ProcessEnv = process.env): { command: string; version: string } {
  const candidates = [env.ANVIL, 'anvil', path.join(os.homedir(), '.foundry/bin/anvil')].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  for (const candidate of candidates) {
    const version = toolVersion(candidate, ['--version']);
    if (version !== undefined) return { command: candidate, version };
  }
  throw new Error('anvil was not found. Install Foundry 1.2.3 (https://getfoundry.sh) or set ANVIL to its path.');
}

export const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Stops `child` with SIGTERM and waits until it has exited and its output streams have closed, so no line
 * of its output arrives after this resolves. If it outlives `timeoutMs`, kills it with SIGKILL.
 */
export function stopChild(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (hasExited(child) && child.stdout?.readableEnded !== false && child.stderr?.readableEnded !== false) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    if (!hasExited(child)) child.kill('SIGTERM');
  });
}

/** anvil's failure to start the fork, with its redacted output until it stopped. */
export class ForkStartError extends Error {
  constructor(message: string, readonly output: string, readonly isTimedOut: boolean) {
    super(message);
  }
}

export type Fork = { child: ChildProcess; localUrl: string; port: number; pid: number };

/**
 * Starts anvil on 127.0.0.1, forked from `target` through the proxy at `upstreamUrl`, with no unlocked
 * account. anvil binds a free port itself, and the port is read from its output. `onChild` gets the child as
 * soon as it is spawned, so that cleanup can stop it whatever happens next.
 */
export async function startFork({
  anvil,
  upstreamUrl,
  target,
  log,
  redactor,
  onChild,
  readyTimeoutMs = 120_000,
}: {
  anvil: string;
  upstreamUrl: string;
  target: ForkTarget;
  log: (text: string) => void;
  redactor: Redactor;
  onChild: (child: ChildProcess) => void;
  readyTimeoutMs?: number;
}): Promise<Fork> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-anvil-'));
  const args = [
    '--fork-url',
    upstreamUrl,
    '--fork-block-number',
    String(target.number),
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--chain-id',
    '1',
    '--hardfork',
    HARDFORK,
    '--accounts',
    '0',
    '--no-cors',
    '--retries',
    '5',
    '--timeout',
    '45000',
    '--fork-retry-backoff',
    '1000',
    '--compute-units-per-second',
    '330',
    '--no-storage-caching',
  ];
  // An empty working directory, so no foundry.toml changes anvil's settings.
  const child = spawn(anvil, args, {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  onChild(child);
  const closed = new Promise((resolve) => child.once('close', resolve));
  closed.finally(() => fs.rmSync(directory, { recursive: true, force: true }));
  let boundPort: number | undefined;
  let startupOutput = '';
  const write = (text: string) => {
    log(text);
    if (boundPort === undefined && startupOutput.length < 1_000_000) startupOutput += text;
  };
  const stdout = redactor.lineRedactor((text) => {
    write(text);
    const listening = /Listening on 127\.0\.0\.1:(\d+)/.exec(text);
    if (listening !== null) boundPort = Number(listening[1]);
  });
  const stderr = redactor.lineRedactor(write);
  child.stdout?.on('data', stdout.write);
  child.stdout?.on('end', stdout.end);
  child.stderr?.on('data', stderr.write);
  child.stderr?.on('end', stderr.end);
  const failed = async (message: string, isTimedOut: boolean) => {
    await stopChild(child);
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    return new ForkStartError(message, startupOutput, isTimedOut);
  };
  const deadline = Date.now() + readyTimeoutMs;
  while (boundPort === undefined) {
    if (hasExited(child)) throw await failed('anvil exited before it was ready. See anvil.log.', false);
    if (Date.now() > deadline) throw await failed('anvil was not ready in time. See anvil.log.', true);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { child, localUrl: `http://127.0.0.1:${boundPort}`, port: boundPort, pid: child.pid as number };
}

type ForkMetadata = { forkedNetwork: { forkBlockNumber: number; forkBlockHash: string } | null };

/**
 * Refuses unless the local node at `fork.localUrl` is the anvil fork of `target`: bound to 127.0.0.1, still
 * running, chain 1, an anvil client, the expected fork block and hash, and that block's hash on the node.
 */
export async function verifyFork(
  fork: Pick<Fork, 'localUrl'> & { child?: ChildProcess },
  target: Pick<ForkTarget, 'number' | 'hash'>
): Promise<{ clientVersion: string }> {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(fork.localUrl)) throw new Error('The fork must listen on 127.0.0.1.');
  const [chainId, clientVersion, metadata, block] = await Promise.all([
    rpc<string>(fork.localUrl, 'eth_chainId'),
    rpc<string>(fork.localUrl, 'web3_clientVersion'),
    rpc<ForkMetadata>(fork.localUrl, 'anvil_metadata'),
    rpc<{ hash?: string } | null>(fork.localUrl, 'eth_getBlockByNumber', [hex(target.number), false]),
  ]);
  const forked = metadata?.forkedNetwork ?? null;
  const problems = [
    fork.child !== undefined && hasExited(fork.child) && 'the anvil the harness started has exited',
    chainId !== '0x1' && `chain ID ${chainId}`,
    !String(clientVersion).startsWith('anvil/') && 'a client that is not anvil',
    (forked === null || Number(forked.forkBlockNumber) !== target.number) && 'another fork block',
    (forked === null || forked.forkBlockHash !== target.hash) && 'another fork block hash',
    block?.hash !== target.hash && 'the fork block hash differs from the pinned one',
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(`The local node is not the expected fork: ${problems.join(', ')}.`);
  return { clientVersion };
}

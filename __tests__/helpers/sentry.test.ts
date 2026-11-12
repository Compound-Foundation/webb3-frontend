import type { Breadcrumb, ErrorEvent } from '@sentry/react';

import {
  buildSentryOptions,
  DEV_TRACES_SAMPLE_RATE,
  initSentry,
  isSentryEnabled,
  PRODUCTION_TRACES_SAMPLE_RATE,
  redactSpan,
  redactWalletIdentity,
  redactWalletIdentityText,
  sentryRootOptions,
  type SentrySpanJSON,
} from '../../src/helpers/sentry';

const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const LOWERCASE_ADDRESS = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const TX_HASH = '0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b';
const CALLDATA = `0xa9059cbb000000000000000000000000${LOWERCASE_ADDRESS.slice(
  2
)}0000000000000000000000000000000000000000000000000de0b6b3a7640000`;
const DSN = 'https://public@o0.ingest.us.sentry.io/0';

describe('redactWalletIdentityText', () => {
  it('replaces addresses in either case', () => {
    expect(redactWalletIdentityText(`from ${ADDRESS} to ${LOWERCASE_ADDRESS}`)).toBe('from 0x[address] to 0x[address]');
  });

  it('replaces transaction hashes', () => {
    expect(redactWalletIdentityText(`tx ${TX_HASH} reverted`)).toBe('tx 0x[hash] reverted');
  });

  it('replaces calldata whole, so the addresses it encodes do not survive', () => {
    const redacted = redactWalletIdentityText(`data: ${CALLDATA}`);
    expect(redacted).toBe('data: 0x[hex]');
    expect(redacted).not.toContain(LOWERCASE_ADDRESS.slice(2));
  });

  it('replaces ENS names, including subdomains', () => {
    expect(redactWalletIdentityText('resolved alice.eth and pay.alice.eth')).toBe('resolved [ens] and [ens]');
  });

  it('replaces ENS names made of non-ASCII letters or emoji', () => {
    expect(redactWalletIdentityText('owner ü.eth and 🦊.eth')).toBe('owner [ens] and [ens]');
  });

  it('replaces addresses and hashes printed without 0x', () => {
    expect(redactWalletIdentityText(`account ${ADDRESS.slice(2)} tx ${TX_HASH.slice(2)}`)).toBe(
      'account [hex] tx [hex]'
    );
  });

  it('keeps short hex values, selectors and ordinary words', () => {
    const text = 'chain 0x1 selector 0xa9059cbb on ethereum-mainnet at https://rpc.example/ethereum-mainnet';
    expect(redactWalletIdentityText(text)).toBe(text);
  });
});

describe('redactWalletIdentity', () => {
  it('redacts every string and key in a nested event and leaves other values alone', () => {
    const event = {
      message: `Failed for ${ADDRESS}`,
      level: 'error',
      timestamp: 1700000000,
      exception: { values: [{ type: 'Error', value: `execution reverted: ${TX_HASH}` }] },
      request: { url: `https://api.example/account/${LOWERCASE_ADDRESS}` },
      extra: { [ADDRESS]: { balance: 5, ens: 'bob.eth' } },
      tags: { ok: true },
    } as unknown as ErrorEvent;

    expect(redactWalletIdentity(event)).toEqual({
      message: 'Failed for 0x[address]',
      level: 'error',
      timestamp: 1700000000,
      exception: { values: [{ type: 'Error', value: 'execution reverted: 0x[hash]' }] },
      request: { url: 'https://api.example/account/0x[address]' },
      extra: { '0x[address]': { balance: 5, ens: '[ens]' } },
      tags: { ok: true },
    });
  });

  it('does not change the payload it was given', () => {
    const breadcrumb: Breadcrumb = { category: 'console', message: ADDRESS };
    redactWalletIdentity(breadcrumb);
    expect(breadcrumb.message).toBe(ADDRESS);
  });

  it('reduces non-plain objects to redacted text', () => {
    expect(redactWalletIdentity({ error: new Error(`bad ${ADDRESS}`) })).toEqual({ error: 'Error: bad 0x[address]' });
  });

  it('replaces raw bytes, which could hold an address', () => {
    const bytes = Uint8Array.from(Buffer.from(ADDRESS.slice(2), 'hex'));
    expect(redactWalletIdentity({ data: bytes, buffer: bytes.buffer })).toEqual({ data: '[bytes]', buffer: '[bytes]' });
  });

  it('redacts an object each time it appears, when it is shared but not cyclic', () => {
    const shared = { owner: ADDRESS };
    expect(redactWalletIdentity({ first: shared, second: shared })).toEqual({
      first: { owner: '0x[address]' },
      second: { owner: '0x[address]' },
    });
  });

  it('keeps at most 1000 items of an array', () => {
    expect((redactWalletIdentity(new Array(1500).fill(ADDRESS)) as string[]).length).toBe(1000);
  });

  it('terminates on a cyclic payload', () => {
    const cyclic: Record<string, unknown> = { message: ADDRESS };
    cyclic.self = cyclic;
    expect(redactWalletIdentity(cyclic)).toEqual({ message: '0x[address]', self: '[redacted]' });
  });
});

describe('buildSentryOptions', () => {
  it('turns Sentry off without a DSN', () => {
    expect(buildSentryOptions({ isDev: false, environment: 'production' })).toBeUndefined();
    expect(buildSentryOptions({ dsn: '', isDev: true, environment: 'development' })).toBeUndefined();
  });

  it('samples every trace on a development build and 10% otherwise', () => {
    expect(buildSentryOptions({ dsn: DSN, isDev: true, environment: 'development' })?.tracesSampleRate).toBe(
      DEV_TRACES_SAMPLE_RATE
    );
    expect(buildSentryOptions({ dsn: DSN, isDev: false, environment: 'production' })?.tracesSampleRate).toBe(
      PRODUCTION_TRACES_SAMPLE_RATE
    );
    expect(PRODUCTION_TRACES_SAMPLE_RATE).toBe(0.1);
  });

  it('collects no user, header, cookie, body or query data and propagates no trace headers', () => {
    const options = buildSentryOptions({ dsn: DSN, isDev: false, environment: 'production', release: 'abc123' });
    expect(options).toMatchObject({
      dsn: DSN,
      environment: 'production',
      release: 'abc123',
      tracePropagationTargets: [],
      enhanceFetchErrorMessages: 'report-only',
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
      },
    });
  });

  it('redacts wallet identity from events, spans and breadcrumbs', () => {
    const options = buildSentryOptions({ dsn: DSN, isDev: false, environment: 'production' });
    const event = { message: ADDRESS } as ErrorEvent;
    expect(options?.beforeSend?.(event, {})).toEqual({ message: '0x[address]' });
    expect(options?.beforeSendSpan).toBe(redactSpan);
    expect(options?.beforeBreadcrumb?.({ message: `connected ${ADDRESS}` })).toEqual({
      message: 'connected 0x[address]',
    });
  });

  it('leaves the release unset when it is empty', () => {
    expect(buildSentryOptions({ dsn: DSN, isDev: false, environment: 'production', release: '' })?.release).toBe(
      undefined
    );
  });
});

describe('initSentry', () => {
  it('stays off under Jest, whose import.meta sets no DSN, and adds no React error hooks', () => {
    initSentry();
    expect(isSentryEnabled()).toBe(false);
    expect(sentryRootOptions()).toBeUndefined();
  });
});

describe('redactSpan', () => {
  const span: SentrySpanJSON = {
    trace_id: 'a'.repeat(32),
    span_id: 'b'.repeat(16),
    name: `GET https://api.example/account/${ADDRESS}/rewards`,
    start_timestamp: 1,
    status: 'ok',
    is_segment: false,
    attributes: { 'url.full': `https://api.example/account/${ADDRESS}/rewards` },
  };

  it('redacts the name and attributes and keeps the trace and span IDs', () => {
    expect(redactSpan(span)).toEqual({
      ...span,
      name: 'GET https://api.example/account/0x[address]/rewards',
      attributes: { 'url.full': 'https://api.example/account/0x[address]/rewards' },
    });
  });

  it('strips the name and attributes of a span it cannot walk, since the SDK sends a span unchanged on a throw', () => {
    const attributes = {};
    Object.defineProperty(attributes, 'url.full', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });
    expect(redactSpan({ ...span, attributes })).toEqual({
      ...span,
      name: '[redacted]',
      attributes: {},
      links: undefined,
    });
  });
});

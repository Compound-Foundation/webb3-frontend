import type { Breadcrumb, ErrorEvent } from '@sentry/react';

import {
  buildSentryOptions,
  DEV_TRACES_SAMPLE_RATE,
  initSentry,
  isSentryEnabled,
  PRODUCTION_TRACES_SAMPLE_RATE,
  redactingTransport,
  redactWalletIdentity,
  redactWalletIdentityText,
  sentryRootOptions,
  type SentryTransportFactory,
} from '../../src/helpers/sentry';

const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
const LOWERCASE_ADDRESS = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const TX_HASH = '0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b';
const CALLDATA = `0xa9059cbb000000000000000000000000${LOWERCASE_ADDRESS.slice(
  2
)}0000000000000000000000000000000000000000000000000de0b6b3a7640000`;
const DSN = 'https://public@o0.ingest.us.sentry.io/0';
const COMMIT_SHA = 'c793fd76f0cce3f8cc29edb6c5f3188c623a8577';
const ADDRESS_BYTES = Array.from(Buffer.from(ADDRESS.slice(2), 'hex'));

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

  it('replaces ENS names whatever their case', () => {
    expect(redactWalletIdentityText('owner Alice.ETH and alice.Eth')).toBe('owner [ens] and [ens]');
  });

  it('replaces ENS names with combining marks, flags, keycaps and joined emoji whole', () => {
    expect(redactWalletIdentityText('e\u0301.eth 🇺🇸.eth 1️⃣.eth #️⃣.eth 👨‍👩‍👧‍👦.eth')).toBe('[ens] [ens] [ens] [ens] [ens]');
  });

  it('replaces ENS names with a dollar sign or an apostrophe, which ENS allows', () => {
    expect(redactWalletIdentityText("owner $.eth, cash$.eth, pay.cash$.eth and o'brien.eth")).toBe(
      'owner [ens], [ens], [ens] and [ens]'
    );
    expect(redactWalletIdentityText("resolved 'alice.eth'")).toBe("resolved [ens]'");
  });

  it('replaces an ENS name followed by punctuation, and keeps a word that only starts with eth', () => {
    expect(redactWalletIdentityText('“alice.eth”, alice.eth. alice.ethereum')).toBe('[ens]”, [ens]. alice.ethereum');
  });

  it('replaces bytes printed as decimal numbers, and keeps a shorter list', () => {
    expect(redactWalletIdentityText(`data ${ADDRESS_BYTES.join(',')} end`)).toBe('data [bytes] end');
    expect(redactWalletIdentityText(`data ${ADDRESS_BYTES.join(', ')} end`)).toBe('data [bytes] end');
    expect(redactWalletIdentityText('rgb 12,34,56 version 1.2.3')).toBe('rgb 12,34,56 version 1.2.3');
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

  it('replaces bytes held as a list of numbers or as the indexed object the SDK makes of a typed array', () => {
    expect(redactWalletIdentity({ list: ADDRESS_BYTES, indexed: { ...ADDRESS_BYTES } })).toEqual({
      list: '[bytes]',
      indexed: '[bytes]',
    });
  });

  it('keeps numbers that cannot hold an address', () => {
    const payload = {
      short: ADDRESS_BYTES.slice(1),
      notBytes: [...ADDRESS_BYTES.slice(1), 256],
      keyed: { ...ADDRESS_BYTES.slice(1), amount: 5 },
    };
    expect(redactWalletIdentity(payload)).toEqual(payload);
  });

  it('keeps a string equal to the release, and redacts the same digits elsewhere', () => {
    const payload = { release: COMMIT_SHA, message: `failed at ${COMMIT_SHA}`, other: ADDRESS.slice(2) };
    expect(redactWalletIdentity(payload, COMMIT_SHA)).toEqual({
      release: COMMIT_SHA,
      message: 'failed at [hex]',
      other: '[hex]',
    });
    expect(redactWalletIdentity(payload)).toEqual({ release: '[hex]', message: 'failed at [hex]', other: '[hex]' });
  });

  it('redacts what toJSON returns and drops functions, as serializing would', () => {
    const session = { owner: ADDRESS, toJSON: () => ({ owner: ADDRESS, started: new Date(0) }) };
    expect(redactWalletIdentity({ session, callback: () => ADDRESS })).toEqual({
      session: { owner: '0x[address]', started: '1970-01-01T00:00:00.000Z' },
      callback: undefined,
    });
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

  it('sets no hooks, because the transport redacts everything', () => {
    const options = buildSentryOptions({ dsn: DSN, isDev: false, environment: 'production' });
    expect(options?.transport).toEqual(expect.any(Function));
    expect(options?.beforeSend).toBeUndefined();
    expect(options?.beforeSendSpan).toBeUndefined();
    expect(options?.beforeBreadcrumb).toBeUndefined();
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

describe('redactingTransport', () => {
  type Envelope = Parameters<ReturnType<SentryTransportFactory>['send']>[0];
  const transportOptions = {
    url: 'https://o0.ingest.us.sentry.io/api/0/envelope/',
    recordDroppedEvent: () => undefined,
  };

  function recordingTransport(sent: unknown[]): SentryTransportFactory {
    return () => ({
      send: async (envelope) => {
        sent.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    });
  }

  it('redacts the headers and the items of an envelope and keeps the release', async () => {
    const sent: unknown[] = [];
    const transport = redactingTransport(recordingTransport(sent), COMMIT_SHA)(transportOptions);
    const envelope = [
      { trace: { transaction: `GET /account/${ADDRESS}`, release: COMMIT_SHA } },
      [[{ type: 'event' }, { message: `Failed for ${ADDRESS}`, release: COMMIT_SHA }]],
    ] as unknown as Envelope;

    await expect(transport.send(envelope)).resolves.toEqual({ statusCode: 200 });
    expect(sent).toEqual([
      [
        { trace: { transaction: 'GET /account/0x[address]', release: COMMIT_SHA } },
        [[{ type: 'event' }, { message: 'Failed for 0x[address]', release: COMMIT_SHA }]],
      ],
    ]);
  });

  it('sends nothing when an envelope cannot be redacted', async () => {
    const sent: unknown[] = [];
    const transport = redactingTransport(recordingTransport(sent))(transportOptions);
    const unreadable = {};
    Object.defineProperty(unreadable, 'message', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });

    await expect(transport.send([{}, [[{ type: 'event' }, unreadable]]] as unknown as Envelope)).rejects.toThrow(
      'unreadable'
    );
    expect(sent).toEqual([]);
  });
});

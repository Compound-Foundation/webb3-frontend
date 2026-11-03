import {
  classifyWalletError,
  describeWalletError,
  describeWalletRefusal,
  probeWalletSession,
  WalletErrorKind,
} from '@helpers/walletErrors';

const BROKEN_EXTENSION = new TypeError("Cannot read properties of undefined (reading 'sendMessage')");
/**
 * The Anchorage Digital extension's answer (version 1.1.16) to a transaction request that waited for
 * approval on a phone for about 4 minutes 47 seconds. The request stayed open in the wallet.
 */
const STILL_PENDING = {
  code: -32005,
  message:
    'This request is still pending and can still complete after this message. Check its status in the Anchorage extension before you try again.',
};
const STOPPED_WAITING_MESSAGE =
  'Stopped waiting because the dApp tab was closed or the wallet was disconnected. The request can still complete, so check its status in the Anchorage extension before you try again.';
/**
 * The Anchorage Digital extension's answer (version 1.1.16) to a transaction request it stopped
 * waiting on because the tab's wallet was disconnected, as when the page disconnects the wallet. The
 * request stays open in the wallet. The page receives an `Error` with the extension's code and data.
 */
const STOPPED_WAITING = Object.assign(new Error(STOPPED_WAITING_MESSAGE), {
  name: 'API Error',
  code: 4900,
  data: { userVisibleMessage: STOPPED_WAITING_MESSAGE, operationID: 'operation-1' },
});
/**
 * The Anchorage Digital extension's answer to a transaction request from a tab whose session in the
 * extension had no wallet, after the user logged into the extension again. Nothing reached the wallet.
 */
const UNAUTHORIZED = { code: 4100, message: 'Unauthorized' };

describe('classifyWalletError', () => {
  it.each<[string, unknown]>([
    ['EIP-1193 code 4001', { code: 4001, message: 'User rejected the request.' }],
    ["ethers' ACTION_REJECTED", Object.assign(new Error('user rejected transaction'), { code: 'ACTION_REJECTED' })],
    [
      "viem's UserRejectedRequestError",
      Object.assign(new Error('User rejected.'), { name: 'UserRejectedRequestError' }),
    ],
    ['4001 inside an ethers error', { code: 'UNKNOWN_ERROR', error: { code: 4001, message: 'denied' } }],
    ['4001 as the cause of a viem error', Object.assign(new Error('Request failed'), { cause: { code: 4001 } })],
    ['4001 in the data of a JSON-RPC error', { code: -32603, message: 'Internal error', data: { code: 4001 } }],
  ])('treats %s as a rejection', (_name, error) => {
    expect(classifyWalletError(error)).toBe('rejected');
  });

  it.each<[string, unknown]>([
    ['an Anchorage refusal (a bare -32603 Internal error)', { code: -32603, message: 'Internal error' }],
    ['an internal error inside an ethers error', { code: 'SERVER_ERROR', error: { code: -32603 } }],
    ['WalletConnect code 5000 (not EIP-1193 4001)', { code: 5000, message: 'User rejected.' }],
    ['a message that only mentions rejection', new Error('The request was rejected by the backend')],
    ['a timeout', new Error('timeout')],
    ['a JavaScript error that is not a broken extension, like a failed fetch', new TypeError('Failed to fetch')],
    [
      "MetaMask's -32002 for a request already pending, another code and wording",
      { code: -32002, message: "Request of type 'eth_requestAccounts' already pending for origin" },
    ],
    ['code 4101, next to EIP-1193 4100', { code: 4101, message: 'Unauthorized' }],
    ['code 4100 written in hexadecimal', { code: '0x1004', message: 'Unauthorized' }],
    ['a message that only says unauthorized, with no code', new Error('Unauthorized')],
    ['revert data in a JSON-RPC error', { code: 3, message: 'execution reverted', data: '0x08c379a0' }],
    ['a string', 'failed'],
    ['nothing', undefined],
  ])('treats %s as an unknown outcome, not a rejection', (_name, error) => {
    expect(classifyWalletError(error)).toBe('provider-failure');
  });

  it.each<[string, unknown]>([
    ["the Anchorage extension's -32005 for a request that still waits on mobile", STILL_PENDING],
    ['code -32005 alone', { code: -32005 }],
    ['code -32005 as a string', { code: '-32005', message: 'Request pending' }],
    ['-32005 inside an ethers error', { code: 'UNKNOWN_ERROR', error: STILL_PENDING }],
    ['-32005 as the cause of a viem error', Object.assign(new Error('Request failed'), { cause: { code: -32005 } })],
    ['a message saying the request is still pending, with another code', { code: -32603, message: 'Still pending' }],
    ['a message saying the request is still pending, with no code', new Error('This request is still pending.')],
    ['-32005 in the data of a JSON-RPC error', { code: -32603, message: 'Internal error', data: STILL_PENDING }],
    [
      "the Anchorage extension's -32005 with its data",
      { ...STILL_PENDING, data: { userVisibleMessage: STILL_PENDING.message, operationID: 'operation-1' } },
    ],
    [
      'a user-visible message in the data saying the request is still pending, with another code',
      { code: -32603, message: 'Internal error', data: { userVisibleMessage: STILL_PENDING.message } },
    ],
    ["the Anchorage extension's 4900 for a request it stopped waiting on", STOPPED_WAITING],
    ['4900 with a message saying the request can still complete', { code: 4900, message: STOPPED_WAITING_MESSAGE }],
    ['4900 as a string, with that message', { code: '4900', message: STOPPED_WAITING_MESSAGE }],
    [
      '4900 whose cause says the request can still complete',
      Object.assign(new Error('The Provider is disconnected from all chains.'), {
        code: 4900,
        cause: new Error(STOPPED_WAITING_MESSAGE),
      }),
    ],
    [
      '4900 as a string, whose cause says so',
      { code: '4900', message: 'Disconnected', cause: { message: STOPPED_WAITING_MESSAGE } },
    ],
    [
      '4900 whose user-visible message in the data says so',
      { code: 4900, message: 'Disconnected', data: { userVisibleMessage: STOPPED_WAITING_MESSAGE } },
    ],
    [
      '4900 as a string, whose user-visible message in the data says so',
      { code: '4900', message: 'Disconnected', data: { userVisibleMessage: STOPPED_WAITING_MESSAGE } },
    ],
    [
      "4900 with the ID of the wallet's operation in the data",
      { code: 4900, message: 'Disconnected', data: { operationID: 'operation-1' } },
    ],
    [
      "4900 as a string, with the ID of the wallet's operation in the data",
      { code: '4900', message: 'Disconnected', data: { operationID: 'operation-1' } },
    ],
    ["the extension's 4900 inside an ethers error", { code: 'UNKNOWN_ERROR', error: STOPPED_WAITING }],
    [
      "the extension's 4900 in the data of a JSON-RPC error",
      { code: -32603, message: 'Internal error', data: STOPPED_WAITING },
    ],
    ['a message saying the request can still complete, with no code', new Error('The request can still complete.')],
  ])('treats %s as a request still pending in the wallet', (_name, error) => {
    expect(classifyWalletError(error)).toBe('pending-in-wallet');
  });

  it.each<[string, unknown, WalletErrorKind]>([
    [
      'a rejection whose message says the request is still pending',
      { code: 4001, message: 'Still pending' },
      'rejected',
    ],
    ['a rejection inside an error with code -32005', { code: -32005, error: { code: 4001 } }, 'rejected'],
    [
      'a broken extension whose error has code -32005',
      Object.assign(new TypeError(BROKEN_EXTENSION.message), { code: -32005 }),
      'session-broken',
    ],
    [
      'a rejection whose message says the request can still complete',
      { code: 4001, message: 'The request can still complete.' },
      'rejected',
    ],
  ])('keeps %s as before', (_name, error, kind) => {
    expect(classifyWalletError(error)).toBe(kind);
  });

  it.each<[string, unknown]>([
    ["the Anchorage extension's 4100 after the user logged into it again", UNAUTHORIZED],
    ['code 4100 as a string', { code: '4100', message: 'Unauthorized' }],
    ['EIP-1193 4200, a method the provider does not support', { code: 4200, message: 'Unsupported Method' }],
    ['EIP-1193 4900, a provider disconnected from every chain', { code: 4900, message: 'Disconnected' }],
    ['EIP-1193 4901, a provider disconnected from the chain', { code: 4901, message: 'Chain Disconnected' }],
    ['code 4200 as a string', { code: '4200' }],
    ['code 4900 as a string', { code: '4900' }],
    ['code 4901 as a string', { code: '4901' }],
    ['4100 inside an ethers error', { code: 'UNKNOWN_ERROR', error: UNAUTHORIZED }],
    ['4100 as the cause of a viem error', Object.assign(new Error('Request failed'), { cause: { code: 4100 } })],
    ['4100 in the data of a JSON-RPC error', { code: -32603, message: 'Internal error', data: UNAUTHORIZED }],
    [
      '4900 whose user-visible message in the data does not say the request can still complete',
      { code: 4900, message: 'Disconnected', data: { userVisibleMessage: 'The wallet is disconnected.' } },
    ],
    ['4900 with revert data', { code: 4900, message: 'Disconnected', data: '0x' }],
  ])('treats %s as a refusal before the wallet handled the request', (_name, error) => {
    expect(classifyWalletError(error)).toBe('refused');
  });

  it.each<[string, unknown, WalletErrorKind]>([
    ['a rejection inside an error with code 4100', { ...UNAUTHORIZED, error: { code: 4001 } }, 'rejected'],
    [
      'a broken extension whose error has code 4900',
      Object.assign(new TypeError(BROKEN_EXTENSION.message), { code: 4900 }),
      'session-broken',
    ],
    [
      'a request still pending inside an error with code 4100',
      { ...UNAUTHORIZED, error: STILL_PENDING },
      'pending-in-wallet',
    ],
    [
      'a refusal whose data says the request is still pending',
      { ...UNAUTHORIZED, data: STILL_PENDING },
      'pending-in-wallet',
    ],
  ])('lets %s outrank the refusal, which would drop the request', (_name, error, kind) => {
    expect(classifyWalletError(error)).toBe(kind);
  });

  it.each<[string, unknown]>([
    ['the TypeError an updated extension throws', BROKEN_EXTENSION],
    ['an invalidated extension context', new Error('Extension context invalidated.')],
    ['a broken provider inside an ethers error', { code: 'UNKNOWN_ERROR', error: BROKEN_EXTENSION }],
    [
      'a broken provider in the data of a JSON-RPC error',
      { code: -32603, message: 'Internal error', data: { message: BROKEN_EXTENSION.message } },
    ],
  ])('treats %s as a broken session', (_name, error) => {
    expect(classifyWalletError(error)).toBe('session-broken');
  });

  it('stops at an error that wraps itself', () => {
    const error: { code: number; cause?: unknown } = { code: -32603 };
    error.cause = error;

    expect(classifyWalletError(error)).toBe('provider-failure');
  });
});

describe('describeWalletError', () => {
  it('gives the message and code without interpreting them', () => {
    expect(describeWalletError({ code: -32603, message: 'Internal error' })).toBe('Internal error (-32603)');
    expect(describeWalletError(BROKEN_EXTENSION)).toBe("Cannot read properties of undefined (reading 'sendMessage')");
    expect(describeWalletError(STILL_PENDING)).toBe(`${STILL_PENDING.message} (-32005)`);
    expect(describeWalletError(STOPPED_WAITING)).toBe(`${STOPPED_WAITING_MESSAGE} (4900)`);
    expect(describeWalletError(UNAUTHORIZED)).toBe('Unauthorized (4100)');
    expect(describeWalletError(undefined)).toBe('Unknown error');
  });

  it.each<[string, unknown, string]>([
    [
      "the extension's 4900 inside an ethers error",
      { code: 'UNKNOWN_ERROR', message: 'unknown error', error: STOPPED_WAITING },
      `${STOPPED_WAITING_MESSAGE} (4900)`,
    ],
    [
      "the extension's 4900 in the data of a JSON-RPC error",
      { code: -32603, message: 'Internal error', data: STOPPED_WAITING },
      `${STOPPED_WAITING_MESSAGE} (4900)`,
    ],
    [
      '4900 as a string, as the cause of another error',
      Object.assign(new Error('Request failed'), { cause: { code: '4900', message: STOPPED_WAITING_MESSAGE } }),
      `${STOPPED_WAITING_MESSAGE} (4900)`,
    ],
    [
      '-32005 in the data of a JSON-RPC error',
      { code: -32603, message: 'Internal error', data: STILL_PENDING },
      `${STILL_PENDING.message} (-32005)`,
    ],
  ])("names the code of the wallet's answer that it still holds the request, in %s", (_name, error, description) => {
    expect(describeWalletError(error)).toBe(description);
  });

  it.each<[string, unknown, string]>([
    [
      'a refusal in the data of a JSON-RPC error',
      { code: -32603, message: 'Internal error', data: { code: 4900, message: 'Disconnected' } },
      'Internal error (-32603)',
    ],
    [
      '4900 whose cause says the request can still complete, with no code of its own',
      Object.assign(new Error('Disconnected'), { code: 4900, cause: new Error(STOPPED_WAITING_MESSAGE) }),
      'Disconnected (4900)',
    ],
  ])('describes the outer error of %s', (_name, error, description) => {
    expect(describeWalletError(error)).toBe(description);
  });
});

describe('describeWalletRefusal', () => {
  it.each<[string, unknown, string]>([
    ["the Anchorage extension's answer", UNAUTHORIZED, 'Unauthorized (4100)'],
    [
      'a refusal with its code as a string',
      { code: '4901', message: 'Chain Disconnected' },
      'Chain Disconnected (4901)',
    ],
    [
      'a refusal inside an ethers error',
      { code: 'UNKNOWN_ERROR', message: 'unknown error', error: UNAUTHORIZED },
      'Unauthorized (4100)',
    ],
    [
      'a refusal in the data of a JSON-RPC error',
      { code: -32603, message: 'Internal error', data: { code: 4900, message: 'Disconnected' } },
      'Disconnected (4900)',
    ],
  ])('names the code of %s', (_name, error, description) => {
    expect(describeWalletRefusal(error)).toBe(description);
  });
});

describe('probeWalletSession', () => {
  function provider(responses: Record<string, () => Promise<unknown>>) {
    return { send: jest.fn((method: string) => responses[method]()) };
  }

  it('is usable when the wallet reports the chain and can read a block', async () => {
    const wallet = provider({ eth_chainId: async () => '0x1', eth_blockNumber: async () => '0x10' });

    await expect(probeWalletSession(wallet, 1)).resolves.toEqual({ status: 'usable' });
    expect(wallet.send).toHaveBeenCalledWith('eth_blockNumber', []);
  });

  it('is unusable when a read fails after the wallet acknowledged the network', async () => {
    const wallet = provider({
      eth_chainId: async () => '0x2105',
      eth_blockNumber: async () => Promise.reject({ code: -32603, message: 'Internal error' }),
    });

    await expect(probeWalletSession(wallet, 8453)).resolves.toEqual({ status: 'unusable', reason: 'reads-failing' });
  });

  it('is unusable with failing reads, not a broken provider, when a read is answered as still pending', async () => {
    const wallet = provider({
      eth_chainId: async () => '0x1',
      eth_blockNumber: async () => Promise.reject(STILL_PENDING),
    });

    await expect(probeWalletSession(wallet, 1)).resolves.toEqual({ status: 'unusable', reason: 'reads-failing' });
  });

  it('is unusable with failing reads, not a broken provider, when a read is refused', async () => {
    const wallet = provider({
      eth_chainId: async () => '0x1',
      eth_blockNumber: async () => Promise.reject({ code: 4900, message: 'Disconnected' }),
    });

    await expect(probeWalletSession(wallet, 1)).resolves.toEqual({ status: 'unusable', reason: 'reads-failing' });
  });

  it('is unusable when the provider throws, as after an extension update', async () => {
    const wallet = provider({ eth_chainId: async () => Promise.reject(BROKEN_EXTENSION) });

    await expect(probeWalletSession(wallet, 1)).resolves.toEqual({ status: 'unusable', reason: 'provider-broken' });
  });

  it('is unusable when the wallet reports another network than the session', async () => {
    const wallet = provider({ eth_chainId: async () => '0x89', eth_blockNumber: async () => '0x10' });

    await expect(probeWalletSession(wallet, 1)).resolves.toEqual({ status: 'unusable', reason: 'chain-mismatch' });
    expect(wallet.send).not.toHaveBeenCalledWith('eth_blockNumber', []);
  });
});

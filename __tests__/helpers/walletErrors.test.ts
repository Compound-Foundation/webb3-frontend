import { classifyWalletError, describeWalletError, probeWalletSession, WalletErrorKind } from '@helpers/walletErrors';

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
  ])('keeps %s as before', (_name, error, kind) => {
    expect(classifyWalletError(error)).toBe(kind);
  });

  it.each<[string, unknown]>([
    ['the TypeError an updated extension throws', BROKEN_EXTENSION],
    ['an invalidated extension context', new Error('Extension context invalidated.')],
    ['a broken provider inside an ethers error', { code: 'UNKNOWN_ERROR', error: BROKEN_EXTENSION }],
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
    expect(describeWalletError(undefined)).toBe('Unknown error');
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

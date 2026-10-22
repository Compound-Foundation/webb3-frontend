import { classifyWalletError, describeWalletError, probeWalletSession } from '@helpers/walletErrors';

const BROKEN_EXTENSION = new TypeError("Cannot read properties of undefined (reading 'sendMessage')");

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
    ['a string', 'failed'],
    ['nothing', undefined],
  ])('treats %s as an unknown outcome, not a rejection', (_name, error) => {
    expect(classifyWalletError(error)).toBe('provider-failure');
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

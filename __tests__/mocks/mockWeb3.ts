import { JsonRpcProvider } from '@ethersproject/providers';

import { Web3 } from 'src/contexts/Web3Context';

export const mockWeb3: Web3 = {
  read: {
    connector: undefined,
    chainId: 1,
    account: '0x124',
    isActive: true,
    provider: undefined as unknown as JsonRpcProvider,
  },
  write: {
    connector: undefined,
    chainId: 1,
    account: '0x124',
    isActive: true,
    provider: undefined as unknown as JsonRpcProvider,
  },
  desiredWriteNetwork: 1,
  setConnector: jest.fn().mockImplementation(() => Promise.resolve(true)),
  switchReadNetwork: jest.fn().mockImplementation(() => Promise.resolve(true)),
  switchWriteNetwork: jest.fn().mockImplementation(() => Promise.resolve(true)),
  connectWallet: jest.fn().mockImplementation(() => Promise.resolve()),
  disconnectWallet: jest.fn().mockImplementation(() => Promise.resolve(true)),
};

export const mockWeb3NoWallet: Web3 = {
  read: {
    connector: undefined,
    chainId: 1,
    account: undefined,
    isActive: true,
    provider: undefined as unknown as JsonRpcProvider,
  },
  write: {
    connector: undefined,
    chainId: 1,
    account: undefined,
    isActive: true,
    provider: undefined as unknown as JsonRpcProvider,
  },
  desiredWriteNetwork: 1,
  setConnector: jest.fn().mockImplementation(() => Promise.resolve(true)),
  switchReadNetwork: jest.fn().mockImplementation(() => Promise.resolve(true)),
  switchWriteNetwork: jest.fn().mockImplementation(() => Promise.resolve(true)),
  connectWallet: jest.fn().mockImplementation(() => Promise.resolve()),
  disconnectWallet: jest.fn().mockImplementation(() => Promise.resolve(true)),
};

import { JsonRpcProvider, Web3Provider as EthersWeb3Provider } from '@ethersproject/providers';
import {
  createContext,
  Dispatch,
  ReactNode,
  SetStateAction,
  useCallback,
  useEffect,
  useState,
  useContext,
} from 'react';
import { useLocation } from 'react-router-dom';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useConnectorClient,
  Connector as WagmiConnector,
} from 'wagmi';

import { CHAINS } from '@constants/chains';
import { CONNECTOR_LOCALSTORAGE_KEY } from '@helpers/constants';
import { useEthersProvider } from '@helpers/ethersAdapter';
import { isLedgerConnector } from '@helpers/Ledger';
import { DEFAULT_MARKET } from '@helpers/markets';
import { isSanctioned } from '@helpers/sanctions';

import { WALLECT_CONNECT_PROJECT_ID } from '../../envVars';

export const Web3Context = createContext<Web3 | undefined>(undefined);

export function useWriteProvider(
  writeConnector: WagmiConnector | undefined,
  isConnected: boolean,
  ethersProvider: JsonRpcProvider | undefined
) {
  const [provider, setProvider] = useState<JsonRpcProvider | EthersWeb3Provider | undefined>(undefined);
  const { data: connectorClient } = useConnectorClient();

  useEffect(() => {
    let isMounted = true;
    async function getProvider() {
      if (isConnected && connectorClient) {
        // @dev https://wagmi.sh/react/api/hooks/useConnectorClient
        // we use the connector client's transport to create an ethers provider
        const connectorProvider = connectorClient.transport;
        // getProvider() return type is not specified by Wagmi
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (isMounted) setProvider(new EthersWeb3Provider(connectorProvider as any));
      } else {
        if (isMounted) setProvider(ethersProvider);
      }
    }
    getProvider();
    return () => {
      isMounted = false;
    };
  }, [isConnected, connectorClient, ethersProvider]);

  return provider;
}

export function useWeb3Context() {
  const context = useContext(Web3Context);
  if (!context) throw new Error('Web3Context not found');
  return context;
}

export enum ConnectorType {
  Metamask = 'Metamask',
  WalletConnect = 'WalletConnect',
  WalletLink = 'WalletLink',
  Ledger = 'Ledger',
  Ronin = 'Ronin',
}

export type Connector =
  | [ConnectorType.Metamask]
  | [ConnectorType.WalletConnect]
  | [ConnectorType.WalletLink]
  | [ConnectorType.Ledger, [string, string]]
  | [ConnectorType.Ronin];

export type ReadWeb3 = {
  connector: undefined;
  chainId: number | undefined;
  account: string | undefined;
  isActive: boolean;
  provider: JsonRpcProvider | undefined;
};

export type WriteWeb3 = {
  connector: WagmiConnector | undefined; // wagmi connector type
  chainId: number | undefined;
  account: string | undefined;
  isActive: boolean;
  provider: JsonRpcProvider | EthersWeb3Provider | undefined;
};

export type Web3 = {
  read: ReadWeb3;
  write: WriteWeb3;
  desiredWriteNetwork?: number;
  setConnector: Dispatch<SetStateAction<Connector | null>>;
  switchReadNetwork: (desiredChainId: number) => Promise<boolean>;
  switchWriteNetwork: (desiredChainId: number) => Promise<boolean>;
  connectWallet: (connector: Connector) => Promise<void>;
  disconnectWallet: () => Promise<void>;
};

type Web3ProviderProps = {
  children?: ReactNode;
};

const connectorsMap = {
  [ConnectorType.Metamask]: { id: 'injected' },
  [ConnectorType.WalletConnect]: { id: 'walletConnect', options: { projectId: WALLECT_CONNECT_PROJECT_ID } },
  [ConnectorType.WalletLink]: { id: 'coinbaseWalletSDK' },
  [ConnectorType.Ledger]: { id: 'ledger' },
  [ConnectorType.Ronin]: { id: 'com.roninchain.wallet' },
};

export const Web3Provider = ({ children }: Web3ProviderProps) => {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const [connector, setConnector] = useState<Connector | null>(null);
  const [desiredWriteNetwork, setDesiredWriteNetwork] = useState<undefined | number>();
  const [readChainId, setReadChainId] = useState<number>(DEFAULT_MARKET.chainInformation.chainId);

  const { address: account, chainId: writeChainId, connector: writeConnector, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const readProvider = useEthersProvider({ chainId: readChainId });
  const ethersProvider = useEthersProvider({ chainId: writeChainId });
  const writeProvider = useWriteProvider(writeConnector, isConnected, ethersProvider);

  let writeWeb3: WriteWeb3;
  const urlAccount = searchParams.has('account') ? (searchParams.get('account') as string) : account;
  if (searchParams.has('account')) {
    writeWeb3 = {
      account: urlAccount,
      connector: undefined,
      chainId: readChainId,
      isActive: true,
      provider: undefined,
    };
  } else {
    writeWeb3 = {
      account,
      connector: writeConnector,
      chainId: writeChainId,
      isActive: isConnected,
      provider: writeProvider,
    };
  }

  // Initial activation of readWeb3 connector and grabbing of preferred connector type from local storage
  useEffect(() => {
    const storedConnectorString = window.localStorage.getItem(CONNECTOR_LOCALSTORAGE_KEY);
    if (storedConnectorString !== null && !searchParams.has('account') && !isConnected) {
      try {
        const storedConnectorType = JSON.parse(storedConnectorString)[0];
        const storedConnector = [storedConnectorType] as Connector;

        if (storedConnector[0] !== connector?.[0]) {
          connectWallet(storedConnector);
        }
      } catch (error) {
        console.error('Error parsing stored connector:', error);
        window.localStorage.removeItem(CONNECTOR_LOCALSTORAGE_KEY);
      }
    }
  }, []);

  // Listen to changes in ConnectorType
  useEffect(() => {
    if (connector !== null) {
      if (connector[0] === ConnectorType.Ledger) {
        // If the user uses ledger lets, let's wipe out their connector type
        // to force them to choose again on next since ledger can't autoconnect.
        window.localStorage.removeItem(CONNECTOR_LOCALSTORAGE_KEY);
      } else {
        window.localStorage.setItem(CONNECTOR_LOCALSTORAGE_KEY, JSON.stringify(connector));
      }
    }
  }, [connector]);

  // Create functions to switch desired network
  const switchReadNetwork = useCallback(async (desiredChainId: number): Promise<boolean> => {
    setReadChainId(desiredChainId);
    return true;
  }, []);

  const switchWriteNetwork = useCallback(
    async (desiredWriteChainId: number): Promise<boolean> => {
      if (writeWeb3.provider && writeWeb3.chainId !== desiredWriteChainId) {
        setDesiredWriteNetwork(desiredWriteChainId);
        // if wallet is connected, prompt user to switch their wallet's network
        try {
          await switchChain({ chainId: desiredWriteChainId });
          setDesiredWriteNetwork(undefined);
          return true;
        } catch (e) {
          // if network is not added to the network, add it
          if ((e as { code: number; message: string }).code === 4902) {
            const chainInfo = CHAINS[desiredWriteChainId];
            if (writeWeb3.provider instanceof JsonRpcProvider) {
              await writeWeb3.provider?.send('wallet_addEthereumChain', [
                {
                  chainId: '0x' + desiredWriteChainId.toString(16), // A 0x-prefixed hexadecimal string
                  chainName: chainInfo.name,
                  nativeCurrency: chainInfo.nativeToken,
                  rpcUrls: chainInfo.walletRpcUrls,
                  blockExplorerUrls: chainInfo.blockExplorerUrls,
                },
              ]);
            } else {
              console.warn(
                'writeWeb3.provider is not a JsonRpcProvider instance. Cannot add new network.',
                writeWeb3.provider
              );
            }
            return true;
          } else if ((e as { code: number; message: string }).code === 4001) {
            // The user rejected the switch just return and don't activateNetwork
            setDesiredWriteNetwork(undefined);
            return false;
          } else if ((e as { code: number; message: string }).code === -32002) {
            //  Request of type 'wallet_switchEthereumChain' already pending
            return false;
          }
        }
        setDesiredWriteNetwork(undefined);
      }
      return true;
    },
    [writeWeb3.provider, writeWeb3.chainId]
  );

  // Create function to connect to a specific wallet type
  const connectWallet = async (newConnector: Connector) => {
    if (newConnector !== connector) {
      setConnector(newConnector);
      const [connectorType] = newConnector;
      const connectorConfig = connectorsMap[connectorType];
      const connector = connectors.find((c) => c.id === connectorConfig.id);
      if (!connector) throw new Error(`Connector ${connectorType} not found`);
      if (connectorType === ConnectorType.Ledger) {
        const [, [pathString, address]] = newConnector;

        if (isLedgerConnector(connector)) {
          connector.setLedgerParams({ pathString, address });
        }

        try {
          connect({ connector });
        } catch (error) {
          console.error('Error connecting Ledger:', error);
        }
      } else {
        try {
          connect({ connector });
        } catch (error) {
          console.error('Error connecting wallet:', error);
        }
      }
    }
  };

  const disconnectWallet = async () => {
    disconnect();
    window.localStorage.removeItem(CONNECTOR_LOCALSTORAGE_KEY);
  };

  if (writeWeb3.account !== undefined && isSanctioned(writeWeb3.account)) {
    writeWeb3.account = undefined;
    writeWeb3.isActive = false;
  }

  const web3: Web3 = {
    read: {
      connector: undefined,
      chainId: readChainId,
      account: writeWeb3.account,
      isActive: !!readProvider,
      provider: readProvider,
    },
    write: writeWeb3,
    desiredWriteNetwork,
    setConnector,
    switchReadNetwork,
    switchWriteNetwork,
    connectWallet,
    disconnectWallet,
  };
  if (!readProvider) {
    console.warn('Read provider is not available for chainId', readChainId);
  }

  return <Web3Context.Provider value={web3}>{children}</Web3Context.Provider>;
};

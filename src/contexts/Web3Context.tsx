import { JsonRpcProvider, Web3Provider as EthersWeb3Provider } from '@ethersproject/providers';
import {
  createContext,
  Dispatch,
  ReactNode,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
  useContext,
} from 'react';
import { useLocation } from 'react-router';
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
import { useAnnouncedRdns, useConflictedRdns } from '@helpers/eip6963Security';
import { useEthersProvider } from '@helpers/ethersAdapter';
import { isLedgerConnector } from '@helpers/Ledger';
import { DEFAULT_MARKET } from '@helpers/markets';
import {
  isAllowedConnectorId,
  isConnectorConflicted,
  migrateStoredConnectorIds,
} from '@helpers/walletConnectors';
import { useAddressScreening, ScreeningStatus } from '@hooks/useAddressScreening';
import { useDisconnectBlockedWallet } from '@hooks/useDisconnectBlockedWallet';

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

/**
 * A wallet choice. `id` is any wagmi connector id: one we registered ourselves
 * (`injected`, `walletConnect`, `coinbaseWalletSDK`) or, for a wallet discovered over
 * EIP-6963, its RDNS. Ledger is its own variant because it alone needs parameters set
 * before `connect()`.
 */
export type Connector =
  | { kind: 'connector'; id: string }
  | { kind: 'ledger'; path: string; address: string };

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
  screeningStatus: ScreeningStatus;
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

export const Web3Provider = ({ children }: Web3ProviderProps) => {
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  // Only the setter is read: the preference is written to localStorage by
  // `connectWallet` once a connect actually succeeds, not from this state. `setConnector`
  // stays on the context as part of its public surface.
  const [, setConnector] = useState<Connector | null>(null);
  const [desiredWriteNetwork, setDesiredWriteNetwork] = useState<undefined | number>();
  const [readChainId, setReadChainId] = useState<number>(DEFAULT_MARKET.chainInformation.chainId);

  const { address: account, chainId: writeChainId, connector: writeConnector, isConnected } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const readProvider = useEthersProvider({ chainId: readChainId });
  const ethersProvider = useEthersProvider({ chainId: writeChainId });
  const writeProvider = useWriteProvider(writeConnector, isConnected, ethersProvider);

  let writeWeb3: WriteWeb3;
  const urlAccount = searchParams.has('account') ? (searchParams.get('account') as string) : account;
  const screeningStatus = useAddressScreening(urlAccount);
  // A blocked wallet is fully disconnected, not just gated out of view.
  useDisconnectBlockedWallet(screeningStatus, disconnect);
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

  // Reconnect to the previously chosen wallet.
  const conflictedRdns = useConflictedRdns();
  const announcedRdns = useAnnouncedRdns();
  const reconnectSettled = useRef(false);
  useEffect(() => {
    // Once the user is connected the latch is closed for good: leaving it armed lets a
    // later disconnect — including one made from inside the wallet, which flips
    // `isConnected` without touching our key — re-run this and fire an unsolicited
    // connect right after a deliberate disconnect.
    if (isConnected) reconnectSettled.current = true;
    if (reconnectSettled.current || searchParams.has('account')) return;

    const storedValue = window.localStorage.getItem(CONNECTOR_LOCALSTORAGE_KEY);
    if (storedValue === null) {
      reconnectSettled.current = true;
      return;
    }

    // Untrusted input: any content script can write this key. Anything not on the
    // allowlist resolves to no candidates at all.
    const candidates = migrateStoredConnectorIds(storedValue);
    if (candidates.length === 0) {
      window.localStorage.removeItem(CONNECTOR_LOCALSTORAGE_KEY);
      reconnectSettled.current = true;
      return;
    }

    // Two providers claimed the rdns this id speaks for, so we can't know which one the
    // user chose last time. Drop the preference; the modal explains via the warning row.
    if (candidates.every((id) => isConnectorConflicted(id, conflictedRdns))) {
      window.localStorage.removeItem(CONNECTOR_LOCALSTORAGE_KEY);
      reconnectSettled.current = true;
      return;
    }

    // EIP-6963 announcements can land at any point after mount, so a connector missing
    // now may still show up and this effect reruns when it does. We deliberately never
    // discard the stored id over a miss: there is no batch we can call the last one, and
    // a preference for a wallet the user has since uninstalled costs only a dead
    // localStorage key, overwritten as soon as they connect to anything else.
    const isUsableTarget = (id: string) => {
      if (isConnectorConflicted(id, conflictedRdns)) return false;
      // Same rule as the legacy row: bare `window.ethereum` is only safe when nothing
      // announced. Otherwise a migrated `Metamask` preference would connect through
      // whichever extension won the race, purely because the real one had not announced
      // by the time this effect first ran.
      if (id === 'injected' && announcedRdns.size > 0) return false;
      return connectors.some((c) => c.id === id);
    };

    const targetId = candidates.find(isUsableTarget);
    if (targetId === undefined) return;

    reconnectSettled.current = true;
    connectWallet({ kind: 'connector', id: targetId });
  }, [connectors, isConnected, conflictedRdns, announcedRdns]);

  // The impersonation signal can arrive after connection: the impostor announces
  // first, we connect to it, then the real wallet announces. Sever the session rather
  // than keep signing with a provider we can no longer trust.
  useEffect(() => {
    if (writeConnector !== undefined && isConnectorConflicted(writeConnector.id, conflictedRdns)) {
      disconnect();
      window.localStorage.removeItem(CONNECTOR_LOCALSTORAGE_KEY);
    }
  }, [conflictedRdns, writeConnector, disconnect]);

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

  // Create function to connect to a specific wallet
  const connectWallet = async (newConnector: Connector) => {
    const targetId = newConnector.kind === 'ledger' ? 'ledger' : newConnector.id;

    // An explicit choice settles the reconnect latch either way, so a failed or
    // rejected attempt can't leave it armed to fire again later in the session.
    reconnectSettled.current = true;

    // Vetted before any state changes: an id off the allowlist, or one whose rdns two
    // providers are claiming, must never reach `connect()`.
    if (newConnector.kind === 'connector') {
      if (!isAllowedConnectorId(targetId) || isConnectorConflicted(targetId, conflictedRdns)) {
        console.error(`Refusing to connect to ${targetId}`);
        return;
      }
    }

    const wagmiConnector = connectors.find((c) => c.id === targetId);
    if (!wagmiConnector) {
      // Reachable when an extension is disabled mid-session, and both call sites treat
      // this as fire-and-forget — so log rather than throw an unhandled rejection.
      console.error(`Connector ${targetId} not found`);
      return;
    }

    // Ledger alone needs a path and address set before it can open a session.
    if (newConnector.kind === 'ledger' && isLedgerConnector(wagmiConnector)) {
      wagmiConnector.setLedgerParams({ pathString: newConnector.path, address: newConnector.address });
    }

    try {
      // `connectAsync` rejects; `connect` is a TanStack `mutate` that swallows the
      // rejection internally, which made this catch dead code.
      await connectAsync({ connector: wagmiConnector });
    } catch (error) {
      // A rejected prompt must leave no trace: persisting on intent would fire an
      // unsolicited popup next load for a wallet the user explicitly declined.
      console.error(`Error connecting wallet (${targetId}):`, error);
      return;
    }

    setConnector(newConnector);
    if (newConnector.kind === 'ledger') {
      // Ledger can't autoconnect, so wipe the preference to force a fresh choice.
      window.localStorage.removeItem(CONNECTOR_LOCALSTORAGE_KEY);
    } else {
      window.localStorage.setItem(CONNECTOR_LOCALSTORAGE_KEY, newConnector.id);
    }
  };

  const disconnectWallet = async () => {
    reconnectSettled.current = true;
    disconnect();
    setConnector(null);
    window.localStorage.removeItem(CONNECTOR_LOCALSTORAGE_KEY);
  };

  // Fail-closed screening gate: expose the account only when explicitly allowed.
  if (writeWeb3.account !== undefined && screeningStatus !== 'allowed') {
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
    screeningStatus,
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

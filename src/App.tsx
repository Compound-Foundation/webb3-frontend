import '../styles/main.scss';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import AlertBanner from '@components/AlertBanner';
import ConnectWalletModal from '@components/ConnectWalletModal';
import Footer from '@components/Footer';
import Header from '@components/Header';
import NetworkSwitchModal, { NetworkSwitchModalState } from '@components/NetworkSwitchModal';
import * as ActionQueueContextHelpers from '@contexts/ActionQueueContext';
import { CurrencyContextProvider } from '@contexts/CurrencyContext';
import RewardsStateContext from '@contexts/RewardsStateContext';
import { initializeContext, getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import { useWeb3Context } from '@contexts/Web3Context';
import { estimateGasForActions, getKeyForActions, initialEstimatedGasMap } from '@helpers/gasEstimator';
import { useActionQueue } from '@hooks/useActionQueue';
import { useCometState } from '@hooks/useCometState';
import { useRewardsState } from '@hooks/useRewardsState';
import { useSelectedMarketState } from '@hooks/useSelectedMarket';
import { useThemeManager } from '@hooks/useThemeManager';
import { useTransactionManager } from '@hooks/useTransactionManager';
import { Action, MarketDataLoaded, StateType } from '@types';

import { allExtensions } from './pages/extensions/helpers/list';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function App({ Component, pageProps }: any) {
  const web3 = useWeb3Context();
  const [showConnectWalletModal, setShowConnectWalletModal] = useState(false);
  const [networkSwitchState, setNetworkSwitchState] = useState<NetworkSwitchModalState>(undefined);
  const [pendingSwitchChainId, setPendingSwitchChainId] = useState<number | null>(null);
  const selectedMarketState = useSelectedMarketState(web3);
  initializeContext(selectedMarketState);
  const SelectedMarketContext = getSelectedMarketContext();

  const location = useLocation();
  const { transactions, addTransaction, clearTransactions } = useTransactionManager(web3);
  const rewardsState = useRewardsState(web3, transactions);
  const { theme, setTheme } = useThemeManager();
  const themeRef = useRef(theme);

  useEffect(() => {
    const body = document.getElementsByTagName('body')[0];
    body.classList.add('theme');
    body.classList.remove(`theme--${themeRef.current.toLowerCase()}`);
    body.classList.add(`theme--${theme.toLowerCase()}`);
    themeRef.current = theme;
  }, [theme]);

  // Update the document/tab title upon navigating to a new page.
  useEffect(() => {
    if (location.pathname.startsWith('/')) {
      document.title = 'Compound | Dashboard';
    }
    if (location.pathname.startsWith('/markets')) {
      document.title = 'Compound | Markets';
    }
    if (location.pathname.startsWith('/extensions')) {
      document.title = 'Compound | Extensions';
    }

    const extensionPathRegex = new RegExp('^\\/extensions\\/([a-zA-Z0-9-_]+)');
    const pathMatch = location.pathname.match(extensionPathRegex);
    if (pathMatch !== null) {
      const [extensionId] = pathMatch.slice(1);
      const maybeExtension = allExtensions.find((extension) => extension.id === extensionId);
      if (maybeExtension) {
        document.title = `Compound | ${maybeExtension.name}`;
      }
    }
  }, [location.pathname]);

  const cometState = useCometState(web3, selectedMarketState.selectedMarket, transactions);
  initializeContext(selectedMarketState);

  const handleRequestNetworkSwitch = (fromChainId: number, toChainId: number, description?: string) => {
    setNetworkSwitchState({
      fromChainId,
      toChainId,
      description,
      onRequestClose: () => {
        setNetworkSwitchState(undefined);
        setPendingSwitchChainId(null);
      },
    });
    setPendingSwitchChainId(toChainId);
  };

  const handleSwitchNetwork = async () => {
    if (pendingSwitchChainId !== null) {
      await web3.switchWriteNetwork(pendingSwitchChainId);
      setNetworkSwitchState(undefined);
      setPendingSwitchChainId(null);
    }
  };

  // Wallet connect for mobile requires that we pre-estimate gas for
  // transactions before they are submitted for better UX.
  const preEstimateGas = async (actions: Action[]) => {
    if (
      actions.length > 0 &&
      selectedMarketState.selectedMarket[0] == StateType.Hydrated &&
      cometState[0] == StateType.Hydrated
    ) {
      const actionsKey = getKeyForActions(actions);
      if (!estimatedGasMap.has(actionsKey) || estimatedGasMap.get(actionsKey) === 0) {
        const estimatedGas = await estimateGasForActions(
          web3,
          selectedMarketState.selectedMarket[1] as MarketDataLoaded,
          cometState[1].baseAsset,
          cometState[1].collateralAssets,
          actions
        );

        const newGasMap = new Map(estimatedGasMap.set(actionsKey, estimatedGas));
        setEstimatedGasMap(newGasMap);
      }
    }
  };

  const [estimatedGasMap, setEstimatedGasMap] = useState(initialEstimatedGasMap(undefined));
  const actionQueue = useActionQueue(
    selectedMarketState.selectedMarket,
    (actions: Action[]) => {
      preEstimateGas(actions);
    },
    web3.write.account
  );

  useEffect(() => {
    // If a user hasn't enabled bulker then they first have to enable bulker
    // while they have actions in the queue so this catches that flow.
    if (
      transactions.length === 0 &&
      selectedMarketState.selectedMarket[0] == StateType.Hydrated &&
      cometState[0] == StateType.Hydrated
    ) {
      const actionsInQueue = actionQueue.getActions(
        cometState[1].baseAsset,
        cometState[1].collateralAssets,
        rewardsState
      );
      preEstimateGas(actionsInQueue);
    }
  }, [transactions, selectedMarketState.selectedMarket[0], cometState[0], rewardsState[0]]);

  useEffect(() => {
    let maybeChainInfo = undefined;
    if (selectedMarketState.selectedMarket[0] == StateType.Hydrated) {
      maybeChainInfo = selectedMarketState.selectedMarket[1].chainInformation;
    }
    setEstimatedGasMap(initialEstimatedGasMap(maybeChainInfo));
  }, [selectedMarketState.selectedMarket]);

  ActionQueueContextHelpers.initializeContext(actionQueue);
  const ActionQueueContext = ActionQueueContextHelpers.getActionQueueContext();

  return (
    <SelectedMarketContext.Provider value={selectedMarketState}>
      <RewardsStateContext.Provider value={rewardsState}>
        <ActionQueueContext.Provider value={actionQueue}>
          <CurrencyContextProvider>
            <AlertBanner web3={web3} />
            <Header
              web3={web3}
              transactions={transactions}
              clearTransactions={() => {
                clearTransactions();
                actionQueue.clearActions();
              }}
              onConnectWalletClick={() => {
                setShowConnectWalletModal(true);
              }}
              onWalletDisconnect={() => {
                web3.disconnectWallet();
              }}
            />
            <ConnectWalletModal
              isOpen={showConnectWalletModal}
              onRequestClose={() => {
                setNetworkSwitchState(undefined);
                setShowConnectWalletModal(false);
              }}
              onSelectConnector={(connector) => {
                web3.connectWallet(connector);
                setShowConnectWalletModal(false);
              }}
            />
            <NetworkSwitchModal state={networkSwitchState} onSwitchNetwork={handleSwitchNetwork} />
            <Component
              transactions={transactions}
              web3={web3}
              addTransaction={addTransaction}
              theme={theme}
              cometState={cometState}
              setShowConnectWalletModal={setShowConnectWalletModal}
              switchWriteNetwork={(chainId: number, description?: string) => {
                if (web3.write.chainId) {
                  handleRequestNetworkSwitch(web3.write.chainId, chainId, description);
                  return;
                }

                web3.switchWriteNetwork(chainId);
              }}
              estimatedGasMap={estimatedGasMap}
              {...pageProps}
            />
            <Footer theme={theme} setTheme={setTheme} />
            <div id="overlay"></div>
          </CurrencyContextProvider>
        </ActionQueueContext.Provider>
      </RewardsStateContext.Provider>
    </SelectedMarketContext.Provider>
  );
}

export default App;

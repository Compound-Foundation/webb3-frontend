import { ExtMessage, InMessage } from '@compound-finance/comet-extension';
import { Contract } from '@ethersproject/contracts';
import { ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';

import IconPair from '@components/IconPair';
import { ArrowLeft, CircleCheckmark, ExternalLink, Github, PromptWallet } from '@components/Icons';
import LoadSpinner from '@components/LoadSpinner';
import { SimpleLink } from '@components/SimpleLink';
import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import Comet from '@helpers/abis/Comet';
import { getShortAddress } from '@helpers/address';
import { filterMap } from '@helpers/functions';
import { PreEstimatedAction } from '@helpers/gasEstimator';
import { DEFAULT_MARKET, getMarkets, marketKey } from '@helpers/markets';
import { getBlockExplorerUrlForAddress } from '@helpers/urls';
import { parseMarketKey } from '@hooks/useSelectedMarket';
import { Theme } from '@hooks/useThemeManager';
import type { AddTransaction } from '@hooks/useTransactionManager';
import { useWriteCometState } from '@hooks/useWriteCometState';
import { CometState, MarketData, MarketDataLoaded, StateType, Transaction } from '@types';

import { AllMarkets, Extension as ExtensionType } from './helpers/core';
import { Context, handleMessage } from './helpers/handler';
import { allExtensions, getOperator, getSrc } from './helpers/list';
import usePoll from './hooks/usePoll';

type BaseProps = {
  theme: Theme;
  cometState: CometState;
  transactions: Transaction[];
  web3: Web3;
  addTransaction: AddTransaction;
  setShowConnectWalletModal: (value: boolean) => void;
  estimatedGasMap: Map<string, number>;
};

type ExtensionState =
  | {
      enabled: boolean;
      toggleExtension: () => void;
      transactionPredicate: (transactions: Transaction[]) => Transaction | undefined;
    }
  | StateType.Loading
  | undefined;

const Extension = ({
  theme,
  cometState,
  transactions,
  web3,
  addTransaction,
  setShowConnectWalletModal,
  estimatedGasMap,
}: BaseProps) => {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const showTestnet = searchParams.has('testnet');
  const { extensionId } = useParams();
  const { selectedMarket, selectMarket } = useContext(getSelectedMarketContext());
  const writeState = useWriteCometState(web3, addTransaction);
  const [extensionLoaded, setExtensionLoaded] = useState<boolean>(false);
  const iFrameHeight = 1000;
  const [extensionState, setExtensionState] = useState<ExtensionState>(undefined);
  const markets = useMemo(() => getMarkets(showTestnet), [showTestnet]);
  const timer = usePoll(10000);
  const iFrameRef = useRef<HTMLIFrameElement>(null);
  const sandboxInputRef = useRef<HTMLInputElement>(null);
  const [sandboxClickedThrough, setSandboxClickedThrough] = useState<boolean>(false);
  const [sandboxErrorText, setSandboxErrorText] = useState<string | null>(null);
  const extension = allExtensions.find((extension) => extension.id === extensionId);
  const [extensionSource, setExtensionSource] = useState<string | null>(extension ? getSrc(extension) : null);

  const operator = !!extension && !!selectedMarket[1] ? getOperator(extension, selectedMarket[1]) : null;

  useEffect(() => {
    // Here we define a handler for incoming messages from iframes. We first need to match the message
    // to a given extension or otherwise we ignore it (since, for instance, it could have come from a Browser Extension).
    const handler = async (event: MessageEvent) => {
      if (
        iFrameRef.current !== null &&
        event.source !== null &&
        iFrameRef.current.contentWindow === (event.source as Window).window
      ) {
        const { msgId, message }: { msgId: number; message: InMessage } = event.data;
        // Don't send the selected market info to the extension yet, if it's not yet available.
        if (message.type === 'getSelectedMarket' && selectedMarket[0] === StateType.Loading) {
          return;
        }

        if (msgId !== undefined && message !== undefined && event.source && extension !== undefined) {
          // We've parsed a messsage and found the extension source, let's process it.
          const context: Context = {
            web3,
            addTransaction,
            selectedMarketData: selectedMarket[1] as MarketData | MarketDataLoaded,
          };
          const response = await handleMessage(context, extension.permissions, msgId, message, operator);
          // Send the response back to the extension's iframe.
          event.source.postMessage(response, { targetOrigin: '*' });
        }
      }
    };

    // Add the listener and remove it on dismount.
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [web3, selectedMarket, extension, operator]);

  function sendExtMessage(extMsg: ExtMessage) {
    iFrameRef.current?.contentWindow?.postMessage(extMsg, '*');
  }

  function setTheme(theme: Theme) {
    sendExtMessage({ type: 'setTheme', theme });
  }

  function setCometState(cometState: CometState) {
    sendExtMessage({ type: 'setCometState', cometState });
  }

  function setSelectedMarket(selectedMarketData: MarketData | MarketDataLoaded) {
    sendExtMessage({
      type: 'setSelectedMarket',
      selectedMarket: {
        chainId: selectedMarketData.chainInformation.chainId,
        baseAssetSymbol: selectedMarketData.baseAsset.symbol,
        marketAddress: selectedMarketData.marketAddress,
      },
    });
  }

  useEffect(() => {
    setTheme(theme);
  }, [theme]);

  useEffect(() => {
    setCometState(cometState);
  }, [cometState]);

  useEffect(() => {
    selectedMarket[1] && setSelectedMarket(selectedMarket[1]);
  }, [selectedMarket]);

  useEffect(() => {
    const sandboxSource = searchParams.get('sandboxsource');
    if (extension?.id === 'sandbox' && sandboxSource) {
      setExtensionSource(sandboxSource);
      if (sandboxInputRef.current) {
        sandboxInputRef.current.value = sandboxSource;
      }
    }
  }, []);

  useEffect(() => {
    if (extension !== undefined && web3.write.account !== undefined) {
      const selectedMarketData = selectedMarket[1];

      if (operator !== null) {
        if (extensionState === undefined) {
          setExtensionState(StateType.Loading);
        }

        if (selectedMarketData !== undefined) {
          (async () => {
            const comet = new Contract(selectedMarketData.marketAddress, Comet, web3.read.provider);

            const migratorEnabled = (await comet.allowance(web3.write.account, operator))?.toBigInt() > 0n;
            const shortenedOperatorAddress = getShortAddress(operator);
            const [description, approval] = migratorEnabled
              ? [`Disable Operator - ${shortenedOperatorAddress}`, false]
              : [`Enable Operator - ${shortenedOperatorAddress}`, true];
            const toggleExtension = () => {
              const gasLimit = estimatedGasMap.get(PreEstimatedAction.AllowOperator) || 0;
              return (
                operator && writeState.allowOperator(selectedMarketData, operator, description, gasLimit, approval)
              );
            };
            setExtensionState({
              enabled: migratorEnabled,
              toggleExtension,
              transactionPredicate: (transactions: Transaction[]) => {
                return transactions.find((transaction) => transaction.key === operator);
              },
            });
          })();
        }
      }
    } else {
      setExtensionState(undefined);
    }
  }, [web3.write.account, extension, operator, timer]);

  if (extension === undefined) {
    return (
      <div className="extensions">
        <div className="extensions__masthead L1 hero-panel">
          <div className="text-color--1">
            {'Extension not found, '}
            <Link
              className="extension-list-row__link"
              to={{
                pathname: `/extensions`,
                search: location.search,
                hash: location.hash,
              }}
              style={{ color: 'var(--text--2)' }}
            >
              {'click here '}
            </Link>
            {'to go back to the overview page.'}
          </div>
        </div>
      </div>
    );
  }

  function initExtension() {
    if (extension) {
      setTheme(theme);
      setExtensionLoaded(true);
    }
  }

  // Triggered in sandbox mode
  function updateExtensionSource(extension: ExtensionType) {
    if (extension.id === 'sandbox' && sandboxInputRef.current !== null) {
      const maybeUrl = sandboxInputRef.current.value;
      // eslint-disable-next-line no-useless-escape
      if (maybeUrl.match(/\b(https?):\/\/[\-A-Za-z0-9+&@#\/%?=~_|!:,.;]*[\-A-Za-z0-9+&@#\/%=~_|]/)) {
        setExtensionSource(maybeUrl);
        const newSearchParams = new URLSearchParams(searchParams);
        newSearchParams.set('sandboxsource', maybeUrl);
        setSearchParams(newSearchParams);
        setSandboxErrorText(null);
      } else {
        setSandboxErrorText("Not a valid URL. Also make sure to prefix it with 'http(s)://'");
      }
    }
  }

  const supportedMarketDetails: MarketData[] | typeof AllMarkets =
    extension.supportedMarkets === AllMarkets
      ? AllMarkets
      : filterMap<[string, string | null], MarketData>(Object.entries(extension.supportedMarkets), ([key]) =>
          parseMarketKey(markets, key)
        );
  const operatorAddressInfo: [string | null | undefined, number] | undefined =
    selectedMarket[1] !== undefined ? [operator, selectedMarket[1].chainInformation.chainId] : undefined;

  let enableButton: ReactNode;

  if (extensionState === undefined) {
    enableButton = null;
    if (!!operator && !extensionSource) {
      enableButton = (
        <button className={`button button--x-large button--supply extensions__enable-button`} disabled>
          Connect to Use
        </button>
      );
    } else {
      enableButton = null;
    }
  } else if (extensionState === StateType.Loading) {
    enableButton = (
      <button className={`button button--x-large button--supply extensions__enable-button`} disabled>
        <LoadSpinner size={16} />
      </button>
    );
  } else if (extensionState.enabled) {
    const pendingTransaction = extensionState.transactionPredicate(transactions);
    enableButton = (
      <button
        className={`button button--x-large button--supply extensions__enable-button extensions__enable-button--enabled`}
        onClick={extensionState.toggleExtension}
        disabled={pendingTransaction !== undefined}
      >
        {pendingTransaction !== undefined ? (
          'Disabling...'
        ) : (
          <>
            <CircleCheckmark className="svg--supply" />
            Enabled
          </>
        )}
      </button>
    );
  } else {
    const pendingTransaction = extensionState.transactionPredicate(transactions);
    enableButton = (
      <button
        className={`button button--x-large button--supply extensions__enable-button`}
        onClick={extensionState.toggleExtension}
        disabled={pendingTransaction !== undefined}
      >
        {pendingTransaction !== undefined ? 'Enabling...' : 'Enable'}
      </button>
    );
  }

  const sandboxPerms = ['allow-scripts', 'allow-same-origin', 'allow-forms'];
  if (extension.permissions.sudo || extension.permissions.popups) {
    sandboxPerms.push('allow-popups');
  }

  if (extension.permissions.sudo || extension.permissions.modals) {
    sandboxPerms.push('allow-modals');
  }

  let extensionContent: JSX.Element | null = null;
  if (extensionSource) {
    if (web3.write.account) {
      // When the extension is in sandbox mode, prompt the user to click through
      // before starting the extension.
      if (extension.id === 'sandbox' && !sandboxClickedThrough) {
        extensionContent = (
          <>
            <div className="extension-banner L4 body text-color--3">
              <p>
                WARNING! You are in sandbox mode, and this is NOT an officially supported extension. Are you sure you
                want to
              </p>
              <p
                onClick={() => {
                  setSandboxClickedThrough(true);
                }}
                className="call-to-action"
              >
                allow this third-party extension?
              </p>
            </div>
            <div className="placeholder-content" style={{ width: '100%', height: '1000px', border: 'none' }} />
          </>
        );
      }
      // Make sure the current market matches the supported markets, otherwise prompt the user to switch markets.
      else if (
        selectedMarket[1] &&
        !Object.keys(extension.supportedMarkets).includes(marketKey(selectedMarket[1])) &&
        extension.supportedMarkets != AllMarkets
      ) {
        const firstSupportedMarketKey = Object.keys(extension.supportedMarkets)?.[0];
        const marketAssetSymbol = parseMarketKey(markets, firstSupportedMarketKey)?.baseAsset.symbol;
        extensionContent = (
          <>
            <div className="extension-banner L4 body text-color--3">
              <p
                onClick={() => {
                  selectMarket(DEFAULT_MARKET);
                }}
                className="call-to-action"
              >
                Switch to the V3 {marketAssetSymbol} market
              </p>
              <p>to start using this extension.</p>
            </div>
            <div className="placeholder-content" style={{ width: '100%', height: '1000px', border: 'none' }} />
          </>
        );
      } else {
        extensionContent = (
          <>
            {!extensionLoaded && (
              <div className="placeholder-content" style={{ width: '100%', height: '1000px', border: 'none' }} />
            )}
            <iframe
              className={extensionLoaded ? '' : 'loading'}
              ref={iFrameRef}
              src={extensionSource}
              sandbox={sandboxPerms.join(' ')}
              style={{
                width: '100%',
                height: `${iFrameHeight}px`,
              }}
              onLoad={() => initExtension()}
            />
          </>
        );
      }
    } else {
      extensionContent = (
        <div className="extensions__no-wallet-fallback">
          <PromptWallet />
          <div>
            <p
              onClick={() => {
                setShowConnectWalletModal(true);
              }}
              className="call-to-action L4 body text-color--3"
            >
              Connect a wallet
            </p>
            <p className="L4 body text-color--3">to preview this extension.</p>
          </div>
        </div>
      );
    }
  }

  return (
    <div className="extensions page">
      <div className="hero-panel extensions__masthead L1">
        <div className="extensions__masthead__row">
          <SimpleLink to="/extensions" className="extensions__masthead__back-to-overview">
            <ArrowLeft className="extensions__masthead__arrow svg--icon--2" />
            <p className="L1 meta text-color--2">Extensions</p>
          </SimpleLink>
        </div>
        <div className="extensions__masthead__row">
          <div className="extensions__masthead__left">
            <div className="extensions__icon-with-image">
              <span className={`extension-icon extension-icon--${extension.id} mobile-hide`} />
              <div>
                <h1 className="heading heading--emphasized text-color--1">{extension.name}</h1>
                {!!operatorAddressInfo && !!operatorAddressInfo[0] && (
                  <a
                    className="extensions__link"
                    href={getBlockExplorerUrlForAddress(operatorAddressInfo[1], operatorAddressInfo[0])}
                    target="_blank"
                  >
                    <p className="meta text-color--2">
                      {operatorAddressInfo[0]}
                      <span style={{ marginLeft: '0.25rem' }}>
                        <ExternalLink className="svg--icon--2" />
                      </span>
                    </p>
                  </a>
                )}
              </div>
            </div>
          </div>
          <div className="extensions__masthead__right">{enableButton}</div>
        </div>
        <div className="extensions__masthead__row" style={{ alignItems: 'flex-start', marginTop: '2.5rem' }}>
          <div className="extensions__masthead__left">
            <label className="label L2 text-color--2">Description</label>
            <p className="body L3 text-color--1" style={{ marginTop: '0.75rem', maxWidth: '39rem' }}>
              {extension.description}
              {extension.id === 'sandbox' && (
                <>
                  <div className="sandbox-extension-source-wrapper">
                    <input
                      className={'body L3'}
                      ref={sandboxInputRef}
                      placeholder={'http://localhost:3000/?embedded'}
                    />
                    <button
                      className={'label L2'}
                      onClick={() => {
                        updateExtensionSource(extension);
                      }}
                    >
                      Update Source
                    </button>
                  </div>
                  <div className="body L3 text-color--2" style={{ marginTop: '0.5rem' }}>
                    {sandboxErrorText}
                  </div>
                </>
              )}
            </p>
            {!!extension.sub_description && (
              <p className="body L3 text-color--2" style={{ marginTop: '0.75rem', maxWidth: '39rem' }}>
                <i>{extension.sub_description}</i>
              </p>
            )}
          </div>
          <div className="extensions__masthead__right">
            <div className="extensions__masthead__row">
              <label className="label L2 text-color--2">Developer</label>
              <a target={'_blank'} href={extension.links.website} className="extensions__link">
                <p className="meta L3 text-color--1">{extension.developer}</p>
                <ExternalLink className="svg--icon--2" />
              </a>
            </div>
            <div className="extensions__masthead__row" style={{ marginTop: '0.75rem' }}>
              <label className="label L2 text-color--2">Links</label>
              <a target={'_blank'} href={extension.links.github} className="extensions__link">
                <Github className="github svg--icon--1" />
                <p className="meta L3 text-color--1">Github</p>
                <ExternalLink className="svg--icon--2" />
              </a>
            </div>
            <div className="extensions__masthead__row" style={{ alignItems: 'flex-start', marginTop: '0.75rem' }}>
              <label className="label L2 text-color--2">Supported Markets</label>
              <div style={{ alignItems: 'flex-end', display: 'flex', flexDirection: 'column' }}>
                {supportedMarketDetails === AllMarkets ? (
                  <p className="meta text-color--1">All</p>
                ) : (
                  supportedMarketDetails.map((market) => (
                    <div className="extensions__supported-market" key={market.marketAddress}>
                      <IconPair icon1={market.iconPair[1]} icon2={market.iconPair[0]} />
                      <p className="meta text-color--1">
                        {market.baseAsset.symbol}
                        <span className="text-color--2"> • {market.chainInformation.name}</span>
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {extensionContent}
    </div>
  );
};

export default Extension;

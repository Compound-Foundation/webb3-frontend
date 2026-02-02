import { useEffect, useRef, useState } from 'react';

import {Ronin} from "@components/Icons/Ronin";
import { Connector, ConnectorType } from '@contexts/Web3Context';
import { getShortAddress } from '@helpers/address';
import { getLedgerAddresses } from '@helpers/Ledger';
import { TERMS_URL } from '@helpers/urls';
import useDisableScroll from '@hooks/useDisableScroll';
import useOnClickOutside from '@hooks/useOnClickOutside';

import { ArrowLeft, ArrowRight, CircleClose, Wallet } from './Icons';
import { BraveWallet } from './Icons/BraveWallet';
import { BrowserWallets } from './Icons/BrowserWallets';
import { Coinbase } from './Icons/Coinbase';
import { LedgerWallet } from './Icons/LedgerWallet';
import { WalletConnect } from './Icons/WalletConnect';
import { Mark } from './Logo';

export type ConnectWalletModalProps = {
  isOpen?: boolean;
  onRequestClose: () => void;
  onSelectConnector: (connector: Connector) => void;
};

enum ConnectWalletModalSteps {
  ChooseWalletConnector = 'choose-wallet-connector',
  PlugLedgerIn = 'plugin-ledger',
  LedgerError = 'ledger-error',
  SelectLedgerAddresses = 'select-ledger-address',
}

const ConnectWalletModal = ({ isOpen = false, onRequestClose, onSelectConnector }: ConnectWalletModalProps) => {
  const [modalStep, setModalStep] = useState(ConnectWalletModalSteps.ChooseWalletConnector);
  const [selectedLedgerPath, setSelectedLedgerPath] = useState<'live' | 'legacy'>('live');
  const [selectedAddress, setSelectedAddress] = useState<[string, string] | undefined>();
  const [ledgerPathDropdownActive, setLedgerPathDropdownActive] = useState(false);
  const [addressesDropdownActive, setAddressesDropdownActive] = useState(false);
  const [ledgerAddresses, setLedgerAddresses] = useState<
    | {
        legacyAddresses: [string, string][];
        liveAddresses: [string, string][];
      }
    | undefined
  >();
  const ledgerPathRef = useRef(null);
  const addressesRef = useRef(null);
  useDisableScroll(isOpen);

  useOnClickOutside(ledgerPathRef, () => {
    setLedgerPathDropdownActive(false);
  });
  useOnClickOutside(addressesRef, () => {
    setAddressesDropdownActive(false);
  });
  useEffect(() => {
    if (ledgerAddresses !== undefined) {
      setModalStep(ConnectWalletModalSteps.SelectLedgerAddresses);
    }
  }, [ledgerAddresses]);

  const onClose = () => {
    onRequestClose();
    setSelectedAddress(undefined);
    setLedgerAddresses(undefined);
    setModalStep(ConnectWalletModalSteps.ChooseWalletConnector);
  };

  const terms = (
    <div className="modal__terms meta text-color--2">
      {"By connecting, I accept Compound's "}
      <a className="text-color--supply" href={TERMS_URL} target="_blank" rel="noreferrer">
        Terms of Service
      </a>
    </div>
  );

  const isLedgerAvailable = 'usb' in navigator;

  const isUsingBrave = (window.ethereum as { isBraveWallet: boolean })?.isBraveWallet;

  const attemptLedgerConnect = () => {
    getLedgerAddresses()
      .then((result) => {
        setLedgerAddresses(result);
      })
      .catch((e) => {
        console.log('got ledger error: ', e);
        setModalStep(ConnectWalletModalSteps.LedgerError);
      });
    setModalStep(ConnectWalletModalSteps.PlugLedgerIn);
  };

  switch (modalStep) {
    case ConnectWalletModalSteps.ChooseWalletConnector: {
      const braveWalletConnector = (
        <div
          className="connect-wallet-item mobile-hide"
          onClick={() => {
            onSelectConnector([ConnectorType.Metamask]);
            onClose();
          }}
        >
          <BraveWallet className="connect-wallet-item__symbol" />
          <div className="connect-wallet-item__info">
            <div className="heading heading--emphasized">Brave Wallet</div>
            <div className="meta text-color--2">And other browser wallets</div>
          </div>

          <ArrowRight />
        </div>
      );

      const metamaskConnector = (
        <div
          className="connect-wallet-item connect-wallet-item--browser-wallet"
          onClick={() => {
            onSelectConnector([ConnectorType.Metamask]);
            onClose();
          }}
        >
          <BrowserWallets className="connect-wallet-item__symbol" />
          <div className="connect-wallet-item__info">
            <div className="heading heading--emphasized mobile-hide">Metamask</div>
            <div className="heading heading--emphasized mobile-only">Wallet Browser</div>
            <div className="meta text-color--2 mobile-hide">And other browser wallets</div>
            <div className="meta text-color--2 mobile-only">MetaMask Mobile, Brave, etc</div>
          </div>
          <ArrowRight />
        </div>
      );

      return (
        <div className={`modal modal--connect-wallet${isOpen ? ' modal--active' : ''}`}>
          <div className="modal__backdrop" onClick={onClose}></div>
          <div className="modal__content L3">
            <div className="modal__content__header mobile-hide">
              <div className="modal__content__header__left"></div>
              <div className="modal__content__header__right" onClick={onClose}>
                <CircleClose />
              </div>
            </div>
            <div className="modal__content__icon-holder" style={{ marginTop: '0' }}>
              <Mark />
            </div>
            <div className="modal__content__paragraph">
              <h2 className="heading heading--emphasized">Connect Wallet</h2>
              <p className="body text-color--2">To start using Compound</p>
            </div>

            <div className="connect-wallet-items L4">
              {isUsingBrave ? braveWalletConnector : metamaskConnector}

              <div
                className={`connect-wallet-item mobile-hide${
                  !isLedgerAvailable ? ' connect-wallet-item--disabled' : ''
                }`}
                onClick={() => {
                  if (isLedgerAvailable) {
                    attemptLedgerConnect();
                  }
                }}
              >
                <LedgerWallet className="connect-wallet-item__symbol" />
                <div className="connect-wallet-item__info">
                  <div className="heading heading--emphasized">Ledger</div>
                  {!isLedgerAvailable ? <div className="meta text-color--2">Available on Chrome</div> : null}
                </div>
                {isLedgerAvailable ? <ArrowRight /> : null}
              </div>
              <div
                className="connect-wallet-item"
                onClick={() => {
                  onSelectConnector([ConnectorType.WalletConnect]);
                  onClose();
                }}
              >
                <WalletConnect className="connect-wallet-item__symbol" />
                <div className="connect-wallet-item__info">
                  <div className="heading heading--emphasized">WalletConnect</div>
                </div>
                <ArrowRight />
              </div>
              <div
                className="connect-wallet-item"
                onClick={() => {
                  onSelectConnector([ConnectorType.WalletLink]);
                  onClose();
                }}
              >
                <Coinbase className="connect-wallet-item__symbol" />
                <div className="connect-wallet-item__info">
                  <div className="heading heading--emphasized">Coinbase Wallet</div>
                </div>
                <ArrowRight />
              </div>
              <div
                className="connect-wallet-item"
                onClick={() => {
                  onSelectConnector([ConnectorType.Ronin]);
                  onClose();
                }}
              >
                <Ronin className="connect-wallet-item__symbol" />
                <div className="connect-wallet-item__info">
                  <div className="heading heading--emphasized">Ronin</div>
                </div>
                <ArrowRight />
              </div>
            </div>
            {terms}
          </div>
        </div>
      );
    }
    case ConnectWalletModalSteps.PlugLedgerIn: {
      return (
        <div className={`modal${isOpen ? ' modal--active' : ''}`}>
          <div className="modal__backdrop" onClick={onClose}></div>
          <div className="modal__content L4">
            <div className="modal__content__header">
              <div
                className="modal__content__header__left" //TODO: There a multiple of these so make a component?
                onClick={() => {
                  setModalStep(ConnectWalletModalSteps.ChooseWalletConnector);
                }}
              >
                <ArrowLeft className="svg--icon--1" />
              </div>
              <h4 className="heading heading--emphasized heading">Plug in Ledger & Enter Pin</h4>
              <div className="modal__content__header__right" onClick={onClose}>
                <CircleClose />
              </div>
            </div>
            <div className="modal__content__icon-holder">
              <Wallet className="svg--icon--1 svg--wallet" />
            </div>
            <div className="modal__content__paragraph">
              <p className="body">Open ETH application and make sure Contract Data and Browser Support are enabled.</p>
            </div>
            {terms}
          </div>
        </div>
      );
    }
    case ConnectWalletModalSteps.LedgerError: {
      return (
        <div className={`modal${isOpen ? ' modal--active' : ''}`}>
          <div className="modal__backdrop" onClick={onClose}></div>
          <div className="modal__content L4">
            <div className="modal__content__header">
              <div
                className="modal__content__header__left"
                onClick={() => {
                  setModalStep(ConnectWalletModalSteps.ChooseWalletConnector);
                }}
              >
                <ArrowLeft className="svg--icon--1" />
              </div>
              <h4 className="heading heading--emphasized heading">Ledger Connection Failed</h4>
              <div className="modal__content__header__right" onClick={onClose}>
                <CircleClose />
              </div>
            </div>
            <div className="modal__content__icon-holder modal__content__icon-holder--with-error">
              <Wallet className="svg--icon--1 svg--wallet" />
            </div>
            <div className="modal__content__paragraph modal__content__paragraph--left-align">
              <p className="body text-color--2">1. Unlock your Ledger and open the ETH application.</p>
              <p className="body text-color--2">
                2. Verify Contract Data & Browser Support are enabled in the ETH settings.
              </p>
              <p className="body text-color--2">
                3. If Browser Support is not an option in settings, update to the latest firmware.
              </p>
            </div>
            <div className="modal__content__action-row">
              <button
                className="button button--x-large button--supply"
                onClick={() => {
                  attemptLedgerConnect();
                }}
              >
                Try Again
              </button>
            </div>
            {terms}
          </div>
        </div>
      );
    }
    case ConnectWalletModalSteps.SelectLedgerAddresses: {
      return (
        <div className={`modal${isOpen ? ' modal--active' : ''}`}>
          <div className="modal__backdrop" onClick={onClose}></div>
          <div className="modal__content L4">
            <div className="modal__content__header">
              <div
                className="modal__content__header__left"
                onClick={() => {
                  setModalStep(ConnectWalletModalSteps.ChooseWalletConnector);
                }}
              >
                <ArrowLeft className="svg--icon--1" />
              </div>
              <h4 className="heading heading--emphasized heading">Select Address</h4>
              <div className="modal__content__header__right" onClick={onClose}>
                <CircleClose />
              </div>
            </div>
            <div className="modal__content__icon-holder">
              <Wallet className="svg--icon--1 svg--wallet" />
            </div>
            <div className="modal__content__paragraph">
              <div
                ref={ledgerPathRef}
                className="dropdown dropdown--outline"
                onClick={() => setLedgerPathDropdownActive(!ledgerPathDropdownActive)}
              >
                <div className="connect-wallet-item__info">
                  <div className="heading heading--emphasized">
                    {selectedLedgerPath === 'live' ? 'Ledger Live' : 'Legacy'}
                  </div>
                </div>
                {ledgerPathDropdownActive && (
                  <div className="dropdown__content">
                    <div
                      className="connect-wallet-item"
                      onClick={() => {
                        setSelectedLedgerPath('live');
                      }}
                    >
                      <div className="connect-wallet-item__info">
                        <div className="heading heading--emphasized">Ledger Live</div>
                      </div>
                    </div>
                    <div className="divider"></div>
                    <div
                      className="connect-wallet-item"
                      onClick={() => {
                        setSelectedLedgerPath('legacy');
                      }}
                    >
                      <div className="connect-wallet-item__info">
                        <div className="heading heading--emphasized">Legacy</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div
                ref={addressesRef}
                className="dropdown dropdown--outline"
                onClick={() => setAddressesDropdownActive(!addressesDropdownActive)}
                style={{ marginTop: '0.75rem' }}
              >
                <div className="connect-wallet-item__info">
                  <div className="heading heading--emphasized">
                    {selectedAddress === undefined ? 'Select Address' : getShortAddress(selectedAddress[1])}
                  </div>
                </div>
                {addressesDropdownActive && !!ledgerAddresses && (
                  <div className="dropdown__content">
                    {(selectedLedgerPath === 'live'
                      ? ledgerAddresses.liveAddresses
                      : ledgerAddresses.legacyAddresses
                    ).map((addressTuple, index) => {
                      return (
                        <>
                          {index !== 0 && <div className="divider"></div>}
                          <div
                            className="connect-wallet-item"
                            onClick={() => {
                              setSelectedAddress(addressTuple);
                            }}
                            key={addressTuple[1]}
                          >
                            <div className="connect-wallet-item__info">
                              <div className="heading heading--emphasized">{getShortAddress(addressTuple[1])}</div>
                            </div>
                          </div>
                        </>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <div className="modal__content__action-row">
              <button
                className="button button--x-large button--supply"
                disabled={selectedAddress === undefined}
                onClick={() => {
                  if (selectedAddress !== undefined) {
                    onSelectConnector([ConnectorType.Ledger, selectedAddress]);
                    onClose();
                  }
                }}
              >
                Select
              </button>
            </div>
            {terms}
          </div>
        </div>
      );
    }
  }
};

export default ConnectWalletModal;

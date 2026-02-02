import { ReactNode, useContext, useState } from 'react';
import { NavLink } from 'react-router-dom';

import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import { getShortAddress } from '@helpers/address';
import { filterMap } from '@helpers/functions';
import { isV2Market } from '@helpers/markets';
import { COMPOUND_URL, getBlockExplorerUrlForTransaction, TALLY_GOV_URL, V2_URL } from '@helpers/urls';
import useDisableScroll from '@hooks/useDisableScroll';
import { RECENT_NUM, useTransactionHistory } from '@hooks/useTransactionHistory';
import { Transaction, PendingTransaction, StateType, TransactionHistoryItem, TransactionState } from '@types';

import Hamburger from './Hamburger';
import { HeaderNavButtonHighlight } from './HeaderNavButtonHighlight';
import { Dashboard, Extensions, ExternalLink, Markets, Vote } from './Icons';
import { LoadSpinnerNew } from './LoadSpinner';
import Logo, { Mark } from './Logo';
import MarketSelector from './MarketSelector';
import RewardsButton from './RewardsButton';
import { SimpleLink } from './SimpleLink';
import WalletButton, { TRX_HISTORY_ROUTE } from './WalletButton';
import { WalletTrxHistoryLoadingRow, WalletTrxHistoryRow } from './WalletTrxHistory';

export type HeaderProps = {
  web3: Web3;
  transactions: Transaction[];
  clearTransactions: () => void;
  onConnectWalletClick: () => void;
  onWalletDisconnect: () => void;
};

const Header = ({ web3, transactions, clearTransactions, onConnectWalletClick, onWalletDisconnect }: HeaderProps) => {
  const [mobileNavActive, setMobileNavActive] = useState(false);
  const [mobileWalletActive, setMobileWalletActive] = useState(false);
  const { selectedMarket } = useContext(getSelectedMarketContext());
  const [, currentMarket] = selectedMarket;

  const pendingTransactions = filterMap<Transaction, PendingTransaction>(transactions, (tx) =>
    tx.state === TransactionState.Pending ? tx : undefined
  );

  const hideMarketSelector = ['/vote', '/markets'].some((path) => window.location.pathname.includes(path));

  const { state } = useTransactionHistory(web3, RECENT_NUM);
  const [transactionsStateType, transactionsState] = state;

  type trxHistoryItemOrNone = TransactionHistoryItem | undefined;
  const validTrxDataItems: trxHistoryItemOrNone[] = (transactionsState?.items || []).slice(0, 3);

  const recentTrxHistoryRows = validTrxDataItems;
  if (transactionsStateType === StateType.Loading) {
    for (let i = validTrxDataItems.length; i < 3; i++) {
      recentTrxHistoryRows.push(undefined);
    }
  }

  return (
    <header className="header">
      <div className="container">
        <div className="header__content">
          <div className="header__content__left header__links">
            <SimpleLink to={COMPOUND_URL}>
              <Logo className="mobile-hide" />
              <Mark className={`mobile-only${mobileNavActive || mobileWalletActive ? ' logo--mark--active' : ''}`} />
            </SimpleLink>
            <HeaderNavButtonHighlight>
              <SimpleLink to={'/'} className={({ isActive }) => (isActive ? 'active' : undefined)}>
                <Dashboard className="header__links__icon" />
                {/* This is an unfortunate technical limitation since we fetch the bounding box/dimensions
                of the link button upon page load, when its width may not have been fully calculated yet
                So explicitly set the width for now */}
                <span style={{ width: '4.25rem' }} className="L1 label">
                  Dashboard
                </span>
              </SimpleLink>
              <NavLink to="/markets" className={({ isActive }) => (isActive ? 'active' : undefined)}>
                <Markets className="header__links__icon" />
                {/* This is an unfortunate technical limitation since we fetch the bounding box/dimensions
                of the link button upon page load, when its width may not have been fully calculated yet
                So explicitly set the width for now */}
                <span style={{ width: '3.125rem' }} className="L1 label">
                  Markets
                </span>
              </NavLink>
              <SimpleLink to="/extensions" className={({ isActive }) => (isActive ? 'active' : undefined)}>
                <Extensions className="header__links__icon" />
                <span style={{ width: '4.25rem' }} className="L1 label">
                  Extensions
                </span>
              </SimpleLink>
              <SimpleLink to={TALLY_GOV_URL}>
                <Vote className="header__links__icon" />
                <span style={{ width: '1.75rem' }} className="L1 label">
                  Vote
                </span>
              </SimpleLink>
            </HeaderNavButtonHighlight>
          </div>
          <div className="header__content__right">
            <div className="header__buttons">
              {!hideMarketSelector && <MarketSelector />}
              <RewardsButton web3={web3} />
              <WalletButton
                transactions={transactions}
                clearTransactions={clearTransactions}
                web3={web3}
                onOpenWalletSelectionModal={onConnectWalletClick}
                onClickDisconnect={onWalletDisconnect}
              />
              <div
                className={`button button--circle button--connect-wallet--mobile mobile-only${
                  mobileWalletActive ? ' button--circle--active' : ''
                }`}
                onClick={() => {
                  if (web3.write.account) {
                    setMobileWalletActive(!mobileWalletActive);
                  } else {
                    onConnectWalletClick();
                  }
                }}
              >
                {/* TODO (mykelp) --> Still want to refactor this...starting to get real state-y */}
                <svg width="44" height="44" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <mask
                    id="mask0_1_1247"
                    style={{ maskType: 'alpha' }}
                    maskUnits="userSpaceOnUse"
                    x="0"
                    y="0"
                    width="44"
                    height="44"
                  >
                    <path
                      fillRule="evenodd"
                      clipRule="evenodd"
                      d="M42.1392 30.8688C43.3357 28.1559 44 25.1555 44 22C44 9.84974 34.1503 0 22 0C9.84974 0 0 9.84974 0 22C0 34.1503 9.84974 44 22 44C25.1555 44 28.1559 43.3357 30.8688 42.1392C29.7024 40.7491 29 38.9566 29 37C29 32.5817 32.5817 29 37 29C38.9566 29 40.7491 29.7024 42.1392 30.8688Z"
                      fill="var(--button--neutral)"
                    />
                  </mask>
                  <g mask={mobileWalletActive ? undefined : 'url(#mask0_1_1247)'}>
                    <rect
                      width="44"
                      height="44"
                      rx="22"
                      fill={
                        !mobileWalletActive && transactions.length > 0
                          ? 'var(--button--supply--emphasized)'
                          : 'var(--button--neutral)'
                      }
                    />
                    {!mobileWalletActive && transactions.length === 0 && (
                      <path
                        fillRule="evenodd"
                        clipRule="evenodd"
                        d="M15.3333 18C15.3333 16.8954 16.2288 16 17.3333 16H26C26.7364 16 27.3333 16.597 27.3333 17.3333H17.3333C16.9651 17.3333 16.6667 17.6318 16.6667 18C16.6667 18.3682 16.9651 18.6667 17.3333 18.6667H26.6667C27.7712 18.6667 28.6667 19.5621 28.6667 20.6667V24.6667C28.6667 25.7712 27.7712 26.6667 26.6667 26.6667H17.3333C16.2288 26.6667 15.3333 25.7712 15.3333 24.6667V18ZM26.6667 23.3333C27.0349 23.3333 27.3333 23.0349 27.3333 22.6667C27.3333 22.2985 27.0349 22 26.6667 22C26.2985 22 26 22.2985 26 22.6667C26 23.0349 26.2985 23.3333 26.6667 23.3333Z"
                        fill="var(--icon--1)"
                      />
                    )}
                  </g>
                  {!mobileWalletActive && (
                    <g style={{ position: 'relative' }}>
                      <circle
                        cx="37"
                        cy="37"
                        r="5"
                        fill={
                          transactions.length > 0
                            ? 'var(--button--supply--deemphasized)'
                            : web3.write.account
                            ? 'var(--icon--supply)'
                            : 'var(--icon--2)'
                        }
                      />
                      {transactions.length > 0 && <LoadSpinnerNew x="32" y="32" height="10" width="10" />}
                    </g>
                  )}
                </svg>
                {mobileWalletActive && <Hamburger />}
                {!mobileWalletActive && transactions.length > 0 && (
                  <label className="L1 label text-color--1">{transactions.length}</label>
                )}
              </div>
              <div
                className={`button button--circle mobile-only${mobileNavActive ? ' button--circle--active' : ''}`}
                onClick={() => {
                  setMobileNavActive(!mobileNavActive);
                }}
              >
                <Hamburger />
              </div>
            </div>
          </div>
        </div>
      </div>
      <HeaderMobileOverlay active={mobileWalletActive}>
        <div className="header__wallet-menu L1">
          <div className="header__wallet-menu__connected-wallet">
            <label className="label L2 text-color--2">Connected Wallet</label>
            <h1 className="heading heading--emphasized text-color--1">{getShortAddress(web3.read.account || '')}</h1>
          </div>
          {pendingTransactions.length > 0 && (
            <div className="header__wallet-menu__transactions">
              <div className="header__wallet-menu__transactions__row">
                <label className="label L2 text-color--2">Pending</label>
                <label className="label L2 text-color--supply" onClick={clearTransactions}>
                  Clear
                </label>
              </div>
              {pendingTransactions.map((trx) => {
                return (
                  <a
                    className="header__wallet-menu__transactions__row"
                    key={trx.id}
                    href={getBlockExplorerUrlForTransaction(trx)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <h4 className="L4 heading heading--emphasized text-color--1">{trx.description}</h4>
                    <ExternalLink className="external-link svg--icon--2" />
                  </a>
                );
              })}
            </div>
          )}
          {recentTrxHistoryRows.length > 0 && (
            <div className="header__wallet-menu__trx-history">
              <div className="header__wallet-menu__trx-history__header-row">
                <label className="label L2 text-color--2">Recent Transactions</label>
                <SimpleLink to={TRX_HISTORY_ROUTE} onClick={() => setMobileWalletActive(false)}>
                  <label className="label L2 text-color--supply">See All</label>
                </SimpleLink>
              </div>
              {recentTrxHistoryRows.map((trxHistoryItem, index) => {
                if (trxHistoryItem) {
                  return (
                    <WalletTrxHistoryRow
                      connectedAccount={web3.write.account}
                      trxHistoryItem={trxHistoryItem}
                      key={index}
                    />
                  );
                } else {
                  return <WalletTrxHistoryLoadingRow key={index} />;
                }
              })}
            </div>
          )}

          <div className="header__wallet-menu__buttons">
            <label className="label L2 text-color--2 header__wallet-menu__buttons__label">COMP Distribution</label>
            <RewardsButton
              mobile
              web3={web3}
              onClaimClicked={() => {
                setMobileWalletActive(false);
              }}
            />
            <div className="header__wallet-menu__buttons__wrapper">
              <button
                className="button button--x-large"
                onClick={() => {
                  onWalletDisconnect();
                  setMobileWalletActive(false);
                }}
              >
                Disconnect
              </button>
              <button className="button button--x-large" onClick={onConnectWalletClick}>
                Change Wallet
              </button>
            </div>
          </div>
        </div>
      </HeaderMobileOverlay>
      <HeaderMobileOverlay active={mobileNavActive}>
        <div className="header__links--mobile L1">
          <SimpleLink
            to={!!currentMarket && isV2Market(currentMarket) ? V2_URL : '/'}
            className={({ isActive }) =>
              isActive ? 'heading heading--emphasized active' : 'heading heading--emphasized'
            }
            onClick={() => {
              setMobileNavActive(false);
            }}
          >
            Dashboard
          </SimpleLink>
          <SimpleLink
            to="/markets"
            className={({ isActive }) =>
              isActive ? 'heading heading--emphasized active' : 'heading heading--emphasized'
            }
            onClick={() => {
              setMobileNavActive(false);
            }}
          >
            Markets
          </SimpleLink>
          <SimpleLink
            to="/extensions"
            className={({ isActive }) =>
              isActive ? 'heading heading--emphasized active' : 'heading heading--emphasized'
            }
            onClick={() => {
              setMobileNavActive(false);
            }}
          >
            Extensions
          </SimpleLink>
          <SimpleLink
            to="/vote"
            className={({ isActive }) =>
              isActive ? 'heading heading--emphasized active' : 'heading heading--emphasized'
            }
            onClick={() => {
              setMobileNavActive(false);
            }}
          >
            Vote
          </SimpleLink>
        </div>
      </HeaderMobileOverlay>
    </header>
  );
};

export default Header;

type HeaderMobileOverlayProps = {
  active: boolean;
  children: ReactNode;
};

const HeaderMobileOverlay = ({ active, children }: HeaderMobileOverlayProps) => {
  useDisableScroll(active);

  return <div className={`header__mobile-overlay${active ? ' header__mobile-overlay--active' : ''}`}>{children}</div>;
};

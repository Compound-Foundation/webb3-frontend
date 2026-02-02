import React, { ReactElement, ChangeEvent, useState, useEffect } from 'react';

import { ArrowLeft, ArrowRight, CircleClose, ExternalLink, Wallet, CheckMark } from '@components/Icons';
import { getShortAddress } from '@helpers/address';
import { convertApiResponse, isValidAddress, checkImageURL } from '@helpers/functions';
import {
  getGovernanceUrlForChain,
  getBlockExplorerUrlForTransaction,
  TALLY_URL,
  getTallyProfileForChain,
} from '@helpers/urls';
import {
  CompAccount,
  DelegateTypeEnum,
  DisplayAccount,
  PendingTransaction,
  StateType,
  Transaction,
  TransactionState,
} from '@types';

type DelegateModalNoAccount = [StateType.NoWallet];
type DelegateModalHydrated = [
  StateType.Hydrated,
  {
    active: boolean;
    chainId: number;
    chainKey: string;
    compAccount: CompAccount;
    transaction: Transaction | undefined;
    startScreen: DelegateModalScreenEnum;
    voteNumberString: string;
    voteDecimalString: string;
    onRequestClose: () => void;
    onDelegateTransaction: (delegatee: string) => void;
  }
];

export type DelegateModalState = DelegateModalHydrated | DelegateModalNoAccount;

interface DelegateModalProps {
  state: DelegateModalState;
}

export enum DelegateModalScreenEnum {
  ChooseType,
  DelegateVotes,
  ConfirmTransaction,
  PendingTransaction,
}

// returns COMP account details by voting weight
const getLeaderboardAccounts = async (chainKey: string) => {
  const response = await fetch(`${getGovernanceUrlForChain(chainKey)}/comp/accounts?page_size=3`);
  if (!response.ok) {
    throw new Error(`Error fetching voting account info: ${response.status}`);
  }
  const result = await response.json();
  return result.accounts;
};

// returns Governance history w/ overall delegates and votes delegated
const getGovernanceHistory = async (chainKey: string) => {
  const response = await fetch(`${getGovernanceUrlForChain(chainKey)}/comp/history`);
  if (!response.ok) {
    throw new Error(`Error governance history: ${response.status}`);
  }
  const result = await response.json();
  return result;
};

const DelegateModal = ({ state }: DelegateModalProps) => {
  const [, data] = state;
  if (!data) {
    return null;
  }

  const {
    active,
    chainId,
    chainKey,
    compAccount,
    transaction,
    startScreen,
    voteNumberString,
    voteDecimalString,
    onRequestClose,
    onDelegateTransaction,
  } = data;
  if (!active) return null;

  const [screen, setScreen] = useState(startScreen);
  const [delegatee, setDelegatee] = useState('');
  const [isValid, setIsValid] = useState<boolean | null>(null);
  const [knownDelegate, setKnownDelegate] = useState<DisplayAccount>();
  const [suggestedDelegates, setSuggestedDelegates] = useState<DisplayAccount[]>([]);
  const [isFocused, setFocused] = useState(false);
  const [totalVotes, setTotalVotes] = useState<number>();

  // fetch top three on leaderboard + total delegated votes
  useEffect(() => {
    (async () => {
      // eslint-disable-next-line prefer-const
      let [suggested, governanceHistory] = await Promise.all([
        getLeaderboardAccounts(chainKey),
        getGovernanceHistory(chainKey),
      ]);

      if (suggested) {
        suggested = suggested.map((delegate: DisplayAccount) => convertApiResponse<DisplayAccount>(delegate));
        const { votesDelegated } = convertApiResponse(governanceHistory);
        setSuggestedDelegates(suggested);
        setTotalVotes(Number(votesDelegated));
      }
    })();
  }, []);

  // listen for transaction confirmation
  useEffect(() => {
    setScreen(startScreen);
  }, [transaction, startScreen]);

  let title = '';
  let content: ReactElement = <></>;

  const onModalClose = () => {
    onRequestClose();
    setDelegatee('');
    setIsValid(false);
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    setDelegatee(e.target.value);
    setKnownDelegate(undefined);
    setIsValid(null);
  };

  const onSelectDelegatee = (e: React.MouseEvent<HTMLDivElement>, delegate: DisplayAccount) => {
    // TODO(alex) --> we might want to actually remove any potentially invalid address
    // from the suggested delegate list before displaying
    // for now, we assume the results returned from API are valid
    setDelegatee(delegate.address);
    setIsValid(isValidAddress(delegate.address));
    setKnownDelegate(delegate);
    setFocused(false);
  };

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.relatedTarget || e.relatedTarget?.tagName !== 'A') {
      setIsValid(isValidAddress(delegatee));
      setFocused(false);
    }
  };

  const DelegateDetails = ({
    delegate,
    voteWeight,
    totalVotes,
  }: {
    delegate: DisplayAccount;
    voteWeight: number;
    totalVotes?: number;
  }) => {
    const { address, imageUrl, displayName } = delegate;
    const [profileImage, setProfileImage] = useState('');
    const displayAddress = getShortAddress(address);

    const calculatedWeight = totalVotes && ((voteWeight / totalVotes) * 100).toFixed(2);

    if (imageUrl) {
      checkImageURL(imageUrl).then(() => {
        setProfileImage(imageUrl);
      });
    }
    return (
      <div className="gov-profile icon-text-pair" onMouseDown={(e) => onSelectDelegatee(e, delegate)}>
        <div className="gov-profile__image">
          {profileImage ? (
            <img src={profileImage} className="gov-profile__image gov-profile__image__raw-image" />
          ) : (
            <span className="gov-profile__image gov-profile__image__svg"></span>
          )}
        </div>
        <div className="gov-profile__display-name">
          <span className="body L4">{displayName ? displayName : displayAddress}</span>
          {calculatedWeight && <div className="meta text-color--3">Voting Weight: {calculatedWeight}%</div>}
        </div>
      </div>
    );
  };

  if (screen === DelegateModalScreenEnum.ChooseType) {
    title = 'Choose Delegation Type';
    content = (
      <div className="delegate-modal-content">
        <div
          className="delegate-modal-row"
          onClick={() => {
            setScreen(DelegateModalScreenEnum.ConfirmTransaction);
            onDelegateTransaction(compAccount.address);
          }}
        >
          <span className="delegate-modal-row__icon-holder">
            <CheckMark className="delegate-modal-row__icon-holder__icon" color="var(--ui--foreground--2)" />
          </span>
          <div className="delegate-modal-row__info L4">
            <div className="delegate-modal-row__title">
              <span className="heading heading--emphasized">Manual Voting</span>
              {compAccount.delegateType === DelegateTypeEnum.Self && <div className="L3 meta status">active</div>}
            </div>
            <div className="delegate-modal-row__description meta">
              This option allows you to vote on proposals directly from your connected wallet.
            </div>
          </div>
        </div>
        <div
          className="delegate-modal-row"
          onClick={() => {
            setScreen(DelegateModalScreenEnum.DelegateVotes);
          }}
        >
          <span className="delegate-modal-row__icon-holder">
            <ArrowRight className="delegate-modal-row__icon-holder__icon" color="var(--ui--foreground--2)" />
          </span>
          <div className="delegate-modal-row__info L4">
            <div className="delegate-modal-row__title">
              <span className="heading heading--emphasized">Delegate Voting</span>
              {compAccount.delegateType === DelegateTypeEnum.Delegated && <div className="L3 meta status">active</div>}
            </div>
            <div className="delegate-modal-row__description meta">
              This options allows you to delegate your votes to another Ethereum address. You never send COMP, only your
              voting rights, and can undelegate at any time.
            </div>
          </div>
        </div>
      </div>
    );
  } else if (screen === DelegateModalScreenEnum.DelegateVotes) {
    title = 'Select an Address';
    content = (
      <div className="delgate-modal-content delegate-modal-content--delegate">
        <div className="delegate-modal-content__body body">
          If you know the address you wish to delegate to, enter it below. If not, you can view the
          <a className="link leaderboard-link" target="_blank" href={`${TALLY_URL}/gov/compound/delegates`}>
            {' '}
            Delegate Leaderboard
          </a>{' '}
          to find a political party you wish to support.
        </div>
        <div className="delegate-modal-content__input">
          <div className="text-input-view">
            <input
              className="text-input-view__input L4 body"
              placeholder="Enter a 0x address"
              value={delegatee}
              autoComplete="off"
              onFocus={() => setFocused(true)}
              onChange={onInputChange}
              onBlur={(e) => handleBlur(e)}
            />
            <label className="text-input-view__label L4 meta">Delegate Address</label>
            {suggestedDelegates.length > 0 && (
              <div className={`text-input-view__dropdown ${!isFocused && 'hidden'}`}>
                {suggestedDelegates.map((delegate, key) => (
                  <div key={`suggested-delegate-${key}`} className="text-input-view__dropdown__item">
                    <DelegateDetails
                      delegate={delegate}
                      voteWeight={Number(delegate.voteWeight)}
                      totalVotes={totalVotes}
                    />
                    <a target="_blank" href={getTallyProfileForChain(chainId, delegate.address)}>
                      <ExternalLink className="svg svg--icon--2" />
                    </a>
                  </div>
                ))}
              </div>
            )}
            <div className="text-input-view__help-text">
              {delegatee && isValid !== null && (
                <p
                  className={`L3 meta text-input-view__help-text text-input-view__help-text--${
                    isValid ? 'valid' : 'invalid'
                  }`}
                >
                  {knownDelegate ? (
                    <>
                      {knownDelegate.displayName ? knownDelegate.displayName : getShortAddress(delegatee)}
                      <span className="L4 meta text-input-view__help-text__description">•</span>
                      {totalVotes && (
                        <span className="L4 meta text-input-view__help-text__description">
                          Voting Weight: {((Number(knownDelegate.votes) / totalVotes) * 100).toFixed(2)}%
                        </span>
                      )}
                    </>
                  ) : isValid ? (
                    'Valid Address'
                  ) : (
                    'Invalid Address'
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
        <button
          className="button button--x-large button--supply"
          disabled={!isValid}
          onClick={() => {
            setScreen(DelegateModalScreenEnum.ConfirmTransaction);
            onDelegateTransaction(delegatee);
          }}
        >
          Delegate Votes
        </button>
      </div>
    );
  } else if (screen === DelegateModalScreenEnum.ConfirmTransaction) {
    title = 'Confirm Transaction';

    content = (
      <div className="vote-transaction-modal">
        <div className="loading-icon-holder">
          <div className="container">
            <div className="halfclip">
              <div className="halfcircle clipped"></div>
            </div>
            <div className="halfcircle fixed"></div>
          </div>
          <Wallet className="svg--icon--1 svg--wallet" />
        </div>
        <div className="vote-transaction-modal__block">
          <h4 className="heading heading--emphasized L4">
            {voteNumberString}.{voteDecimalString} Votes
          </h4>
          {delegatee ? (
            <p className="L4 meta vote-transaction-modal__block__description">
              Delegating to: {getShortAddress(delegatee)}
            </p>
          ) : (
            <p className="L4 meta vote-transaction-modal__block__description">
              Manual Voting from: {getShortAddress(compAccount.address)}
            </p>
          )}
        </div>
      </div>
    );
  } else if (transaction !== undefined && transaction.state === TransactionState.Pending) {
    title = 'Transaction Confirmed';
    content = (
      <div className="vote-transaction-modal">
        <div className="vote-transaction-modal__content">
          <div className="vote-transaction-modal__icon-holder">
            <Wallet className="svg--icon--1" />
            <div className="overlay-icon">
              <CheckMark className="svg" color="var(--ui--foreground--2)" />
            </div>
          </div>
          <div className="L4 body">
            <p>Your transaction has been confirmed.</p>
            <p>You may close this dialog.</p>
          </div>
        </div>
        <a
          className="link"
          href={getBlockExplorerUrlForTransaction(transaction as PendingTransaction)}
          target="_blank"
          rel="noreferrer"
        >
          <button className="button button--x-large">View on Explorer</button>
        </a>
      </div>
    );
  }

  return (
    <div className="modal modal--active">
      <div className="modal__backdrop" onClick={onModalClose}></div>
      <div className="modal__content delegate-modal L4">
        <div className="modal__content__header">
          <div
            className="modal__content__header__left"
            onClick={() => {
              setScreen(DelegateModalScreenEnum.ChooseType);
              setDelegatee('');
            }}
          >
            {screen === DelegateModalScreenEnum.DelegateVotes && <ArrowLeft className="svg--icon--3" />}
          </div>
          <h4 className="heading heading--emphasized heading">{title}</h4>
          <div className="modal__content__header__right" onClick={onModalClose}>
            <CircleClose />
          </div>
        </div>
        {content}
      </div>
    </div>
  );
};

export default DelegateModal;

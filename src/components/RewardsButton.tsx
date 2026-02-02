import { useState, useRef, useContext, useEffect, MouseEventHandler } from 'react';
import { useLocation } from 'react-router-dom';

import { getActionQueueContext } from '@contexts/ActionQueueContext';
import RewardsStateContext from '@contexts/RewardsStateContext';
import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import { iconNameForChainId } from '@helpers/assets';
import { filterMap } from '@helpers/functions';
import { formatTokenBalance } from '@helpers/numbers';
import useOnClickOutside from '@hooks/useOnClickOutside';
import { AccountRewardsState, ActionType, ChainInformation, StateType } from '@types';

import DetailSheet from './DetailSheet';
import IconPair from './IconPair';
import { CaretDown } from './Icons';
import { SimpleLink } from './SimpleLink';

export type RewardsButtonProps = {
  web3: Web3;
  mobile?: boolean;
  onClaimClicked?: () => void;
};

type ExpandedState = {
  [chainId: string]: boolean;
};

const RewardsButton = ({ web3, mobile = false, onClaimClicked = () => undefined }: RewardsButtonProps) => {
  const { addOrUpdateAction, queueActions } = useContext(getActionQueueContext());
  const { selectedMarket, selectMarketByAddress } = useContext(getSelectedMarketContext());
  const state = useContext(RewardsStateContext);
  const [rewardsState] = state;
  const [dropdownActive, setDropdownActive] = useState(false);
  const [expandedState, setExpandedState] = useState<ExpandedState>({});
  const ref = useRef(null);
  useOnClickOutside(ref, () => setDropdownActive(false));

  useEffect(() => {
    if (rewardsState === StateType.Hydrated && state[1] !== undefined) {
      setExpandedState(
        state[1].reduce(
          (accum, [chainId]) => ({
            ...accum,
            [chainId]: web3.read.chainId?.toString() === chainId,
          }),
          {}
        )
      );
    }
  }, [rewardsState, web3.read.chainId, dropdownActive]);

  if (rewardsState === StateType.Hydrated && state[1] !== undefined) {
    const allRewards = state[1];
    const { totalRewards, totalUnclaimed } = allRewards.reduce(
      (accum, [, { rewardsStates }]) => {
        const unclaimed = rewardsStates.reduce((accum, { amountOwed }) => accum + amountOwed, 0n);
        const walletBalance = (rewardsStates[0] || {}).walletBalance || 0n;

        return {
          ...accum,
          totalRewards: accum.totalRewards + unclaimed + walletBalance,
          totalUnclaimed: accum.totalUnclaimed + unclaimed,
        };
      },
      {
        totalRewards: 0n,
        totalUnclaimed: 0n,
      }
    );
    const rewardAsset = allRewards[0][1].rewardsStates[0].rewardAsset;
    const [wholeNumberTotalRewards, fractionalTotalRewards] = `${formatTokenBalance(
      rewardAsset.decimals,
      totalRewards
    )}`.split('.');
    const [wholeNumberUnclaimed, fractionalUnclaimed] = `${formatTokenBalance(
      rewardAsset.decimals,
      totalUnclaimed
    )}`.split('.');

    const dropdownContent = (
      <>
        <label className="label L2 text-color--2">{`Total ${rewardAsset.symbol}`}</label>
        <div className="rewards__network-row__content__icons-with-info rewards__network-row__content__icons-with-info--big">
          <div className={`asset asset--${rewardAsset.symbol}`}></div>
          <h3 className="heading heading--emphasized L3 text-color--1">
            {wholeNumberTotalRewards}
            <span className="text-color--2">{`.${fractionalTotalRewards}`}</span>
          </h3>
        </div>
        {allRewards.map(([chainId, { chainInformation, rewardsStates }]) => (
          <RewardsNetworkRow
            key={chainId}
            chainInformation={chainInformation}
            expanded={expandedState[chainId] ?? false}
            rewardsStates={rewardsStates}
            onClaimClicked={(claimBalances: AccountRewardsState[]) => {
              if (
                selectedMarket[1] !== undefined &&
                chainId !== selectedMarket[1].chainInformation.chainId.toString()
              ) {
                queueActions(
                  claimBalances[0].comet,
                  claimBalances.map((rewardState) => [
                    ActionType.ClaimRewards,
                    rewardState.rewardAsset,
                    rewardState.amountOwed,
                    rewardState,
                  ])
                );

                selectMarketByAddress(Number(chainId), claimBalances[0].comet);
              } else {
                claimBalances.forEach((rewardState) => {
                  addOrUpdateAction([
                    ActionType.ClaimRewards,
                    rewardState.rewardAsset,
                    rewardState.amountOwed,
                    rewardState,
                  ]);
                });
              }

              onClaimClicked();
              setDropdownActive(false);
            }}
            onExpand={() => {
              const nextExpanded = !expandedState[chainId];
              const newState: ExpandedState = Object.entries(expandedState).reduce((accum, [_chainId]) => {
                return {
                  ...accum,
                  [_chainId]: _chainId === chainId ? nextExpanded : false,
                };
              }, {});
              setExpandedState(newState);
            }}
          />
        ))}
      </>
    );

    const onClickDropdown = () => {
      if (web3.write.account) {
        setDropdownActive(!dropdownActive);
      }
    };

    if (mobile) {
      return (
        <div className="header__wallet-menu__rewards" onClick={onClickDropdown}>
          <div className={`asset asset--${rewardAsset.symbol}`}></div>
          <div className="header__wallet-menu__rewards__info L1">
            <label className="label text-color--1">{`${wholeNumberTotalRewards}.${fractionalTotalRewards}`}</label>
            <label className="label label--secondary text-color--2">{`${wholeNumberUnclaimed}.${fractionalUnclaimed} Unclaimed`}</label>
          </div>
          <DetailSheet active={dropdownActive} className="header__wallet-menu__claim">
            {dropdownContent}
          </DetailSheet>
        </div>
      );
    }

    return (
      <div ref={ref} className={`header__pill-dropdown rewards-button mobile-hide L2`}>
        <div className="dropdown">
          <div className={`button button--rewards rewards`} onClick={onClickDropdown}>
            <span className={`asset asset--${rewardAsset.symbol} rewards__icon`} />
            <label className="label text-color--1">{`${wholeNumberTotalRewards}.${fractionalTotalRewards}`}</label>
          </div>
          {dropdownActive && <div className={`dropdown__content rewards__dropdown`}>{dropdownContent} </div>}
        </div>
      </div>
    );
  }

  return null;
};

type RewardsNetworkRowProps = {
  chainInformation: ChainInformation;
  expanded: boolean;
  rewardsStates: AccountRewardsState[];
  onClaimClicked: (balanceClaims: AccountRewardsState[]) => void;
  onExpand: () => void;
};

const RewardsNetworkRow = ({
  chainInformation,
  expanded,
  rewardsStates,
  onExpand,
  onClaimClicked,
}: RewardsNetworkRowProps) => {
  if (rewardsStates[0] == null) return null;
  const location = useLocation();
  const { walletBalance, rewardAsset } = rewardsStates[0];
  const balance = formatTokenBalance(rewardAsset.decimals, walletBalance);
  const [wholeNumberWalletBalance, fractionalWalletBalance] = `${balance}`.split('.');

  const unclaimedBalances = filterMap<AccountRewardsState, AccountRewardsState>(rewardsStates, (rewardState) =>
    rewardState.amountOwed > 0n ? rewardState : undefined
  );
  const totalUnclaimed = rewardsStates.reduce((accum, { amountOwed }) => accum + amountOwed, 0n);
  const formattedUnclaimed = formatTokenBalance(rewardAsset.decimals, totalUnclaimed);
  const [wholeNumberUnclaimed, fractionalUnclaimed] = `${formattedUnclaimed}`.split('.');

  const sumBalances = walletBalance + totalUnclaimed;
  const formattedSumBalances = formatTokenBalance(rewardAsset.decimals, sumBalances);

  const buttonText =
    unclaimedBalances.length > 1
      ? `Claim ${unclaimedBalances.length} Balances`
      : `Claim ${formattedUnclaimed} ${rewardAsset.symbol}`;

  const onClick: MouseEventHandler<HTMLButtonElement> = (e) => {
    e.stopPropagation();
    onClaimClicked(unclaimedBalances);
  };

  const claimButton =
    location.pathname === '/' ? (
      <button className={`button button--small`} onClick={onClick}>
        {buttonText}
      </button>
    ) : (
      <SimpleLink style={{ width: '100%' }} to="/">
        <button className={`button button--small`} onClick={onClick}>
          {buttonText}
        </button>
      </SimpleLink>
    );

  return (
    <>
      <div className="divider"></div>
      <div className={`rewards__network-row${expanded ? ' rewards__network-row--active' : ''}`}>
        <div
          className="rewards__network-row__content rewards__clickable"
          onClick={(e) => {
            onExpand();
            e.stopPropagation();
          }}
        >
          <div className="rewards__network-row__content__icons-with-info">
            <div className={`asset asset--${iconNameForChainId(chainInformation.chainId)}`}></div>
            <label className="label L1 text-color--1">{chainInformation.name}</label>
          </div>
          <div className="rewards__network-row__content__icons-with-info">
            <label className="rewards__network-row__content__icons-with-info__total label label--secondary L1 text-color--2">
              {formattedSumBalances}
            </label>
            <CaretDown className="chevron" />
          </div>
        </div>
        <div className="rewards__network-row__content--expandable">
          <div className="rewards__network-row__content">
            <label className="label L2 text-color--2">Wallet Balance</label>
            <label className="label L2 text-color--1">
              {wholeNumberWalletBalance}
              <span className="text-color--2">{`.${fractionalWalletBalance}`}</span>
            </label>
          </div>
          {unclaimedBalances.length > 0 && (
            <>
              <div className="rewards__network-row__content">
                <label className="label L2 text-color--2">Unclaimed Balances</label>
                <label className="label L2 text-color--1">
                  {wholeNumberUnclaimed}
                  <span className="text-color--2">{`.${fractionalUnclaimed}`}</span>
                </label>
              </div>
              {unclaimedBalances.map((rewardState) => {
                const amountOwed = formatTokenBalance(rewardState.rewardAsset.decimals, rewardState.amountOwed);
                const [wholeNumberUnclaimed, fractionalUnclaimed] = `${amountOwed}`.split('.');
                return (
                  <div
                    className="rewards__network-row__content rewards__network-row__content--unclaimed"
                    key={rewardState.comet}
                  >
                    <div className="rewards__network-row__content__icons-with-info rewards__network-row__content__icons-with-info--small">
                      <IconPair
                        icon1={rewardState.baseAsset.symbol}
                        icon2={iconNameForChainId(chainInformation.chainId)}
                      />
                      <label className="label L1 text-color--1">{rewardState.baseAsset.symbol}</label>
                    </div>
                    <label className="label L2 text-color--1">
                      {wholeNumberUnclaimed}
                      <span className="text-color--2">{`.${fractionalUnclaimed}`}</span>
                    </label>
                  </div>
                );
              })}
              {claimButton}
            </>
          )}
        </div>
      </div>
    </>
  );
};

export default RewardsButton;

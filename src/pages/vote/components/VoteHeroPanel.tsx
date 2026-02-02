import { ReactElement } from 'react';

import { CirclePlus } from '@components/Icons';
import Meter from '@components/Meter';
import Tooltip from '@components/Tooltip';
import { FACTOR_PRECISION, calculateRoundedUnit } from '@helpers/numbers';
import { V2_URL } from '@helpers/urls';
import { DelegateTypeEnum, StateType } from '@types';

type VoteHeroPanelLoading = [StateType.Loading];
type VoteHeroPanelNoAccount = [
  StateType.NoWallet,
  {
    label: string;
    value: [string, string];
  }
];

type VoteHeroPanelHydrated = [
  StateType.Hydrated,
  {
    label: string;
    value: [string, string];
    decimals: number;
    delegateType: DelegateTypeEnum;
    threshold: bigint;
    votes: bigint;
  }
];

export type VoteHeroPanelState = VoteHeroPanelLoading | VoteHeroPanelNoAccount | VoteHeroPanelHydrated;

type VoteHeroPanelProps = {
  state: VoteHeroPanelState;
};

const VoteHeroPanel = ({ state }: VoteHeroPanelProps) => {
  const [heroStateType, data] = state;

  if (heroStateType === StateType.Loading || !data) {
    return (
      <div className="hero-panel vote-hero-panel">
        <div>
          <label className="label vote-hero-panel__label">
            <span className="placeholder-content"></span>
          </label>
          <h1 className="heading heading--emphasized L0 text-color--1 vote-hero-panel__value">
            <span className="placeholder-content"></span>
          </h1>
        </div>
      </div>
    );
  }
  const { label, value } = data;
  let showWeight, isProposer, voteFill;
  let tooltipContent: ReactElement = <></>;

  if (heroStateType === StateType.Hydrated) {
    const hydratedData = data as {
      decimals: number;
      delegateType: DelegateTypeEnum;
      threshold: bigint;
      votes: bigint;
    };
    const { decimals, threshold, votes, delegateType } = hydratedData;
    showWeight = votes > 0 && delegateType !== DelegateTypeEnum.Delegated;

    const thresholdNumber = calculateRoundedUnit(FACTOR_PRECISION, threshold, 0);
    const votesNumber = calculateRoundedUnit(decimals, votes, 0);

    voteFill = (votesNumber / thresholdNumber) * 100;
    isProposer = votesNumber >= thresholdNumber;

    tooltipContent = (
      <div className="tooltip__content L4">
        <h4 className="tooltip__header body--emphasized">
          {votesNumber} <span className="text-color--2">/</span> {thresholdNumber}
        </h4>
        <dl className="tooltip__definition-list body">
          <p className="body">If you have over {thresholdNumber} votes, you are able to create a proposal.</p>
        </dl>
      </div>
    );
  }

  return (
    <div className="hero-panel vote-hero-panel">
      <div className={'vote-hero-panel__group L1'}>
        <label className="label vote-hero-panel__label">{label}</label>
        <div className="vote-hero-panel__value">
          <h1 className="heading heading--emphasized L0 text-color--1">
            <span>
              {value[0]}
              <span className="text-color--3">.{value[1]}</span>
            </span>
          </h1>
        </div>
      </div>
      {isProposer && (
        <div className="vote-hero-panel__action-buttons">
          <a href={`${V2_URL}/#propose`} target="_blank">
            <button className="button button--large button--supply button--selected">
              <CirclePlus className="svg--supply" />
              <label className="label">Create Proposal</label>
            </button>
          </a>
        </div>
      )}
      {showWeight && !isProposer && (
        <div className={'utilization-meter L2 utilization-meter--vote'}>
          <div className="utilization-meter__text utilization-meter__text--left meta">
            <Tooltip content={tooltipContent} width={270}>
              <div className="tooltip__text-trigger">Proposer Status</div>
            </Tooltip>
          </div>
          <Meter percentageFill={`${voteFill}%`} />
          <Tooltip content={tooltipContent} width={270}>
            <div className="utilization-meter__text utilization-meter__text--right meta utilization-meter__end tooltip__text-trigger">
              25K Votes
            </div>
          </Tooltip>
        </div>
      )}
    </div>
  );
};

export default VoteHeroPanel;

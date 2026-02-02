import { formatTokenBalance } from '@helpers/numbers';
import { CompAccount, DelegateTypeEnum, StateType } from '@types';

import DelegateProfile from './DelegateProfile';

type VoteWalletLoading = [StateType.Loading];
type VoteWalletNoAccount = [StateType.NoWallet];

type VoteWalletHydrated = [
  StateType.Hydrated,
  {
    chainId: number;
    chainKey: string;
    compAccount: CompAccount;
    decimals: number;
    modalActive: boolean;
    onChangeDelegate: () => void;
  }
];

export type VoteWalletState = VoteWalletLoading | VoteWalletNoAccount | VoteWalletHydrated;

type VoteWalletProps = {
  state: VoteWalletState;
};

// since we don't know wallet type yet, we show all fields as loading rather than display headers
const LoadingWallet = () => {
  return (
    <div className="panel vote-panel vote-wallet L3">
      <div className="vote-panel__header-row">
        <label className="L2 label text-color--2">COMP Balance</label>
      </div>
      <div className="vote-wallet__row">
        <div className="vote-wallet__row icon-text-pair">
          <span className="asset">
            <span className="placeholder-content placeholder-content--circle"></span>
          </span>
          <span className="placeholder-content placeholder-content__balance"></span>
        </div>
      </div>
      <div className="vote-wallet__row">
        <div className="divider"></div>
      </div>
      <div className="vote-panel__header-row">
        <p className="placeholder-content placeholder-content__label"></p>
      </div>
      <div className="vote-wallet__row">
        <p className="placeholder-content placeholder-content__body"></p>
      </div>
    </div>
  );
};

const SetupVoting = ({
  connected,
  dimmed,
  onButtonClick,
}: {
  connected: boolean;
  dimmed: boolean;
  onButtonClick: () => void;
}) => (
  <div className="vote-wallet__row">
    <div className="vote-wallet__row__heading">
      <p className="body">Setup Voting</p>
    </div>
    <p className="L2 meta text-color--2 setup-voting">
      You can either vote on each proposal yourself or delegate your votes to a third party. Compound Governance puts
      you in charge of the future of Compound.{' '}
      <a
        className="setup-voting__link"
        href="https://medium.com/compound-finance/compound-governance-5531f524cf68"
        target="_blank"
      >
        Learn more.
      </a>
    </p>
    <div className="vote-wallet__row__button">
      {connected ? (
        <button disabled={dimmed} onClick={onButtonClick} className="button button--x-large button--supply">
          Get Started
        </button>
      ) : (
        <button disabled className="button button--x-large button--supply">
          Connect Wallet to Get Started
        </button>
      )}
    </div>
  </div>
);

const VoteWallet = ({ state }: VoteWalletProps) => {
  const [voteWalletStateType, data] = state;

  if (voteWalletStateType === StateType.NoWallet) {
    return (
      <div className="panel vote-panel vote-wallet L3">
        <div className="vote-panel__header-row">
          <label className="L2 label text-color--2">COMP Balance</label>
        </div>
        <div className="vote-wallet__row">
          <div className="vote-wallet__row icon-text-pair">
            <span className="asset asset--COMP"></span>
            <div className="heading heading--emphasized L3">
              0<span className="text-color--3">.00</span>
            </div>
          </div>
        </div>
        <div className="vote-wallet__row">
          <div className="divider"></div>
        </div>
        <SetupVoting dimmed={false} onButtonClick={() => console.log('connect wallet')} connected={false} />
      </div>
    );
  } else if (voteWalletStateType === StateType.Hydrated && data) {
    const account = data.compAccount;

    const { decimals, chainId, chainKey, modalActive, onChangeDelegate } = data;
    const { delegateType, balance, delegate } = account;

    const [balanceNumberString, balanceDecimalString] = formatTokenBalance(decimals, balance).split('.');

    const delegateProps = {
      delegateType,
      delegateAddress: delegate,
      chainId,
      chainKey,
      onChangeDelegate,
    };
    return (
      <div className="panel vote-panel vote-wallet L3">
        <div className="vote-panel__header-row">
          <label className="L2 label text-color--2">COMP Balance</label>
        </div>
        <div className="vote-wallet__row">
          <div className="vote-wallet__row icon-text-pair">
            <span className="asset asset--COMP"></span>
            <div className="heading heading--emphasized L3">
              {balanceNumberString}
              <span className="text-color--3">.{balanceDecimalString}</span>
            </div>
          </div>
        </div>
        <div className="vote-wallet__row">
          <div className="divider"></div>
        </div>
        {delegateType === DelegateTypeEnum.Undelegated && !account.votes ? (
          // if Undelegted AND no votes --> not a Voting account
          <SetupVoting dimmed={modalActive} onButtonClick={onChangeDelegate} connected={true} />
        ) : (
          <>
            <div className="vote-panel__header-row">
              <p className="L2 label text-color--2">Delegating to</p>
            </div>
            <div className="vote-wallet__row">
              <DelegateProfile {...delegateProps} />
            </div>
          </>
        )}
      </div>
    );
  }
  return <LoadingWallet />;
};

export default VoteWallet;

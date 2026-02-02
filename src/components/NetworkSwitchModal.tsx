import type { ReactNode } from 'react';

import { CHAINS } from '@constants/chains';
import { iconNameForChainId } from '@helpers/assets';

import { CircleClose } from './Icons';

type NetworkSwitchModalStateHydrated = {
  fromChainId: number;
  toChainId: number;
  description?: string;
  onRequestClose: () => void;
};

export type NetworkSwitchModalState = NetworkSwitchModalStateHydrated | undefined;

type NetworkSwitchModalProps = {
  state: NetworkSwitchModalState;
  onSwitchNetwork: () => void;
};

const NetworkSwitchModal = ({ state, onSwitchNetwork }: NetworkSwitchModalProps) => {
  let _onRequestClose: () => void;
  let modifier: string;
  let icons: ReactNode;
  let fromNetwork = '';
  let toNetwork = '';
  const description: string = state?.description || '';

  if (state === undefined) {
    _onRequestClose = () => undefined;
    modifier = '';
  } else {
    const { fromChainId, toChainId, onRequestClose } = state;
    _onRequestClose = onRequestClose;
    modifier = ' modal--active';
    fromNetwork = CHAINS[fromChainId]?.name;
    toNetwork = CHAINS[toChainId].name;

    icons = (
      <div className="modal__content__icons-holder">
        <div className={`asset asset--${fromNetwork ? iconNameForChainId(fromChainId) : 'TESTNET'}`} />
        <div className="modal__content__icons-holder__arrows"></div>
        <div className={`asset asset--${iconNameForChainId(toChainId)}`} />
      </div>
    );
  }

  return (
    <div className={`modal${modifier}`}>
      <div className="modal__backdrop" onClick={_onRequestClose}></div>
      <div className="modal__content L4">
        <div className="modal__content__header">
          <div className="modal__content__header__left"></div>
          <h4 className="heading heading--emphasized heading">Confirm Network Switch</h4>
          <div className="modal__content__header__right" onClick={_onRequestClose}>
            <CircleClose />
          </div>
        </div>
        {icons}
        <div className="modal__content__paragraph">
          <p className="body">
            Your wallet is currently connected to {fromNetwork ? `the ${fromNetwork}` : 'an unsupported'} network.
            Please switch your wallet over to {toNetwork} to {description ? description : 'complete the transaction'}.
          </p>
        </div>
        <div className="modal__content__action-row">
          <button className="button button--x-large" onClick={onSwitchNetwork}>
            Switch Network
          </button>
        </div>
      </div>
    </div>
  );
};

export default NetworkSwitchModal;

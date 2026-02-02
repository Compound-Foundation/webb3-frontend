import useDisableScroll from '@hooks/useDisableScroll';
import { ActionModalState, BulkerModalProps, BulkerApproveModalProps, ModalType, Transaction } from '@types';

import BulkerApproveModal from './BulkerApproveModal';
import BulkerModal from './BulkerModal';

export type ActionModalProps = {
  isBulkerAllowed: boolean;
  state: ActionModalState;
  transactions: Transaction[];
};

const ActionModal = ({ isBulkerAllowed, state, transactions }: ActionModalProps) => {
  useDisableScroll(state !== undefined);

  if (state === undefined) {
    return null;
  }

  const [modalType] = state;

  if (modalType === ModalType.BulkerApprove) {
    const bulkerApproveState: BulkerApproveModalProps = {
      ...state[1],
      isBulkerAllowed,
      transactions,
    };
    return <BulkerApproveModal {...bulkerApproveState} />;
  }
  const bulkerState: BulkerModalProps = {
    ...state[1],
    transactions,
  };
  return <BulkerModal {...bulkerState} />;
};

export default ActionModal;

import { ReactNode, useContext } from 'react';

import { CircleExclamation, CircleMinus, CirclePlus, Close } from '@components/Icons';
import { LoadSpinnerNew } from '@components/LoadSpinner';
import { isUnwrappedCollateralAsset, CHAINS } from '@constants/chains';
import { useCurrencyContext } from '@contexts/CurrencyContext';
import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import {
  ActionRules,
  displayTextForActionType,
  isSameAction,
  sanitizedAmountForAction,
  validateAddingAction,
  validateAllowanceForAction,
} from '@helpers/actions';
import { assetIconForAssetSymbol } from '@helpers/assets';
import { noop } from '@helpers/functions';
import {
  MAX_UINT256,
  PRICE_PRECISION,
  formatValue,
  shouldShowValueInBaseAsset,
  formatValueInDollars,
  getValueInDollars,
  getValueInBaseAsset,
  formatValueInCurrency,
  formatTokenBalance,
} from '@helpers/numbers';
import { ActionType, Action, BaseAssetWithAccountState, TokenWithAccountState, Currency, Transaction } from '@types';

export enum ActionQueueItemType {
  display = 'display',
  normal = 'normal',
}

type ActionQueueItemDisplayState = [
  ActionQueueItemType.display,
  {
    actionIndex: number;
    actions: Action[];
    approvalTransaction?: Transaction;
    baseAsset: BaseAssetWithAccountState;
    collateralAssets: TokenWithAccountState[];
    /** The rules the queue checks each action against, such as the wrapped route's. */
    actionRules?: ActionRules;
  }
];
type ActionQueueItemNormalState = [
  ActionQueueItemType.normal,
  {
    actionIndex: number;
    actions: Action[];
    baseAsset: BaseAssetWithAccountState;
    collateralAssets: TokenWithAccountState[];
    /** The rules the queue checks each action against, such as the wrapped route's. */
    actionRules?: ActionRules;
    onClick: () => void;
    onDeleteClick: () => void;
  }
];
export type ActionQueueItemState = ActionQueueItemDisplayState | ActionQueueItemNormalState;

type ActionQueueItemProps = {
  state: ActionQueueItemState;
};

const ActionQueueItem = ({ state }: ActionQueueItemProps) => {
  const { selectedMarket } = useContext(getSelectedMarketContext());
  const [type, { actionIndex, actions, baseAsset, collateralAssets, actionRules }] = state;
  const { symbol } = baseAsset;
  const action = actions[actionIndex];
  const [actionType, asset] = action;
  const { currency } = useCurrencyContext();
  // A maximum withdrawal on the wrapped route pays the full exit's cash: the position less the
  // wrapper's rounding buffer. The row shows that cash, and a spinner while it is not known.
  const isWrappedFullExit =
    actionRules?.wrappedBase !== undefined && actionType === ActionType.Withdraw && action[2] === MAX_UINT256;
  const fullExitCash = isWrappedFullExit ? actionRules?.wrappedBase?.fullExitCash : undefined;
  const sanitizedAmount =
    fullExitCash ?? sanitizedAmountForAction(baseAsset, collateralAssets, actions.slice(0, actionIndex), action);
  const isAmountUnknown = isWrappedFullExit && fullExitCash === undefined;
  const amount = formatValue(asset.decimals, sanitizedAmount);
  const earlierActions = actions.slice(0, actionIndex);
  const actionValid = validateAddingAction(baseAsset, collateralAssets, earlierActions, action, actionRules);
  const allowanceValid = validateAllowanceForAction(baseAsset, collateralAssets, earlierActions, action, actionRules);
  // A wrapper action that stopped before anything was sent says why, and can be submitted again. The
  // queue builds its entries afresh on every render, so the entry is matched by its type and token.
  const stopped = actionRules?.wrappedBase?.stopped;
  const stoppedLabel = stopped !== undefined && isSameAction(stopped.action, action) ? stopped.label : undefined;
  const error = allowanceValid !== 'ok' ? allowanceValid[1] : actionValid !== 'ok' ? actionValid[1] : stoppedLabel;

  const baseAssetDenominated = shouldShowValueInBaseAsset(symbol as Currency, currency);
  let currencyValue;
  if (isAmountUnknown) {
    currencyValue = null;
  } else if (actionType === ActionType.ClaimRewards) {
    currencyValue = formatTokenBalance(
      asset.decimals + PRICE_PRECISION,
      sanitizedAmount * asset.price,
      true,
      Currency.USD
    );
  } else if (baseAssetDenominated) {
    // for collateral value in base asset we need to consider the asset price when doing the conversion to USDC
    const valueToUse = getValueInBaseAsset(sanitizedAmount * asset.price, baseAsset);
    currencyValue = formatValueInCurrency(asset.decimals + PRICE_PRECISION, valueToUse, currency);
  } else {
    const valueToUse = getValueInDollars(sanitizedAmount * asset.price, baseAsset);
    currencyValue = formatValueInDollars(asset.decimals + PRICE_PRECISION, valueToUse);
  }

  const [modifier, onClick, onDeleteClick] =
    type === ActionQueueItemType.display
      ? ['action-queue-item--display', noop, noop]
      : ['L3', action[0] === ActionType.ClaimRewards ? noop : state[1].onClick, state[1].onDeleteClick];
  let icon = iconForActionType(actionType, error);
  const [, market] = selectedMarket;
  let actionTypeString = displayTextForActionType(actionType);
  if (market !== undefined) {
    const actionStringPreffix = isUnwrappedCollateralAsset(market.chainInformation, asset.address) ? 'Wrap & ' : '';
    actionTypeString = `${actionStringPreffix}${actionTypeString}`;
  }

  let subtext: ReactNode = null;

  if (type === ActionQueueItemType.display && state[1].approvalTransaction) {
    icon = (
      <div className={`svg${actionType === ActionType.Repay ? ' svg--borrow' : ''}`}>
        <LoadSpinnerNew />
      </div>
    );
    subtext = <p className="L4 meta text-color--2">Approval Pending</p>;
  } else if (error) {
    subtext = <p className="L4 meta text-color--caution">{error}</p>;
  } else if (actionType === ActionType.ClaimRewards) {
    subtext = (
      <p className="L4 meta text-color--2">{`${action[3].baseAsset.symbol} • ${CHAINS[action[3].chainId].name}`}</p>
    );
  }

  return (
    <div className={`action-queue-item ${modifier}`} onClick={onClick}>
      <div className="action-queue-item__info">
        <div className="action-queue-item__icon-holder">
          <span className={`asset asset--${assetIconForAssetSymbol(asset.symbol)}`}></span>
          {icon}
        </div>
        <div>
          <p className="body">{`${actionTypeString} ${asset.symbol}`}</p>
          {subtext}
        </div>
      </div>
      <div className="action-queue-item__balance">
        {isAmountUnknown ? <LoadSpinnerNew /> : <p className="body">{amount}</p>}
        <p className="L4 meta text-color--2">{currencyValue}</p>
      </div>
      <div
        className="action-queue-item__remove-button"
        onClick={(e) => {
          e.stopPropagation();
          onDeleteClick();
        }}
      >
        <Close className="svg--icon--1" />
      </div>
    </div>
  );
};

export function iconForActionType(actionType: ActionType, error?: string) {
  if (error !== undefined) {
    return <CircleExclamation className="svg--caution" />;
  }

  switch (actionType) {
    case ActionType.Borrow:
      return <CirclePlus className="svg--borrow" />;
    case ActionType.Repay:
      return <CircleMinus className="svg--borrow" />;
    case ActionType.Supply:
    case ActionType.SupplyCollateral:
      return <CirclePlus className="svg--supply" />;
    case ActionType.WithdrawCollateral:
    case ActionType.Withdraw:
      return <CircleMinus className="svg--supply" />;
    case ActionType.ClaimRewards:
      return <CirclePlus className="svg--claim" />;
  }
}

export default ActionQueueItem;

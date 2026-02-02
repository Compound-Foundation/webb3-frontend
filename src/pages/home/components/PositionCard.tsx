import { useContext, useState, ReactNode } from 'react';

import DetailSheet from '@components/DetailSheet';
import { ArrowDown, ArrowUp, CaretDown, Compare, HoverUnder } from '@components/Icons';
import Tooltip from '@components/Tooltip';
import NetRatesTooltip, { NetRatesTooltipView } from '@components/Tooltips/NetRatesTooltip';
import { useCurrencyContext } from '@contexts/CurrencyContext';
import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import {
  calculateUpdatedBalances,
  isSameAction,
  validateAddingAction,
  validateAllowanceForAction,
} from '@helpers/actions';
import { assetIconForAssetSymbol } from '@helpers/assets';
import { adjustValueForAeroAsset } from '@helpers/baseAssetPrice';
import { noop } from '@helpers/functions';
import {
  MAX_UINT256,
  PRICE_PRECISION,
  formatRateFactor,
  getLiquidationPoint,
  getRiskLevelAndPercentage,
  formatTokenBalance,
  getTokenValue,
} from '@helpers/numbers';
import { Theme } from '@hooks/useThemeManager';
import {
  Action,
  ActionType,
  BaseAssetWithAccountState,
  BaseAssetWithState,
  Currency,
  MarketData,
  PendingAction,
  StateType,
  Token,
  TokenWithAccountState,
  Transaction,
  TransactionState,
} from '@types';

import ActionInputView, { stringFromBigInt } from './ActionInputView';
import ActionQueueItem, { ActionQueueItemType, ActionQueueItemState } from './ActionQueueItem';

type PositionCardLoading = [StateType.Loading];
type PositionCardNoWallet = [
  StateType.NoWallet,
  {
    baseAsset: BaseAssetWithState;
    borrowAPR: bigint;
    borrowRewardsAPR?: bigint;
    earnAPR: bigint;
    earnRewardsAPR?: bigint;
    rewardsAsset?: Token;
    theme: Theme;
  }
];
type PositionCardHydrated = [
  StateType.Hydrated,
  {
    actions: Action[];
    approvalTransactions: Transaction[];
    baseAsset: BaseAssetWithAccountState;
    baseAssetPost: BaseAssetWithAccountState;
    borrowAPR: bigint;
    borrowRewardsAPR?: bigint;
    collateralAssets: TokenWithAccountState[];
    collateralValue: bigint;
    collateralValuePost: bigint;
    earnAPR: bigint;
    earnRewardsAPR?: bigint;
    liquidationCapacity: bigint;
    liquidationCapacityPost: bigint;
    pendingAction?: PendingAction;
    rewardsAsset?: Token;
    theme: Theme;
    transaction?: Transaction;
    onClearClicked: () => void;
    onCompareClicked: () => void;
    onDeleteAction: (action: Action) => void;
    onDripClicked?: () => void;
    onPendingActionCancel: () => void;
    onPendingActionConfirm: (amount: bigint) => void;
    onPendingActionUpdateAmount: (amount?: bigint) => void;
    onSelectAction: (action: Action) => void;
    onSubmitClicked: () => void;
  }
];

export type PositionCardState = PositionCardLoading | PositionCardNoWallet | PositionCardHydrated;

type PositionCardProps = {
  state: PositionCardState;
};

const PositionCard = ({ state }: PositionCardProps) => {
  const { selectedMarket } = useContext(getSelectedMarketContext());
  const [, market] = selectedMarket;
  const { currency } = useCurrencyContext();

  const {
    baseAssetSymbol,
    baseAssetWalletBalance,
    actionInputView,
    actionInputViewActive,
    actionQueueItems,
    additionalWalletBalance,
    additionalCollateralValue,
    additionalLiquidationPoint,
    additionalBorrowCapacity,
    additionalAvailableToBorrow,
    collateralValue,
    liquidationPoint,
    borrowCapacity,
    availableToBorrow,
    rates,
    onBaseAssetClicked,
  } = getContent(state, market as MarketData, currency);
  const itemClassName = 'body body--emphasized';

  return (
    <>
      <div
        className={`card-switcher card-switcher${
          actionInputViewActive ? '--input-view-active' : '--input-view-inactive'
        }`}
      >
        <div className="panel position-card position-card__wallet-balance L3">
          <div className="panel__header-row">
            <label className="L2 label text-color--2">{baseAssetSymbol} Wallet Balance</label>
          </div>
          <div className="position-card__row">
            <div className="position-card__row__info">
              <span
                className={`asset asset--${assetIconForAssetSymbol(baseAssetSymbol)}`}
                onClick={onBaseAssetClicked}
              ></span>
              <div>
                {baseAssetWalletBalance}
                {additionalWalletBalance}
              </div>
            </div>
          </div>
          {rates}
        </div>
        <div className="action-input-card">{actionInputView}</div>
        <DetailSheet active={actionInputViewActive} style={{ zIndex: '2000' }}>
          {actionInputView}
        </DetailSheet>
      </div>
      <div className="position-card__summary">
        <div className="panel position-card L3">
          {actionQueueItems}
          <div className="panel__header-row">
            <label className="L2 label text-color--2">Position Summary</label>
          </div>
          <div className="position-card__row">
            <div className="position-card__row__info">
              <p className="body">Collateral Value</p>
            </div>
            <div className="position-card__row__balance">
              <p className={itemClassName}>{collateralValue}</p>
              {additionalCollateralValue}
            </div>
          </div>
          <div className="position-card__row">
            <div className="position-card__row__info">
              <p className="body">Liquidation Point</p>
            </div>
            <div className="position-card__row__balance">
              <p className={itemClassName}>{liquidationPoint}</p>
              {additionalLiquidationPoint}
            </div>
          </div>
          <div className="position-card__row">
            <div className="position-card__row__info">
              <p className="body">Borrow Capacity</p>
            </div>
            <div className="position-card__row__balance">
              <p className={itemClassName}>{borrowCapacity}</p>
              {additionalBorrowCapacity}
            </div>
          </div>
          <div className="position-card__row">
            <div className="position-card__row__info">
              <p className="body">Available to Borrow</p>
            </div>
            <div className="position-card__row__balance">
              <p className={itemClassName}>{availableToBorrow}</p>
              {additionalAvailableToBorrow}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

type Content = {
  baseAssetSymbol: string;
  baseAssetWalletBalance: ReactNode;
  rates: ReactNode;
  actionInputView: ReactNode;
  actionInputViewActive: boolean;
  actionQueueItems: ReactNode;
  collateralValue: string | ReactNode;
  liquidationPoint: string | ReactNode;
  borrowCapacity: string | ReactNode;
  availableToBorrow: string | ReactNode;
  additionalWalletBalance: ReactNode;
  additionalCollateralValue: ReactNode;
  additionalLiquidationPoint: ReactNode;
  additionalBorrowCapacity: ReactNode;
  additionalAvailableToBorrow: ReactNode;
  onBaseAssetClicked: () => void;
};

function getContent(state: PositionCardState, market: MarketData, currency: Currency): Content {
  const [stateType] = state;
  const [ratesDetailActive, setRatesDetailActive] = useState(false);

  const defaultPanelState: Content = {
    baseAssetSymbol: 'USDC',
    baseAssetWalletBalance: <span className="placeholder-content" style={{ width: '70px' }}></span>,
    actionInputView: null,
    actionInputViewActive: false,
    actionQueueItems: null,
    collateralValue: <span className="placeholder-content" style={{ width: '70px' }}></span>,
    liquidationPoint: <span className="placeholder-content" style={{ width: '70px' }}></span>,
    borrowCapacity: <span className="placeholder-content" style={{ width: '70px' }}></span>,
    availableToBorrow: <span className="placeholder-content" style={{ width: '70px' }}></span>,
    additionalWalletBalance: null,
    additionalCollateralValue: null,
    additionalLiquidationPoint: null,
    additionalBorrowCapacity: null,
    additionalAvailableToBorrow: null,
    rates: null,
    onBaseAssetClicked: noop,
  };

  if (stateType === StateType.Loading) {
    return defaultPanelState;
  }

  const { borrowAPR, borrowRewardsAPR, earnAPR, earnRewardsAPR, rewardsAsset, theme } = state[1];

  const ratesTooltipContent = (
    <NetRatesTooltip
      borrowAPR={borrowAPR}
      borrowRewardsAPR={borrowRewardsAPR}
      earnAPR={earnAPR}
      earnRewardsAPR={earnRewardsAPR}
      rewardsAsset={rewardsAsset}
      view={NetRatesTooltipView.All}
    />
  );
  let rates: ReactNode = (
    <>
      <div className="position-card__row position-card__row--divider">
        <div className="divider"></div>
      </div>
      <Tooltip content={ratesTooltipContent} width={400} hideArrow={true}>
        <div className="position-card__rates" onClick={() => setRatesDetailActive(true)}>
          <div className="position-card__rates__info position-card__rates__info--left">
            <label className="L2 label text-color--2">Net Borrow APR</label>
            <p className="body body--emphasized">{formatRateFactor(borrowAPR - (borrowRewardsAPR || 0n))}</p>
            <HoverUnder className="hover-under" theme={theme} />
          </div>
          <div className="position-card__rates__info position-card__rates__info--right">
            <label className="L2 label text-color--2">Net Supply APR</label>
            <p className="body body--emphasized">{formatRateFactor(earnAPR + (earnRewardsAPR || 0n))}</p>
            <HoverUnder className="hover-under" theme={theme} />
          </div>
        </div>
      </Tooltip>
      <DetailSheet active={ratesDetailActive} onClickOutside={() => setRatesDetailActive(false)}>
        {ratesTooltipContent}
      </DetailSheet>
    </>
  );

  if (stateType === StateType.NoWallet) {
    const { baseAsset } = state[1];
    const { baseAssetPriceInDollars, symbol } = baseAsset;
    const formattedZeroValueForCurrency = formatTokenBalance(
      PRICE_PRECISION,
      getTokenValue(0n, currency, baseAssetPriceInDollars, symbol),
      true,
      currency
    );
    return {
      ...defaultPanelState,
      rates,
      baseAssetSymbol: baseAsset.symbol,
      baseAssetWalletBalance: <span className="text-color--2">0.0000</span>,
      collateralValue: <span className="text-color--2">{formattedZeroValueForCurrency}</span>,
      liquidationPoint: <span className="text-color--2">{formattedZeroValueForCurrency}</span>,
      borrowCapacity: <span className="text-color--2">{formattedZeroValueForCurrency}</span>,
      availableToBorrow: <span className="text-color--2">{formattedZeroValueForCurrency}</span>,
    };
  }

  const {
    actions,
    approvalTransactions,
    baseAsset,
    baseAssetPost,
    collateralAssets,
    collateralValue,
    collateralValuePost,
    liquidationCapacity,
    liquidationCapacityPost,
    pendingAction,
    transaction,
    onClearClicked,
    onCompareClicked,
    onDeleteAction,
    onDripClicked,
    onPendingActionCancel,
    onPendingActionConfirm,
    onPendingActionUpdateAmount,
    onSelectAction,
    onSubmitClicked,
  } = state[1];
  const { baseAssetPriceInDollars, symbol } = baseAsset;
  const borrowBalancePre: bigint = baseAsset.balance < 0n ? -baseAsset.balance : 0n;
  const borrowBalancePost: bigint = baseAssetPost.balance < 0n ? -baseAssetPost.balance : 0n;
  const [, percentagePre] = getRiskLevelAndPercentage(borrowBalancePre, liquidationCapacity);
  const [, percentagePost] = getRiskLevelAndPercentage(borrowBalancePost, liquidationCapacityPost);
  const liquidationPointPre = getLiquidationPoint(collateralValue, percentagePre);
  const liquidationPointPost = getLiquidationPoint(collateralValuePost, percentagePost);
  const availableToBorrowPre = baseAsset.borrowCapacity - borrowBalancePre;
  const availableToBorrowPost =
    baseAssetPost.borrowCapacity - borrowBalancePost < 0n ? 0n : baseAssetPost.borrowCapacity - borrowBalancePost;

  const [wholeNumberWalletBalance, fractionalWalletBalance] = formatTokenBalance(
    baseAsset.decimals,
    baseAssetPost.walletBalance
  ).split('.');
  const collateralValueDisplay = formatTokenBalance(
    PRICE_PRECISION,
    getTokenValue(collateralValuePost, currency, baseAssetPriceInDollars, symbol),
    false,
    currency
  );
  const liquidationPoint = formatTokenBalance(
    PRICE_PRECISION,
    getTokenValue(liquidationPointPost, currency, baseAssetPriceInDollars, symbol),
    false,
    currency
  );
  const tokenValue = getTokenValue(
    adjustValueForAeroAsset(baseAssetPost.borrowCapacity, symbol, baseAsset.price),
    currency,
    baseAssetPriceInDollars,
    symbol
  );
  const borrowCapacity = formatTokenBalance(baseAsset.decimals + PRICE_PRECISION, tokenValue, false, currency);
  // TODO: Refactor formatTokenBalance & getTokenValue
  const availableToBorrow = formatTokenBalance(
    baseAsset.decimals + PRICE_PRECISION,
    getTokenValue(baseAsset.price * availableToBorrowPost, currency, baseAssetPriceInDollars, symbol),
    false,
    currency
  );

  const borrowOrRepayAction = actions.find(
    (action) => action[0] === ActionType.Borrow || action[0] === ActionType.Repay
  );
  const actionColor = borrowOrRepayAction === undefined ? 'supply' : 'borrow';

  const [additionalWalletBalancesRaw, additionalWalletIcon] =
    baseAssetPost.walletBalance > baseAsset.walletBalance
      ? [
          baseAssetPost.walletBalance - baseAsset.walletBalance,
          <ArrowUp key="arrow" className={`svg--${actionColor}`} />,
        ]
      : [
          baseAsset.walletBalance - baseAssetPost.walletBalance,
          <ArrowDown key="arrow" className={`svg--${actionColor}`} />,
        ];

  // TODO: Refactor formatTokenBalance & getTokenValue
  const additionalWalletBalance =
    additionalWalletBalancesRaw !== 0n ? (
      <div className="position-card__row__info__details">
        {additionalWalletIcon}
        <p className={`L4 meta text-color--${actionColor}`}>
          {formatTokenBalance(
            baseAsset.decimals,
            getTokenValue(additionalWalletBalancesRaw, symbol as Currency, baseAssetPriceInDollars, symbol),
            true,
            symbol as Currency
          )}
        </p>
        <p className="L4 meta text-color--2">
          (
          {formatTokenBalance(
            baseAsset.decimals + PRICE_PRECISION,
            getTokenValue(
              adjustValueForAeroAsset(additionalWalletBalancesRaw, symbol, baseAsset.price),
              Currency.USD,
              baseAssetPriceInDollars,
              symbol
            ),
            true,
            Currency.USD
          )}
          )
        </p>
      </div>
    ) : null;

  const [additionalCollateralValueRaw, additionalCollateralIcon] =
    collateralValuePost > collateralValue
      ? [collateralValuePost - collateralValue, <ArrowUp key="arrow" className={`svg--${actionColor}`} />]
      : [collateralValue - collateralValuePost, <ArrowDown key="arrow" className={`svg--${actionColor}`} />];
  const additionalCollateralValue =
    additionalCollateralValueRaw !== 0n ? (
      <div className="position-card__row__balance__details">
        {additionalCollateralIcon}
        <p className={`L4 meta text-color--${actionColor}`}>
          {formatTokenBalance(
            PRICE_PRECISION,
            getTokenValue(additionalCollateralValueRaw, currency, baseAssetPriceInDollars, symbol),
            true,
            currency
          )}
        </p>
      </div>
    ) : null;

  const [additionalLiquidationPointRaw, additionalLiquidationIcon] =
    liquidationPointPost > liquidationPointPre
      ? [liquidationPointPost - liquidationPointPre, <ArrowUp key="arrow" className={`svg--${actionColor}`} />]
      : [liquidationPointPre - liquidationPointPost, <ArrowDown key="arrow" className={`svg--${actionColor}`} />];
  const additionalLiquidationPoint =
    additionalLiquidationPointRaw !== 0n ? (
      <div className="position-card__row__balance__details">
        {additionalLiquidationIcon}
        <p className={`L4 meta text-color--${actionColor}`}>
          {formatTokenBalance(
            PRICE_PRECISION,
            getTokenValue(additionalLiquidationPointRaw, currency, baseAssetPriceInDollars, symbol),
            true,
            currency
          )}
        </p>
      </div>
    ) : null;

  const [additionalBorrowCapacityRaw, additionalCapacityIcon] =
    baseAssetPost.borrowCapacity > baseAsset.borrowCapacity
      ? [
          baseAssetPost.borrowCapacity - baseAsset.borrowCapacity,
          <ArrowUp key="arrow" className={`svg--${actionColor}`} />,
        ]
      : [
          baseAsset.borrowCapacity - baseAssetPost.borrowCapacity,
          <ArrowDown key="arrow" className={`svg--${actionColor}`} />,
        ];
  const additionalBorrowCapacity =
    additionalBorrowCapacityRaw !== 0n ? (
      <div className="position-card__row__balance__details">
        {additionalCapacityIcon}
        <p className={`L4 meta text-color--${actionColor}`}>
          {formatTokenBalance(
            baseAsset.decimals + PRICE_PRECISION,
            getTokenValue(baseAsset.price * additionalBorrowCapacityRaw, currency, baseAssetPriceInDollars, symbol),
            true,
            currency
          )}
        </p>
      </div>
    ) : null;

  const [additionalAvailableToBorrowRaw, additionalAvailableToBorrowIcon] =
    availableToBorrowPost > availableToBorrowPre
      ? [availableToBorrowPost - availableToBorrowPre, <ArrowUp key="arrow" className={`svg--${actionColor}`} />]
      : [availableToBorrowPre - availableToBorrowPost, <ArrowDown key="arrow" className={`svg--${actionColor}`} />];
  const additionalAvailableToBorrow =
    additionalAvailableToBorrowRaw !== 0n ? (
      <div className="position-card__row__balance__details">
        {additionalAvailableToBorrowIcon}
        <p className={`L4 meta text-color--${actionColor}`}>
          {formatTokenBalance(
            baseAsset.decimals + PRICE_PRECISION,
            getTokenValue(baseAsset.price * additionalAvailableToBorrowRaw, currency, baseAssetPriceInDollars, symbol),
            true,
            currency
          )}
        </p>
      </div>
    ) : null;

  let actionInputView: ReactNode = null;
  let actionInputViewActive = false;
  let actionQueueItems: ReactNode = null;
  if (actions.length > 0) {
    let buttonText = 'Submit Transaction';

    if (transaction?.state === TransactionState.AwaitingConfirmation) {
      buttonText = 'Confirm Transaction';
    } else if (transaction?.state === TransactionState.Pending) {
      buttonText = 'Transaction Pending...';
    }

    const invalidAction = actions.find(
      (action, index) =>
        validateAddingAction(baseAsset, collateralAssets, actions.slice(0, index), action) !== 'ok' ||
        validateAllowanceForAction(baseAsset, collateralAssets, actions.slice(0, index), action) !== 'ok'
    );

    actionQueueItems = (
      <>
        <ActionQueueView
          {...{
            actions,
            actionColor,
            approvalTransactions,
            baseAsset,
            buttonText,
            collateralAssets,
            invalidAction,
            transaction,
            onClearClicked,
            onCompareClicked,
            onDeleteAction,
            onSelectAction,
            onSubmitClicked,
          }}
        />
        <ActionQueueView
          {...{
            actions,
            actionColor,
            approvalTransactions,
            baseAsset,
            buttonText,
            collateralAssets,
            invalidAction,
            transaction,
            onClearClicked,
            onCompareClicked,
            onDeleteAction,
            onSelectAction,
            onSubmitClicked,
            mobile: true,
          }}
        />
      </>
    );
  }

  if (pendingAction) {
    actionInputView = (
      <ActionInputView
        actions={actions}
        baseAsset={baseAsset}
        collateralAssets={collateralAssets}
        initialValue={getPendingActionInitialValue(baseAsset, collateralAssets, actions, pendingAction)}
        market={market}
        pendingAction={pendingAction}
        onCancel={onPendingActionCancel}
        onConfirm={onPendingActionConfirm}
        setPendingActionAmount={onPendingActionUpdateAmount}
      />
    );
    actionInputViewActive = true;
  } else {
    actionInputView = <div className="action-input-view L2"></div>;
  }

  if (actions.length > 0 || baseAsset.balance !== 0n) {
    rates = null;
  }

  return {
    actionInputView,
    actionInputViewActive,
    actionQueueItems,
    additionalWalletBalance,
    additionalCollateralValue,
    additionalLiquidationPoint,
    additionalBorrowCapacity,
    additionalAvailableToBorrow,
    availableToBorrow,
    liquidationPoint,
    borrowCapacity,
    rates,
    baseAssetSymbol: baseAsset.symbol,
    baseAssetWalletBalance: (
      <h3 className={`heading heading--emphasized text-color--1`}>
        {wholeNumberWalletBalance}
        <span className="text-color--3">{`.${fractionalWalletBalance}`}</span>
      </h3>
    ),
    collateralValue: collateralValueDisplay,
    onBaseAssetClicked: () => onDripClicked && onDripClicked(),
  };
}

function getPendingActionInitialValue(
  baseAssetPre: BaseAssetWithAccountState,
  collateralAssets: TokenWithAccountState[],
  actions: Action[],
  pendingAction: PendingAction
): [string, boolean] | undefined {
  const editActionIndex = actions.findIndex(
    (action) => pendingAction !== undefined && isSameAction(pendingAction, action)
  );
  const actionsToUse = editActionIndex === -1 ? actions : actions.slice(0, editActionIndex);
  const { baseAsset } = calculateUpdatedBalances(baseAssetPre, collateralAssets, actionsToUse);

  let amount: bigint | undefined;
  let maxClicked = false;
  if (pendingAction[0] === ActionType.WithdrawCollateral) {
    amount = pendingAction[3];
  } else if (pendingAction[0] === ActionType.Withdraw && pendingAction[2] === MAX_UINT256) {
    amount = baseAsset.balance < 0n ? 0n : baseAsset.balance;
    maxClicked = true;
  } else if (pendingAction[0] === ActionType.Borrow && pendingAction[2] === MAX_UINT256) {
    amount = baseAsset.balance <= 0n ? baseAsset.borrowCapacity + baseAsset.balance : 0n;
    maxClicked = true;
  } else if (pendingAction[0] === ActionType.Supply && pendingAction[2] === MAX_UINT256) {
    const borrowBalance = pendingAction[1].balance < 0n ? -pendingAction[1].balance : 0n;
    amount = pendingAction[1].walletBalance - borrowBalance;
    maxClicked = true;
  } else if (pendingAction[0] === ActionType.Repay && pendingAction[2] === MAX_UINT256) {
    amount = baseAsset.balance < 0n ? -baseAsset.balance : 0n;
    maxClicked = true;
  } else {
    amount = pendingAction[2];
  }

  return amount === undefined ? undefined : [stringFromBigInt(amount, pendingAction[1].decimals), maxClicked];
}

export default PositionCard;

type ActionQueueViewProps = {
  actions: Action[];
  actionColor: 'supply' | 'borrow';
  approvalTransactions: Transaction[];
  baseAsset: BaseAssetWithAccountState;
  buttonText: string;
  collateralAssets: TokenWithAccountState[];
  invalidAction?: Action;
  mobile?: boolean;
  transaction?: Transaction;
  onClearClicked: () => void;
  onCompareClicked: () => void;
  onDeleteAction: (action: Action) => void;
  onSelectAction: (action: Action) => void;
  onSubmitClicked: () => void;
};

const ActionQueueView = ({
  actions,
  actionColor,
  approvalTransactions,
  baseAsset,
  buttonText,
  collateralAssets,
  invalidAction,
  mobile = false,
  transaction,
  onClearClicked,
  onCompareClicked,
  onDeleteAction,
  onSelectAction,
  onSubmitClicked,
}: ActionQueueViewProps) => {
  const [expanded, setExpanded] = useState(false);
  let actionQueueItems: ReactNode = actions.map((action: Action, actionIndex) => {
    const [actionType, asset] = action;
    const approvalTransaction = approvalTransactions.find((transaction) => transaction.key === asset.address);
    const state: ActionQueueItemState =
      transaction === undefined && approvalTransaction === undefined
        ? [
            ActionQueueItemType.normal,
            {
              actionIndex,
              actions,
              baseAsset,
              collateralAssets,
              onClick: () => {
                onSelectAction(action);
              },
              onDeleteClick: () => {
                onDeleteAction(action);
              },
            },
          ]
        : [
            ActionQueueItemType.display,
            {
              actionIndex,
              actions,
              approvalTransaction,
              baseAsset,
              collateralAssets,
            },
          ];

    return <ActionQueueItem state={state} key={asset.name + actionType + actionIndex} />;
  });
  let headerRow: ReactNode;
  let buttonRow: ReactNode;

  if (mobile) {
    headerRow = (
      <div className="position-card__header-row" onClick={() => setExpanded(!expanded)}>
        <label className="L2 label label--active text-color--2">
          {actions.length} Pending Action{actions.length > 1 ? 's' : ''}
        </label>
        <div className="position-card__header-row__expander">
          <label
            className={`L2 label text-color--${actionColor}${
              transaction === undefined && expanded ? ' label--active' : ''
            }`}
            style={{ marginRight: '1.25rem' }}
            onClick={expanded ? onClearClicked : noop}
          >
            Clear All
          </label>
          <CaretDown className={`chevron${expanded ? ' chevron--active' : ''}`} />
        </div>
      </div>
    );

    actionQueueItems = (
      <div className={`position-card__actions__holder${expanded ? ' position-card__actions__holder--active' : ''}`}>
        {actionQueueItems}
      </div>
    );

    buttonRow = (
      <div className="position-card__button-row">
        <button
          className={`button button--${actionColor}`}
          disabled={transaction !== undefined || invalidAction !== undefined}
          onClick={onSubmitClicked}
        >
          {buttonText}
        </button>
        <button className={`button`} onTouchStart={onCompareClicked} onTouchEnd={onCompareClicked}>
          <Compare />
          <span>Compare</span>
        </button>
      </div>
    );

    return (
      <DetailSheet
        active
        className="detail-sheet--foreground-2"
        onClickOutside={() => {
          setExpanded(false);
        }}
        overlay={expanded}
        style={!expanded ? { zIndex: '200' } : undefined}
      >
        <div className="position-card__actions">
          {headerRow}
          {actionQueueItems}
          {buttonRow}
        </div>
      </DetailSheet>
    );
  }
  headerRow = (
    <div className="position-card__header-row">
      <label className="L2 label text-color--2">{actions.length} Pending Actions</label>
      {transaction === undefined && (
        <label className={`L2 label text-color--${actionColor}`} style={{ cursor: 'pointer' }} onClick={onClearClicked}>
          Clear All
        </label>
      )}
    </div>
  );

  buttonRow = (
    <div className="position-card__button-row">
      <button
        className={`button button--x-large button--${actionColor}`}
        disabled={transaction !== undefined || invalidAction !== undefined}
        onClick={onSubmitClicked}
      >
        {buttonText}
      </button>
      <div className="divider"></div>
    </div>
  );

  return (
    <div className="position-card__actions">
      {headerRow}
      {actionQueueItems}
      {buttonRow}
    </div>
  );
};

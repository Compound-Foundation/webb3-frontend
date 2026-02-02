import { Dispatch, ReactNode, useRef, useState } from 'react';

import DetailSheet from '@components/DetailSheet';
import { Compare, HoverUnder } from '@components/Icons';
import Tooltip from '@components/Tooltip';
import NetRatesTooltip, { NetRatesTooltipView } from '@components/Tooltips/NetRatesTooltip';
import { useCurrencyContext } from '@contexts/CurrencyContext';
import { sanitizedAmountForAction } from '@helpers/actions';
import {
  displayValue,
  formatRateFactor,
  formatTokenBalance,
  formatValueInDollars,
  getValueInDollars,
  PRICE_PRECISION,
  shouldShowValueInBaseAsset,
} from '@helpers/numbers';
import { Theme } from '@hooks/useThemeManager';
import {
  Action,
  ActionType,
  BaseAssetWithAccountState,
  BaseAssetWithState,
  Currency,
  PendingAction,
  StateType,
  Token,
  TokenWithAccountState,
  Transaction,
} from '@types';

import { iconForActionType } from './ActionQueueItem';
import { Balance } from './Balance';
import { BalanceValue } from './BalanceValue';
import UtilizationMeter, { UtilizationMeterState } from './UtilizationMeter';

type MastheadLoading = [StateType.Loading];
type MastheadNoWallet = [StateType.NoWallet, { baseAsset: BaseAssetWithState; earnAPR: bigint }];
type MastheadHydrated = [
  StateType.Hydrated,
  {
    actions: Action[];
    baseAsset: BaseAssetWithAccountState;
    baseAssetPost: BaseAssetWithAccountState;
    borrowAPR: bigint;
    borrowRewardsAPR: bigint | undefined;
    collateralAssets: TokenWithAccountState[];
    collateralValue: bigint;
    collateralValuePost: bigint;
    compare: boolean;
    earnAPR: bigint;
    earnRewardsAPR: bigint | undefined;
    liquidationCapacity: bigint;
    liquidationCapacityPost: bigint;
    pendingAction?: PendingAction;
    rewardsAsset?: Token;
    theme: Theme;
    transaction?: Transaction;
    onSupplyAction: (pendingAction?: PendingAction) => void;
    onWithdrawAction: (pendingAction?: PendingAction) => void;
    setCompare: Dispatch<boolean>;
  }
];
export type MastheadState = MastheadLoading | MastheadNoWallet | MastheadHydrated;

type MastheadProps = {
  state: MastheadState;
};

const Masthead = ({ state }: MastheadProps) => {
  const { balanceOverview, balanceValue, balance, buttons, ratesDetail, utilizationMeterState } = getContent(state);
  const {
    currency,
    pressDownAnimate,
    pressUpAnimate,
    setPressDownAnimate,
    setPressUpAnimate,
    toggleCurrency,
    updateShowCurrencyToggle,
  } = useCurrencyContext();

  const handleCurrencyToggle = () => {
    toggleCurrency(currency);
  };

  return (
    <>
      <div className="hero-panel masthead L1">
        <div
          className={`masthead__values header-display ${pressDownAnimate ? 'press-down' : ''} ${
            pressUpAnimate ? 'press-up' : ''
          }`}
          onMouseEnter={() => updateShowCurrencyToggle(true)}
          onMouseLeave={() => updateShowCurrencyToggle(false)}
          onMouseDown={() => {
            setPressDownAnimate(true);
          }}
          onMouseUp={() => {
            setPressDownAnimate(false);
            setPressUpAnimate(true);
            handleCurrencyToggle();
          }}
        >
          {balanceOverview}
          <div className="masthead__balance-value">{balanceValue}</div>
          {balance}
          {ratesDetail}
        </div>
        <div className="masthead__action-buttons">{buttons}</div>
        <UtilizationMeter state={utilizationMeterState} />
      </div>
    </>
  );
};

export default Masthead;

type Content = {
  balanceOverview: ReactNode;
  balanceValue: ReactNode;
  balance: ReactNode;
  buttons: ReactNode;
  ratesDetail: ReactNode;
  utilizationMeterState: UtilizationMeterState;
};

function getContent(state: MastheadState): Content {
  const [stateType] = state;
  const [ratesDetailActive, setRatesDetailActive] = useState(false);
  const tooltipLeftAlign = useRef<HTMLDivElement>(null); // use to align interest rate tooltip

  const { currency, counterCurrency, pressDownAnimate, pressUpAnimate } = useCurrencyContext();
  const defaultContent: Omit<Content, 'balanceOverview'> = {
    balanceValue: (
      <h1>
        <span className="placeholder-content" style={{ width: '240px' }}></span>
      </h1>
    ),
    balance: <span className="placeholder-content" style={{ width: '120px' }}></span>,
    buttons: (
      <div className="masthead__action-buttons">
        <button className="button button--large" disabled>
          <span className="placeholder-content" style={{ width: '100px' }}></span>
        </button>
        <button className="button button--large" disabled>
          <span className="placeholder-content" style={{ width: '100px' }}></span>
        </button>
      </div>
    ),
    ratesDetail: null,
    utilizationMeterState: [StateType.Loading],
  };

  if (stateType === StateType.Loading) {
    const balanceOverview = (
      <div className="masthead__overview-details">
        <span className="placeholder-content" style={{ width: '180px' }}></span>
      </div>
    );
    return { ...defaultContent, balanceOverview };
  } else if (stateType === StateType.NoWallet) {
    const { baseAsset } = state[1];
    const balanceOverview = (
      <div className="masthead__overview-details">
        <p className="meta text-color--supply">Balance</p>
      </div>
    );
    const buttons = (
      <div className="masthead__action-buttons">
        <button className="button button--large button--borrow" disabled>
          {iconForActionType(ActionType.Supply)}
          <label className="label">Supply {baseAsset.symbol}</label>
        </button>
        <button className="button button--large button--supply" disabled>
          {iconForActionType(ActionType.Borrow)}
          <label className="label">Borrow {baseAsset.symbol}</label>
        </button>
      </div>
    );
    // TODO: Refactor formatTokenBalance & getTokenValue
    const [wholeNumberBalanceValue, fractionalNumberBalanceValue] = formatTokenBalance(
      PRICE_PRECISION,
      0n,
      currency === Currency.USD ? true : false,
      currency
    ).split('.');
    const [wholeNumberBalance, fractionalNumberBalance] = `${formatTokenBalance(
      4,
      0n,
      counterCurrency === Currency.USD ? true : false,
      counterCurrency
    )}`.split('.');

    return {
      balanceValue: (
        <BalanceValue
          wholeNumberBalanceValue={wholeNumberBalanceValue}
          fractionalNumberBalanceValue={fractionalNumberBalanceValue}
        />
      ),
      balance: <Balance wholeNumberBalance={wholeNumberBalance} fractionalNumberBalance={fractionalNumberBalance} />,
      balanceOverview,
      buttons,
      ratesDetail: null,
      utilizationMeterState: [StateType.NoWallet],
    };
  }

  const {
    actions,
    baseAsset,
    baseAssetPost,
    borrowAPR,
    borrowRewardsAPR,
    collateralAssets,
    collateralValue,
    collateralValuePost,
    compare,
    earnAPR,
    earnRewardsAPR,
    liquidationCapacity,
    liquidationCapacityPost,
    pendingAction,
    rewardsAsset,
    theme,
    transaction,
    onSupplyAction,
    onWithdrawAction,
    setCompare,
  } = state[1];
  const {
    baseAsset: { symbol },
  } = state[1];

  const hasActions = actions.length > 0;
  const [baseAssetToUse, collateralValueToUse, liquidationCapacityToUse] = compare
    ? [baseAsset, collateralValue, liquidationCapacity]
    : [baseAssetPost, collateralValuePost, liquidationCapacityPost];
  const compareButton = hasActions ? (
    <Tooltip content={<div className="body">Compare</div>} mini={true} width={90}>
      <button
        className="button button--circle button--compare"
        onMouseDown={() => {
          setCompare(true);
        }}
        onMouseUp={() => {
          setCompare(false);
        }}
      >
        <Compare />
      </button>
    </Tooltip>
  ) : null;

  const utilizationMeterState: UtilizationMeterState = [
    StateType.Hydrated,
    {
      baseAsset: baseAssetToUse,
      collateralValue: collateralValueToUse,
      liquidationCapacity: liquidationCapacityToUse,
    },
  ];

  const netRatesTooltipProps = {
    borrowAPR,
    borrowRewardsAPR,
    earnAPR,
    earnRewardsAPR,
    rewardsAsset,
  };

  let ratesTooltipContent = <NetRatesTooltip {...netRatesTooltipProps} view={NetRatesTooltipView.Borrow} />;

  // BORROW POSITION
  if (baseAssetToUse.balance < 0n) {
    const borrowBalance = -baseAssetToUse.balance;
    const baseAssetDenominatedForBigNumber = shouldShowValueInBaseAsset(symbol as Currency, currency);
    let valueBasedOnCurrency;
    let valueBasedOnCounterCurrency;
    if (baseAssetDenominatedForBigNumber) {
      valueBasedOnCurrency = displayValue(baseAssetToUse.decimals, borrowBalance);
      // the smaller number display in $
      const valueToUseForCounterCurrency = getValueInDollars(baseAssetToUse.price * borrowBalance, baseAssetToUse);
      valueBasedOnCounterCurrency = formatValueInDollars(
        baseAssetToUse.decimals + PRICE_PRECISION,
        valueToUseForCounterCurrency
      );
    } else {
      const valueToUse = getValueInDollars(baseAssetToUse.price * borrowBalance, baseAssetToUse);
      valueBasedOnCurrency = formatValueInDollars(baseAssetToUse.decimals + PRICE_PRECISION, valueToUse);
      // the smaller number display in base asset
      valueBasedOnCounterCurrency = displayValue(baseAssetToUse.decimals, borrowBalance);
    }
    const [wholeNumberBalanceValue, fractionalNumberBalanceValue] = valueBasedOnCurrency.split('.');
    const [wholeNumberBalance, fractionalNumberBalance] = valueBasedOnCounterCurrency.split('.');

    const borrowActionIndex = actions.findIndex((action) => action[0] === ActionType.Borrow);
    const pendingBorrowAction = pendingAction !== undefined && pendingAction[0] === ActionType.Borrow;
    const supplyActionIndex = actions.findIndex((action) => action[0] === ActionType.Supply);
    const pendingSupplyAction = pendingAction !== undefined && pendingAction[0] === ActionType.Supply;
    const repayActionIndex = actions.findIndex((action) => action[0] === ActionType.Repay);
    const pendingRepayAction = pendingAction !== undefined && pendingAction[0] === ActionType.Repay;
    const withdrawActionIndex = actions.findIndex((action) => action[0] === ActionType.Withdraw);
    const pendingWithdrawAction = pendingAction !== undefined && pendingAction[0] === ActionType.Withdraw;

    let overviewDetails: ReactNode;
    let buttons: ReactNode;

    if (!hasActions) {
      overviewDetails = (
        <Tooltip
          content={ratesTooltipContent}
          width={400}
          hideArrow={true}
          x={tooltipLeftAlign.current?.getBoundingClientRect().left}
          y={tooltipLeftAlign.current?.getBoundingClientRect().bottom}
        >
          <div className="masthead__overview-details" onClick={() => setRatesDetailActive(true)}>
            <span className="meta text-color--3"> &#64; </span>
            <div className="masthead__overview-details__net-rate">
              <span className="meta">{formatRateFactor(borrowAPR - (borrowRewardsAPR || 0n))} Net APR</span>
              <HoverUnder className="hover-under" long={true} theme={theme} />
            </div>
          </div>
        </Tooltip>
      );
    } else if (hasActions && compare) {
      overviewDetails = <p className="meta text-color--3"> Before Transaction </p>;
    } else {
      overviewDetails = <p className="meta text-color--3"> After Transaction </p>;
    }

    const balanceOverview = (
      <div
        className={`masthead__overview-details ${pressDownAnimate ? 'press-down' : ''}
      ${pressUpAnimate ? 'press-up' : ''}
    }`}
      >
        <p ref={tooltipLeftAlign} className="meta text-color--borrow">
          Borrowing
        </p>
        {overviewDetails}
      </div>
    );

    let supplyOrWithdrawButton: ReactNode = null;
    if (pendingSupplyAction) {
      supplyOrWithdrawButton = (
        <button
          className="button button--large button--supply button--selected"
          disabled={transaction !== undefined}
          onClick={() => onSupplyAction(undefined)}
        >
          {iconForActionType(ActionType.Supply)}
          <label className="label">Supply {baseAssetToUse.symbol}</label>
        </button>
      );
    } else if (supplyActionIndex !== -1) {
      const supplyAction = actions[supplyActionIndex];
      const [, asset] = supplyAction;
      const amount = sanitizedAmountForAction(
        baseAsset,
        collateralAssets,
        actions.slice(0, supplyActionIndex),
        supplyAction
      );
      const formattedAmount = formatTokenBalance(asset.decimals, amount, true);
      supplyOrWithdrawButton = (
        <button
          className="button button--large button--supply button--deselected"
          disabled={transaction !== undefined}
          onClick={() => onSupplyAction(supplyAction as PendingAction)}
        >
          {iconForActionType(ActionType.Supply)}
          <label className="label">
            Supply {formattedAmount} {baseAssetToUse.symbol}
          </label>
        </button>
      );
    } else if (pendingWithdrawAction) {
      supplyOrWithdrawButton = (
        <button
          className="button button--large button--supply button--selected"
          disabled={transaction !== undefined}
          onClick={() => onSupplyAction(undefined)}
        >
          {iconForActionType(ActionType.Withdraw)}
          <label className="label">Withdraw {baseAssetToUse.symbol}</label>
        </button>
      );
    } else if (withdrawActionIndex !== -1) {
      const withdrawAction = actions[withdrawActionIndex];
      const [, asset] = withdrawAction;
      const amount = sanitizedAmountForAction(
        baseAsset,
        collateralAssets,
        actions.slice(0, withdrawActionIndex),
        withdrawAction
      );
      const formattedAmount = formatTokenBalance(asset.decimals, amount, true);
      supplyOrWithdrawButton = (
        <button
          className="button button--large button--supply button--deselected"
          disabled={transaction !== undefined}
          onClick={() => onSupplyAction(withdrawAction as PendingAction)}
        >
          {iconForActionType(ActionType.Withdraw)}
          <label className="label">
            Withdraw {formattedAmount} {baseAssetToUse.symbol}
          </label>
        </button>
      );
    }

    if (pendingRepayAction) {
      buttons = (
        <>
          <button
            className="button button--large button--borrow button--selected"
            disabled={transaction !== undefined}
            onClick={() => onSupplyAction(undefined)}
          >
            {iconForActionType(ActionType.Repay)}
            <label className="label">Repay {baseAssetToUse.symbol}</label>
          </button>
        </>
      );
    } else if (repayActionIndex !== -1) {
      const repayAction = actions[repayActionIndex];
      const [, asset] = repayAction;
      const amount = sanitizedAmountForAction(
        baseAsset,
        collateralAssets,
        actions.slice(0, repayActionIndex),
        repayAction
      );
      const formattedAmount = formatTokenBalance(asset.decimals, amount, true);

      buttons = (
        <>
          <button
            className="button button--large button--borrow button--deselected"
            disabled={transaction !== undefined}
            onClick={() => onWithdrawAction(repayAction as PendingAction)}
          >
            {iconForActionType(ActionType.Repay)}
            <label className="label">
              Repay {formattedAmount} {baseAssetToUse.symbol}
            </label>
          </button>
        </>
      );
    } else if (pendingBorrowAction) {
      buttons = (
        <>
          <button
            className="button button--large button--borrow button--selected"
            disabled={transaction !== undefined}
            onClick={() => onWithdrawAction(undefined)}
          >
            {iconForActionType(ActionType.Borrow)}
            <label className="label">Borrow {baseAssetToUse.symbol}</label>
          </button>
        </>
      );
    } else if (borrowActionIndex === -1) {
      buttons = (
        <>
          <button
            className="button button--large button--borrow"
            disabled={transaction !== undefined || baseAsset.borrowCapacity === 0n}
            onClick={() => onWithdrawAction([ActionType.Borrow, baseAssetPost, undefined])}
          >
            {iconForActionType(ActionType.Borrow)}
            <label className="label">Borrow {baseAssetToUse.symbol}</label>
          </button>
          <button
            className="button button--large button--borrow"
            disabled={transaction !== undefined || baseAsset.walletBalance === 0n}
            onClick={() => onSupplyAction([ActionType.Repay, baseAssetPost, undefined])}
          >
            {iconForActionType(ActionType.Repay)}
            <label className="label">Repay {baseAssetToUse.symbol}</label>
          </button>
        </>
      );
    } else {
      const borrowAction = actions[borrowActionIndex];
      const [, asset] = borrowAction;
      const amount = sanitizedAmountForAction(
        baseAsset,
        collateralAssets,
        actions.slice(0, borrowActionIndex),
        borrowAction
      );
      const formattedAmount = formatTokenBalance(asset.decimals, amount, true);

      buttons = (
        <>
          <button
            className="button button--large button--borrow button--deselected"
            disabled={transaction !== undefined}
            onClick={() => onWithdrawAction(borrowAction as PendingAction)}
          >
            {iconForActionType(ActionType.Borrow)}
            <label className="label">
              Borrow {formattedAmount} {baseAssetToUse.symbol}
            </label>
          </button>
        </>
      );
    }

    buttons = (
      <div className="masthead__action-buttons">
        {supplyOrWithdrawButton}
        {buttons}
        {compareButton}
      </div>
    );

    return {
      balanceOverview,
      balanceValue: (
        <BalanceValue
          wholeNumberBalanceValue={wholeNumberBalanceValue}
          fractionalNumberBalanceValue={fractionalNumberBalanceValue}
        ></BalanceValue>
      ),
      balance: (
        <Balance wholeNumberBalance={wholeNumberBalance} fractionalNumberBalance={fractionalNumberBalance}></Balance>
      ),
      buttons,
      ratesDetail: (
        <DetailSheet active={ratesDetailActive} onClickOutside={() => setRatesDetailActive(false)}>
          {ratesTooltipContent}
        </DetailSheet>
      ),
      utilizationMeterState,
    };
  }
  // SUPPLY POSITION OR NO BALANCE
  else {
    const baseAssetDenominatedForBigNumber = shouldShowValueInBaseAsset(symbol as Currency, currency);
    let currencyValue;
    let valueBasedOnCounterCurrency;
    if (baseAssetDenominatedForBigNumber) {
      currencyValue = displayValue(baseAssetToUse.decimals, baseAssetToUse.balance);
      const valueToUseForCounterCurrency = getValueInDollars(baseAssetToUse.price * baseAssetToUse.balance, baseAsset);
      valueBasedOnCounterCurrency = formatValueInDollars(
        baseAssetToUse.decimals + PRICE_PRECISION,
        valueToUseForCounterCurrency
      );
    } else {
      const valueToUse = getValueInDollars(baseAssetToUse.price * baseAssetToUse.balance, baseAsset);
      currencyValue = formatValueInDollars(baseAssetToUse.decimals + PRICE_PRECISION, valueToUse);
      valueBasedOnCounterCurrency = displayValue(baseAssetToUse.decimals, baseAssetToUse.balance);
    }
    // TODO with the toggle the Big Number and small number are the same logic, refactor naming of BalanceValue and Balance
    const [wholeNumberBalanceValue, fractionalNumberBalanceValue] = currencyValue.split('.');
    const [wholeNumberBalance, fractionalNumberBalance] = valueBasedOnCounterCurrency.split('.');

    const hasActions = actions.length > 0;
    const supplyActionIndex = actions.findIndex((action) => action[0] === ActionType.Supply);
    const pendingSupplyAction = pendingAction !== undefined && pendingAction[0] === ActionType.Supply;
    const repayActionIndex = actions.findIndex((action) => action[0] === ActionType.Repay);
    const pendingRepayAction = pendingAction !== undefined && pendingAction[0] === ActionType.Repay;
    const borrowActionIndex = actions.findIndex((action) => action[0] === ActionType.Borrow);
    const pendingBorrowAction = pendingAction !== undefined && pendingAction[0] === ActionType.Borrow;
    const withdrawActionIndex = actions.findIndex((action) => action[0] === ActionType.Withdraw);
    const pendingWithdrawAction = pendingAction !== undefined && pendingAction[0] === ActionType.Withdraw;

    let overviewDetails: ReactNode;
    let buttons: ReactNode;

    ratesTooltipContent = <NetRatesTooltip {...netRatesTooltipProps} view={NetRatesTooltipView.Supply} />;

    if (!hasActions) {
      overviewDetails =
        baseAssetToUse.balance > 0n ? (
          <Tooltip
            content={ratesTooltipContent}
            width={400}
            hideArrow={true}
            x={tooltipLeftAlign.current?.getBoundingClientRect().left}
            y={tooltipLeftAlign.current?.getBoundingClientRect().bottom}
          >
            <div className="masthead__overview-details" onClick={() => setRatesDetailActive(true)}>
              <span className="meta text-color--3"> &#64; </span>
              <div className="masthead__overview-details__net-rate">
                <span className="meta">{formatRateFactor(earnAPR + (earnRewardsAPR || 0n))} Net APR</span>
                <HoverUnder className="hover-under" long={true} theme={theme} />
              </div>
            </div>
          </Tooltip>
        ) : (
          <></>
        );
    } else if (hasActions && compare) {
      overviewDetails = <p className="meta text-color--3"> Before Transaction </p>;
    } else {
      overviewDetails = <p className="meta text-color--3"> After Transaction </p>;
    }

    const balanceOverview = (
      <div
        className={`masthead__overview-details ${pressDownAnimate ? 'press-down' : ''}
      ${pressUpAnimate ? 'press-up' : ''}
    }`}
      >
        <p ref={tooltipLeftAlign} className="meta text-color--supply">
          {baseAssetToUse.balance > 0n ? 'Supplying' : 'Balance'}
        </p>
        {overviewDetails}
      </div>
    );

    let repayBorrowOrWithdrawButton: ReactNode = null;
    if (pendingRepayAction) {
      repayBorrowOrWithdrawButton = (
        <button
          className="button button--large button--borrow button--selected"
          disabled={transaction !== undefined}
          onClick={() => onSupplyAction(undefined)}
        >
          {iconForActionType(ActionType.Repay)}
          <label className="label">Repay {baseAssetToUse.symbol}</label>
        </button>
      );
    } else if (repayActionIndex !== -1) {
      const repayAction = actions[repayActionIndex];
      const [, asset] = repayAction;
      const amount = sanitizedAmountForAction(
        baseAsset,
        collateralAssets,
        actions.slice(0, repayActionIndex),
        repayAction
      );
      const formattedAmount = formatTokenBalance(asset.decimals, amount, true);
      repayBorrowOrWithdrawButton = (
        <button
          className="button button--large button--borrow button--deselected"
          disabled={transaction !== undefined || pendingSupplyAction}
          onClick={() => onSupplyAction(repayAction as PendingAction)}
        >
          {iconForActionType(ActionType.Repay)}
          <label className="label">
            Repay {formattedAmount} {baseAssetToUse.symbol}
          </label>
        </button>
      );
    } else if (pendingBorrowAction) {
      repayBorrowOrWithdrawButton = (
        <button
          className="button button--large button--borrow button--selected"
          disabled={transaction !== undefined}
          onClick={() => onWithdrawAction(undefined)}
        >
          {iconForActionType(ActionType.Borrow)}
          <label className="label">Borrow {baseAssetToUse.symbol}</label>
        </button>
      );
    } else if (borrowActionIndex !== -1) {
      const borrowAction = actions[borrowActionIndex];
      const [, asset] = borrowAction;
      const amount = sanitizedAmountForAction(
        baseAsset,
        collateralAssets,
        actions.slice(0, borrowActionIndex),
        borrowAction
      );
      const formattedAmount = formatTokenBalance(asset.decimals, amount, true);

      repayBorrowOrWithdrawButton = (
        <button
          className="button button--large button--borrow button--deselected"
          disabled={transaction !== undefined}
          onClick={() => onWithdrawAction(borrowAction as PendingAction)}
        >
          {iconForActionType(ActionType.Borrow)}
          <label className="label">
            Borrow {formattedAmount} {baseAssetToUse.symbol}
          </label>
        </button>
      );
    } else if (baseAssetToUse.balance === 0n && !pendingSupplyAction && supplyActionIndex === -1) {
      repayBorrowOrWithdrawButton = (
        <button
          className="button button--large button--borrow"
          disabled={transaction !== undefined || baseAssetToUse.borrowCapacity === 0n}
          onClick={() => onWithdrawAction([ActionType.Borrow, baseAssetPost, undefined])}
        >
          {iconForActionType(ActionType.Borrow)}
          <label className="label">Borrow {baseAssetToUse.symbol}</label>
        </button>
      );
    } else if (
      (baseAssetToUse.balance > 0n &&
        withdrawActionIndex === -1 &&
        !pendingWithdrawAction &&
        !pendingSupplyAction &&
        pendingSupplyAction === undefined) ||
      (supplyActionIndex === -1 &&
        !pendingSupplyAction &&
        !pendingWithdrawAction &&
        withdrawActionIndex === -1 &&
        baseAssetToUse.balance > 0n)
    ) {
      repayBorrowOrWithdrawButton = (
        <button
          className="button button--large button--supply"
          disabled={transaction !== undefined}
          onClick={() => onWithdrawAction([ActionType.Withdraw, baseAssetPost, undefined])}
        >
          {iconForActionType(ActionType.Withdraw)}
          <label className="label">Withdraw {baseAssetToUse.symbol}</label>
        </button>
      );
    }

    if (pendingWithdrawAction) {
      buttons = (
        <button
          className="button button--large button--supply button--selected"
          disabled={transaction !== undefined}
          onClick={() => onWithdrawAction(undefined)}
        >
          {iconForActionType(ActionType.Withdraw)}
          <label className="label">Withdraw {baseAssetToUse.symbol}</label>
        </button>
      );
    } else if (withdrawActionIndex !== -1) {
      const withdrawAction = actions[withdrawActionIndex];
      const [, asset] = withdrawAction;
      const amount = sanitizedAmountForAction(
        baseAsset,
        collateralAssets,
        actions.slice(0, withdrawActionIndex),
        withdrawAction
      );
      const formattedAmount = formatTokenBalance(asset.decimals, amount, true);
      buttons = (
        <button
          className="button button--large button--supply"
          disabled={transaction !== undefined || pendingBorrowAction}
          onClick={() => onWithdrawAction(withdrawAction as PendingAction)}
        >
          {iconForActionType(ActionType.Withdraw)}
          <label className="label">
            Withdraw {formattedAmount} {baseAssetToUse.symbol}
          </label>
        </button>
      );
    } else if (pendingSupplyAction) {
      buttons = (
        <button
          className="button button--large button--supply button--selected"
          disabled={transaction !== undefined}
          onClick={() => onSupplyAction(undefined)}
        >
          {iconForActionType(ActionType.Supply)}
          <label className="label">Supply {baseAssetToUse.symbol}</label>
        </button>
      );
    } else if (supplyActionIndex === -1) {
      if (borrowActionIndex === -1 && !pendingBorrowAction) {
        buttons = (
          <button
            className="button button--large button--supply"
            disabled={transaction !== undefined || baseAssetToUse.walletBalance === 0n}
            onClick={() => onSupplyAction([ActionType.Supply, baseAssetPost, undefined])}
          >
            {iconForActionType(ActionType.Supply)}
            <label className="label">Supply {baseAssetToUse.symbol}</label>
          </button>
        );
      }
    } else {
      const supplyAction = actions[supplyActionIndex];
      const [, asset] = supplyAction;
      const amount = sanitizedAmountForAction(
        baseAsset,
        collateralAssets,
        actions.slice(0, supplyActionIndex),
        supplyAction
      );
      const formattedAmount = formatTokenBalance(asset.decimals, amount, true);

      buttons = (
        <button
          className="button button--large button--supply button--deselected"
          disabled={transaction !== undefined}
          onClick={() => onSupplyAction(supplyAction as PendingAction)}
        >
          {iconForActionType(ActionType.Supply)}
          <label className="label">
            Supply {formattedAmount} {baseAssetToUse.symbol}
          </label>
        </button>
      );
    }

    buttons = (
      <div className="masthead__action-buttons">
        {buttons}
        {repayBorrowOrWithdrawButton}
        {compareButton}
      </div>
    );

    return {
      balanceOverview,
      balanceValue: (
        <BalanceValue
          wholeNumberBalanceValue={wholeNumberBalanceValue}
          fractionalNumberBalanceValue={fractionalNumberBalanceValue}
        ></BalanceValue>
      ),
      balance: <Balance wholeNumberBalance={wholeNumberBalance} fractionalNumberBalance={fractionalNumberBalance} />,
      buttons,
      utilizationMeterState,
      ratesDetail: (
        <DetailSheet active={ratesDetailActive} onClickOutside={() => setRatesDetailActive(false)}>
          {ratesTooltipContent}
        </DetailSheet>
      ),
    };
  }
}

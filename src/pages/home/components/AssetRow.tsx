import { ReactNode, useEffect, useRef, useState } from 'react';

import DetailSheet from '@components/DetailSheet';
import { ArrowDown, ArrowUp, CircleExclamationSmall, Close, Minus, Plus } from '@components/Icons';
import Tooltip from '@components/Tooltip';
import AssetTooltipContent from '@components/Tooltips/AssetTooltipContent';
import UnwrappedAssetTooltipContent from '@components/Tooltips/UnwrappedAssetTooltipContent';
import { useCurrencyContext } from '@contexts/CurrencyContext';
import { displayTextForActionType } from '@helpers/actions';
import { assetIconForAssetSymbol } from '@helpers/assets';
import { formatTokenBalance, PRICE_PRECISION, getTokenValue, formatValue, displayValue } from '@helpers/numbers';
import {
  Action,
  ActionType,
  BaseAssetWithAccountState,
  Currency,
  PendingAction,
  StateType,
  Token,
  TokenWithAccountState,
  TokenWithState,
  Transaction,
} from '@types';

type AssetRowLoading = [StateType.Loading];
type AssetRowNoWallet = [StateType.NoWallet, { asset: TokenWithState; isCollateralError?: boolean }];
type AssetRowHydrated = [
  StateType.Hydrated,
  {
    action?: Action;
    asset: TokenWithAccountState;
    baseAsset: BaseAssetWithAccountState;
    pendingAction?: PendingAction;
    transaction?: Transaction;
    unwrappedAssetSupplyAction?: Action;
    wrappedAsset?: TokenWithAccountState;
    isCollateralError: boolean;
    isDeprecated?: boolean;
    onCancelClicked: () => void;
    onEditClicked: () => void;
    onSupplyClicked: () => void;
    onWithdrawClicked?: () => void;
    onDripClicked?: () => void;
  }
];

export type AssetRowState = AssetRowLoading | AssetRowNoWallet | AssetRowHydrated;

const LoadingAssetRow = () => {
  return (
    <div className="asset-row L3">
      <div className="asset-row__detail-content">
        <span className="asset">
          <span className="placeholder-content placeholder-content--circle"></span>
        </span>
        <div className="asset-row__info">
          <p className="body">
            <span className="placeholder-content" style={{ width: '40%' }}></span>
          </p>
          <div className="asset-row__info__details">
            <span className="placeholder-content" style={{ width: '25%' }}></span>
          </div>
        </div>
      </div>
      <div className="asset-row__balance">
        <span className="placeholder-content" style={{ width: '50%' }}></span>
        <p className="L4 meta">
          <span className="placeholder-content" style={{ width: '40%' }}></span>
        </p>
      </div>
      <div className="asset-row__actions">
        <button className="button button--circle" disabled>
          <Plus />
        </button>
        <button className="button button--circle" disabled>
          <Minus />
        </button>
      </div>
    </div>
  );
};

export type AssetRowProps = {
  state: AssetRowState;
};

type Content = {
  asset: Token;
  assetRowModifier: string;
  collateralValue: ReactNode;
  assetBalance: ReactNode;
  displayWalletBalance: ReactNode;
  buttons: ReactNode;
  tooltipContent: ReactNode;
  onIconClick: () => void;
};

function getFormattedState(state: AssetRowNoWallet | AssetRowHydrated, currency: Currency): Content {
  const [stateType, { asset, isCollateralError }] = state;
  const tooltipContent = getTooltipContent(state, currency);

  if (stateType === StateType.NoWallet) {
    const buttons = (
      <>
        <button className="button button--circle" disabled>
          <Plus />
          <span className="mobile-only">Supply</span>
        </button>
        <button className="button button--circle" disabled>
          <Minus />
          <span className="mobile-only">Withdraw</span>
        </button>
      </>
    );

    return {
      asset,
      assetRowModifier:  isCollateralError ? ' asset-row--error' : '',
      collateralValue: null,
      assetBalance: <p className="body text-color--3">0.0000</p>,
      displayWalletBalance: '',
      buttons,
      tooltipContent,
      onIconClick: () => undefined,
    };
  }

  const {
    baseAsset: { symbol, baseAssetPriceInDollars },
    action,
    pendingAction,
    transaction,
    unwrappedAssetSupplyAction,
    isDeprecated,
    onCancelClicked,
    onEditClicked,
    onSupplyClicked,
    onWithdrawClicked,
    onDripClicked,
  } = state[1];
  const { decimals, price, balance, walletBalance } = asset as TokenWithAccountState;
  const assetRowModifier =
    (pendingAction !== undefined ? ` asset-row--active` : '') +
    (isCollateralError || isDeprecated ? ' asset-row--error' : '');
  const formattedWalletBalance = (
    <p className="L2 meta">&nbsp;•&nbsp;{formatValue(decimals, walletBalance)} in wallet</p>
  );

  // If this asset has a matching unwrapped version we need to also add
  // add the unwrapped asset's pending action supply to this asset's
  // balance.
  let matchingActionAmount: bigint | undefined;
  if (action !== undefined) {
    matchingActionAmount = action[0] === ActionType.WithdrawCollateral ? -action[2] : action[2];
  }

  let actionAmount = matchingActionAmount;
  if (unwrappedAssetSupplyAction !== undefined) {
    if (actionAmount === undefined) {
      actionAmount = unwrappedAssetSupplyAction[2];
    } else {
      actionAmount = actionAmount + unwrappedAssetSupplyAction[2];
    }
  }
  const balanceToUse = balance + balanceDifferenceFromActions(pendingAction, actionAmount);
  const onIconClick = () => onDripClicked && onDripClicked();

  let buttons: ReactNode;

  if (pendingAction !== undefined) {
    buttons = (
      <button
        className="button button--selected"
        disabled={transaction !== undefined}
        onClick={() => {
          onCancelClicked();
        }}
      >
        <Close />
        <span>{displayTextForActionType(pendingAction[0])}</span>
      </button>
    );
  } else if (action !== undefined) {
    const [actionType, token, amount] = action;
    const [icon, actionDescription] =
      actionType === ActionType.WithdrawCollateral ? [<ArrowDown />, 'Withdraw'] : [<ArrowUp />, 'Supply'];

    buttons = (
      <button
        className="button button--deselected"
        disabled={transaction !== undefined}
        onClick={() => {
          onEditClicked();
        }}
      >
        {icon}
        <span className="mobile-only button__mobile-info">{actionDescription}</span>
        <span>{formatTokenBalance(decimals, amount, true)}</span>
        <span className="mobile-only button__mobile-info">{token.symbol}</span>
      </button>
    );
  } else {
    const [supplyButtonTextClass, supplyButtonModifier] = onWithdrawClicked
      ? ['mobile-only', ' button--circle']
      : ['', ''];

    buttons = (
      <>
        <button
          onClick={() => {
            onSupplyClicked();
          }}
          className={`button${supplyButtonModifier}`}
          disabled={walletBalance === 0n || transaction !== undefined || isCollateralError || isDeprecated}
        >
          <Plus />
          <span className={supplyButtonTextClass}>Supply</span>
        </button>
        {onWithdrawClicked && (
          <button
            onClick={() => onWithdrawClicked()}
            className="button button--circle"
            disabled={balanceToUse === 0n || transaction !== undefined || isCollateralError}
          >
            <Minus />
            <span className="mobile-only">Withdraw</span>
          </button>
        )}
      </>
    );
  }

  if (balanceToUse > 0n) {
    const [wholeNumber, fractionalNumber] = displayValue(decimals, balanceToUse).split('.');
    const valueToFormat = getTokenValue(balanceToUse * price, currency, baseAssetPriceInDollars, symbol);
    return {
      asset,
      assetRowModifier,
      collateralValue: (
        <p className={`L2 meta`}>{formatTokenBalance(decimals + PRICE_PRECISION, valueToFormat, true, currency)}</p>
      ),
      assetBalance: (
        <p className="body text-color--1">
          {wholeNumber}
          <span className="text-color--3">{`.${fractionalNumber}`}</span>
        </p>
      ),
      displayWalletBalance: formattedWalletBalance,
      buttons,
      tooltipContent,
      onIconClick,
    };
  } else {
    return {
      asset,
      assetRowModifier,
      collateralValue: null,
      assetBalance: (
        <p className={`body text-color--${walletBalance > 0n ? '1' : '3'}`}>
          0<span className="text-color--3">{`.0000`}</span>
        </p>
      ),
      displayWalletBalance: formattedWalletBalance,
      buttons,
      tooltipContent,
      onIconClick,
    };
  }
}

function getTooltipContent(state: AssetRowNoWallet | AssetRowHydrated, currency: Currency): ReactNode {
  const [stateType, { asset }] = state;

  let tooltipContent = <AssetTooltipContent asset={asset as TokenWithState} currency={currency} />;

  if (stateType === StateType.Hydrated) {
    if (state[1].wrappedAsset !== undefined) {
      tooltipContent = (
        <UnwrappedAssetTooltipContent
          asset={asset as TokenWithAccountState}
          baseAsset={state[1].baseAsset}
          currency={currency}
          wrappedAsset={state[1].wrappedAsset}
        />
      );
    } else {
      tooltipContent = (
        <AssetTooltipContent asset={asset} baseAsset={state[1].baseAsset} currency={currency} isHydrated={true} />
      );
    }
  }

  return tooltipContent;
}

function balanceDifferenceFromActions(pendingAction?: PendingAction, actionAmount?: bigint): bigint {
  let amount = 0n;

  if (pendingAction !== undefined) {
    if (pendingAction[0] === ActionType.WithdrawCollateral) {
      amount = pendingAction[3] === undefined ? 0n : -pendingAction[3];
    } else {
      amount = pendingAction[2] === undefined ? 0n : pendingAction[2];
    }
  } else if (actionAmount !== undefined) {
    amount = actionAmount;
  }

  return amount;
}

const AssetRow = ({ state }: AssetRowProps) => {
  const [stateType] = state;
  const [hoverModifier, setHoverModifier] = useState('');
  const [detailsActive, setDetailsActive] = useState(false);
  const { currency } = useCurrencyContext();
  const prevActionAmount = useRef<bigint | undefined>();

  useEffect(() => {
    if (stateType === StateType.Hydrated) {
      const { action } = state[1];
      if (action && action[2] !== prevActionAmount.current) {
        prevActionAmount.current = action[2];
        setDetailsActive(false);
      }
    }
  }, [stateType, state]);

  if (stateType === StateType.Loading) {
    return <LoadingAssetRow />;
  }

  const {
    asset,
    assetRowModifier,
    collateralValue,
    assetBalance,
    displayWalletBalance,
    buttons,
    tooltipContent,
    onIconClick,
  } = getFormattedState(state, currency);

  const closeDetails = () => {
    setDetailsActive(false);
  };

  const abbrSymbol = asset.symbol === 'wsuperOETHb' ? '...OETHb' : asset.symbol;
  const isCollateralError = state[1].isCollateralError === true;
  const isDeprecated = state[0] === StateType.Hydrated && state[1].isDeprecated === true;
  const isDimmed = isCollateralError || isDeprecated;

  const assetIcon = (
    <span
      className={`asset asset--${assetIconForAssetSymbol(asset.symbol)}${
        isDimmed ? ' asset-row__icon--disabled' : ''
      }`}
      onClick={onIconClick}
    ></span>
  );

  return (
    <div
      className={`asset-row${assetRowModifier} L3`}
      onClick={() => {
        setDetailsActive(true);
      }}
    >
      <div className={`asset-row__hover${hoverModifier}`}></div>
      {/* A collateral in the error status shows its status over the error badge instead of the asset details */}
      <Tooltip content={tooltipContent} width={340} hideArrow={true} yOffset={30} disabled={isDimmed}>
        <div
          className="asset-row__detail-content"
          onMouseEnter={() => {
            setHoverModifier(' asset-row__hover--active');
          }}
          onMouseLeave={() => {
            setHoverModifier('');
          }}
        >
          {isCollateralError ? (
            <span className="asset-row__icon-container">
              {assetIcon}
              <Tooltip
                open={hoverModifier !== ''}
                content={<span className="asset-row__tooltip-text">{'Collateral temporarily unavailable.'}</span>}
                width={214}
                // Hover-only tooltips are hidden on small screens, the status one opens on tap there
                interactive={true}
                yOffset={12}
              >
                <span className="asset-row__error-icon">
                  <CircleExclamationSmall />
                </span>
              </Tooltip>
            </span>
          ) : isDeprecated ? (
            <Tooltip
              open={hoverModifier !== ''}
              content={<span className="asset-row__tooltip-text">{'Collateral deprecated. Withdrawals only.'}</span>}
              width={154}
              interactive={true}
              yOffset={16}
            >
              <span className="asset-row__icon-container asset-row__icon-container--deprecated">{assetIcon}</span>
            </Tooltip>
          ) : (
            assetIcon
          )}
          <div className="asset-row__info">
            <p className={`body${isDimmed ? ' text-color--3' : ''}`}>{asset.name}</p>
            <div className="asset-row__info__details meta L2">
              {abbrSymbol}
              {displayWalletBalance}
            </div>
          </div>
        </div>
      </Tooltip>
      <div className="asset-row__balance">
        {assetBalance}
        {collateralValue}
      </div>
      <div className="asset-row__actions">{buttons}</div>
      <DetailSheet active={detailsActive} onClickOutside={closeDetails}>
        <>
          {tooltipContent}
          <div className="divider"></div>
          <div className="detail-sheet__actions" onClick={closeDetails}>
            {buttons}
          </div>
        </>
      </DetailSheet>
    </div>
  );
};

export default AssetRow;

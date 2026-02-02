import { ChangeEventHandler, ChangeEvent, Dispatch, useEffect, useRef, useState } from 'react';

import { isUnwrappedCollateralAsset } from '@constants/chains';
import {
  calculateUpdatedBalances,
  getActionFromPendingAction,
  isSameAction,
  isSameToken,
  validateAddingAction,
} from '@helpers/actions';
import { assetIconForAssetSymbol } from '@helpers/assets';
import { noop } from '@helpers/functions';
import { BASE_FACTOR, BORROW_MAX_SCALE, formatValue, MAX_UINT256, takePercentage } from '@helpers/numbers';
import { isStETH } from '@helpers/steth';
import {
  Action,
  ActionType,
  BaseAssetWithAccountState,
  MarketData,
  PendingAction,
  Token,
  TokenWithAccountState,
} from '@types';

const approveAssetHelperText = (symbol: string) =>
  `You need to approve Compound on the ${symbol} contract before you can use this asset. You only need to do this once.`;
const CONFIRM_BUTTON_TEXT_APPROVE = 'Approve & Add';
const UPDATE_ALLOWANCE_STRING =
  'This amount exceeds the allowance you previously set for this asset. You will be asked to approve an increase when you add this action.';

type ActionInputViewProps = {
  actions: Action[];
  baseAsset: BaseAssetWithAccountState;
  collateralAssets: TokenWithAccountState[];
  initialValue?: [string, boolean];
  market: MarketData;
  pendingAction: PendingAction;
  onCancel: () => void;
  onConfirm: (amount: bigint, description: string) => void;
  setPendingActionAmount: (amount?: bigint) => void;
};

const ActionInputView = ({
  actions,
  baseAsset,
  collateralAssets,
  initialValue,
  pendingAction,
  market,
  onCancel,
  setPendingActionAmount,
  onConfirm,
}: ActionInputViewProps) => {
  const [initialValueString, initialMaxClicked] = initialValue === undefined ? ['', false] : initialValue;
  const inputEl = useRef<HTMLInputElement>(null);
  const [maxClicked, setMaxClicked] = useState(initialMaxClicked);
  const [inputValue, setInput] = useState(initialValueString);

  const focus = () => {
    setTimeout(() => {
      inputEl.current?.focus();
    }, 100);
  };

  useEffect(() => {
    focus();
  }, []);

  useEffect(() => {
    if (initialValue !== undefined) {
      const [value, max] = initialValue;
      setInput(value);
      setMaxClicked(max);
    } else {
      setInput('');
      setMaxClicked(false);
    }
    focus();
  }, [pendingAction[0], pendingAction[1].address]);

  const {
    asset,
    title,
    modifier,
    actionHintString,
    titleAdditionalContent,
    inputFontSize,
    inputDisabled,
    maxButtonDisabled,
    sanitizedInputValue,
    availableAmount,
    confirmButtonDisabled,
    confirmButtonText,
    onConfirmButtonClicked,
    onInputChange,
    onMaxButtonClicked,
  } = getContent(
    actions,
    baseAsset,
    collateralAssets,
    pendingAction,
    inputValue,
    setInput,
    maxClicked,
    isUnwrappedCollateralAsset(market.chainInformation, pendingAction[1].address),
    setMaxClicked,
    setPendingActionAmount,
    onConfirm
  );

  return (
    <div className={`action-input-view action-input-view--${modifier} L2`}>
      <div className="action-input-view__title">
        <label className="label">{title}</label>
        {titleAdditionalContent !== undefined && (
          <label className={`label text-color--2`}>{titleAdditionalContent}</label>
        )}
      </div>
      <div className="action-input-view__input-row">
        <input
          className="action-input-view__input"
          placeholder="0"
          style={{ fontSize: inputFontSize }}
          value={sanitizedInputValue}
          onChange={onInputChange}
          autoComplete="off"
          ref={inputEl}
          disabled={inputDisabled}
        />
        <button
          className="button button--small"
          disabled={maxButtonDisabled}
          onClick={() => {
            onMaxButtonClicked();
          }}
        >
          Max
        </button>
      </div>
      <div className="action-input-view__detail-row">
        <div className={`asset asset--${assetIconForAssetSymbol(asset.symbol)}`}></div>
        <p className="L4 meta">{availableAmount} Available</p>
      </div>
      {actionHintString !== undefined && (
        <div className="action-input-view__hint-row">
          <p className="L4 meta text-color--2">{actionHintString}</p>
        </div>
      )}
      <div className="action-input-view__buttons">
        <button
          className="button"
          onClick={() => {
            onCancel();
          }}
        >
          Cancel
        </button>
        <button
          className="button"
          disabled={confirmButtonDisabled}
          onClick={() => {
            onConfirmButtonClicked();
          }}
        >
          {confirmButtonText}
        </button>
      </div>
    </div>
  );
};

type Content = {
  asset: Token;
  title: string;
  modifier: string;
  actionHintString?: string;
  titleAdditionalContent?: string;
  inputFontSize: string;
  inputDisabled: boolean;
  maxButtonDisabled: boolean;
  sanitizedInputValue: string;
  availableAmount: string;
  confirmButtonDisabled: boolean;
  confirmButtonText: string;
  onConfirmButtonClicked: () => void;
  onInputChange: ChangeEventHandler<HTMLInputElement>;
  onMaxButtonClicked: () => void;
};

function getContent(
  actions: Action[],
  baseAssetPre: BaseAssetWithAccountState,
  collateralAssets: TokenWithAccountState[],
  pendingAction: PendingAction,
  inputValue: string,
  setInput: Dispatch<string>,
  maxClicked: boolean,
  unwrappedCollateralAsset: boolean,
  setMaxClicked: Dispatch<boolean>,
  setPendingActionAmount: (amount?: bigint) => void,
  onConfirm: (amount: bigint, description: string) => void
): Content {
  const [actionType, asset] = pendingAction;
  let title: string;
  let modifier: string;
  let titleAdditionalContent: string | undefined;
  let actionHintString: string | undefined;
  let availableAmount: string;
  let confirmButtonDisabled = true;
  const inputDisabled = false;
  const maxButtonDisabled = false;
  let onConfirmButtonClicked: () => void = noop;
  let onInputChange: ChangeEventHandler<HTMLInputElement> = noop;
  let onMaxButtonClicked: () => void = noop;
  const editActionIndex = actions.findIndex(
    (action) => pendingAction !== undefined && isSameAction(pendingAction, action)
  );
  let confirmButtonText: string = editActionIndex !== -1 ? 'Update Action' : 'Add Action';
  const actionsToUse = editActionIndex === -1 ? actions : actions.slice(0, editActionIndex);
  const updatedDataPostActions = calculateUpdatedBalances(baseAssetPre, collateralAssets, actionsToUse);
  const { baseAsset } = updatedDataPostActions;

  let maybeBigIntInputValue: bigint | undefined;
  const sanitizedInputValue = sanitizeInputValue(inputValue, asset.decimals);

  const _validateAmount = (amount: bigint) => {
    const isValid = validateAddingAction(
      baseAssetPre,
      collateralAssets,
      actionsToUse,
      getActionFromPendingAction(pendingAction, amount)
    );

    if (isValid !== 'ok') {
      modifier = 'error';
      titleAdditionalContent = isValid[1];
    } else {
      confirmButtonDisabled = false;
    }

    return {
      modifier,
      titleAdditionalContent,
      confirmButtonDisabled,
    };
  };

  switch (actionType) {
    case ActionType.Borrow: {
      maybeBigIntInputValue = pendingAction[2];

      const borrowBalance = baseAsset.balance < 0n ? -baseAsset.balance : 0n;

      title = `Borrow ${baseAsset.symbol}`;
      modifier = 'borrow';
      const availableAmountRaw = takePercentage(baseAsset.borrowCapacity - borrowBalance, BORROW_MAX_SCALE);
      availableAmount = formatValue(baseAsset.decimals, availableAmountRaw);

      if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
        ({ modifier, titleAdditionalContent, confirmButtonDisabled } = _validateAmount(maybeBigIntInputValue));
        onConfirmButtonClicked = () => {
          if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
            onConfirm(maybeBigIntInputValue, `Borrow ${sanitizedInputValue} ${baseAsset.symbol}`);
          }
        };
      }
      onMaxButtonClicked = () => {
        // XXX: Right now, this is set as the borrow capacity without consideration for market liquidity.
        // This could mean that the user might not be able to borrow the max value, which could be weird.
        // One alternative is to cap this max amount at the market liquidity.
        setPendingActionAmount(MAX_UINT256);
        setMaxClicked(true);
        setInput(stringFromBigInt(availableAmountRaw, baseAsset.decimals));
      };
      break;
    }
    case ActionType.Supply: {
      maybeBigIntInputValue = pendingAction[2];

      title = `Supply ${baseAsset.symbol}`;
      modifier = 'supply';
      const availableAmountRaw = baseAsset.walletBalance;
      availableAmount = formatValue(baseAsset.decimals, availableAmountRaw);

      if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
        ({ modifier, titleAdditionalContent, confirmButtonDisabled } = _validateAmount(maybeBigIntInputValue));
        onConfirmButtonClicked = () => {
          if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
            const amount = maxClicked ? MAX_UINT256 : maybeBigIntInputValue;
            onConfirm(amount, `Supply ${sanitizedInputValue} ${baseAsset.symbol}`);
          }
        };
      }

      if (baseAsset.allowance === 0n) {
        actionHintString = approveAssetHelperText(baseAsset.symbol);
        confirmButtonText = CONFIRM_BUTTON_TEXT_APPROVE;
      } else if (maybeBigIntInputValue && baseAsset.allowance < maybeBigIntInputValue) {
        actionHintString = UPDATE_ALLOWANCE_STRING;
        confirmButtonText = CONFIRM_BUTTON_TEXT_APPROVE;
      }

      onMaxButtonClicked = () => {
        setPendingActionAmount(MAX_UINT256);
        setMaxClicked(true);
        setInput(stringFromBigInt(availableAmountRaw, baseAsset.decimals));
      };
      break;
    }
    case ActionType.Repay: {
      maybeBigIntInputValue = pendingAction[2];
      const borrowBalance = baseAsset.balance < 0n ? -baseAsset.balance : 0n;

      title = `Repay ${baseAsset.symbol}`;
      modifier = 'repay';
      const availableAmountRaw = borrowBalance > baseAsset.walletBalance ? baseAsset.walletBalance : borrowBalance;
      availableAmount = formatValue(baseAsset.decimals, availableAmountRaw);

      if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
        ({ modifier, titleAdditionalContent, confirmButtonDisabled } = _validateAmount(maybeBigIntInputValue));
        onConfirmButtonClicked = () => {
          if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
            const amount = maxClicked ? MAX_UINT256 : maybeBigIntInputValue;
            onConfirm(amount, `Repay ${sanitizedInputValue} ${baseAsset.symbol}`);
          }
        };
      }

      if (baseAsset.allowance === 0n) {
        actionHintString = approveAssetHelperText(baseAsset.symbol);
        confirmButtonText = CONFIRM_BUTTON_TEXT_APPROVE;
      } else if (maybeBigIntInputValue && baseAsset.allowance < maybeBigIntInputValue) {
        actionHintString = UPDATE_ALLOWANCE_STRING;
        confirmButtonText = CONFIRM_BUTTON_TEXT_APPROVE;
      }

      onMaxButtonClicked = () => {
        const [inputAmount, maxAmount, updateMaxClicked] =
          borrowBalance > availableAmountRaw
            ? [availableAmountRaw, availableAmountRaw, false]
            : [borrowBalance, MAX_UINT256, true];
        setPendingActionAmount(maxAmount);
        setMaxClicked(updateMaxClicked);
        setInput(stringFromBigInt(inputAmount, baseAsset.decimals));
      };
      break;
    }
    case ActionType.SupplyCollateral: {
      const collateralAsset = collateralAssets.find((asset) =>
        isSameToken(asset, pendingAction[1])
      ) as TokenWithAccountState;
      maybeBigIntInputValue = pendingAction[2];

      title = `Supply ${collateralAsset.symbol}`;
      modifier = 'supply';
      availableAmount = formatValue(collateralAsset.decimals, collateralAsset.walletBalance);

      if (isStETH(pendingAction[1].symbol) && unwrappedCollateralAsset) {
        actionHintString =
          'stETH is automatically wrapped and supplied to Compound as wstETH to enable staking rewards on protocol balances.';
      }

      if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
        ({ modifier, titleAdditionalContent, confirmButtonDisabled } = _validateAmount(maybeBigIntInputValue));
        onConfirmButtonClicked = () => {
          if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
            onConfirm(maybeBigIntInputValue, `Supply ${sanitizedInputValue} ${collateralAsset.symbol}`);
          }
        };
      }

      // TODO: update how we're storing bulkerAllowance for unwrapped assets
      // and generalize this check to any unwrapped asset that's approved to bulker
      if ((isStETH(pendingAction[1].symbol) ? collateralAsset.bulkerAllowance : collateralAsset.allowance) === 0n) {
        actionHintString = approveAssetHelperText(collateralAsset.symbol);
        confirmButtonText = CONFIRM_BUTTON_TEXT_APPROVE;
      } else if (
        maybeBigIntInputValue &&
        (isStETH(pendingAction[1].symbol) ? collateralAsset.bulkerAllowance : collateralAsset.allowance) <
          maybeBigIntInputValue
      ) {
        actionHintString = UPDATE_ALLOWANCE_STRING;
        confirmButtonText = CONFIRM_BUTTON_TEXT_APPROVE;
      }

      onMaxButtonClicked = () => {
        setPendingActionAmount(collateralAsset.walletBalance);
        setMaxClicked(true);
        setInput(stringFromBigInt(collateralAsset.walletBalance, collateralAsset.decimals));
      };
      break;
    }
    case ActionType.Withdraw: {
      maybeBigIntInputValue = pendingAction[2];
      const earnBalance = baseAsset.balance < 0n ? 0n : baseAsset.balance;

      title = `Withdraw ${baseAsset.symbol}`;
      modifier = 'withdraw';
      availableAmount = formatValue(baseAsset.decimals, earnBalance);

      if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
        ({ modifier, titleAdditionalContent, confirmButtonDisabled } = _validateAmount(maybeBigIntInputValue));
        onConfirmButtonClicked = () => {
          if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
            const amount = maxClicked ? MAX_UINT256 : maybeBigIntInputValue;
            onConfirm(amount, `Withdraw ${sanitizedInputValue} ${baseAsset.symbol}`);
          }
        };
      }
      onMaxButtonClicked = () => {
        setPendingActionAmount(MAX_UINT256);
        setMaxClicked(true);
        setInput(stringFromBigInt(earnBalance, baseAsset.decimals));
      };
      break;
    }
    case ActionType.WithdrawCollateral: {
      const collateralAsset = collateralAssets.find((asset) =>
        isSameToken(asset, pendingAction[1])
      ) as TokenWithAccountState;
      maybeBigIntInputValue = pendingAction[3];

      title = `Withdraw ${collateralAsset.symbol}`;
      modifier = 'withdraw';
      availableAmount = formatValue(collateralAsset.decimals, collateralAsset.balance);

      if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
        ({ modifier, titleAdditionalContent, confirmButtonDisabled } = _validateAmount(maybeBigIntInputValue));
        onConfirmButtonClicked = () => {
          if (maybeBigIntInputValue !== undefined && maybeBigIntInputValue > 0n) {
            onConfirm(maybeBigIntInputValue, `Withdraw ${sanitizedInputValue} ${collateralAsset.symbol}`);
          }
        };
      }
      onMaxButtonClicked = () => {
        const borrowBalance = baseAsset.balance < 0n ? -baseAsset.balance : 0n;

        const maxBorrowableBaseAmount =
          ((baseAsset.borrowCapacity - borrowBalance) * BASE_FACTOR) / collateralAsset.collateralFactor;
        const maxBorrowableCollateralAmount =
          (maxBorrowableBaseAmount * baseAsset.price * BigInt(10 ** collateralAsset.decimals)) /
          (collateralAsset.price * BigInt(10 ** baseAsset.decimals));

        setPendingActionAmount(
          maxBorrowableCollateralAmount < collateralAsset.balance
            ? maxBorrowableCollateralAmount
            : collateralAsset.balance
        );
        setInput(
          stringFromBigInt(
            maxBorrowableCollateralAmount < collateralAsset.balance
              ? maxBorrowableCollateralAmount
              : collateralAsset.balance,
            collateralAsset.decimals
          )
        );
        setMaxClicked(true);
      };
    }
  }

  const inputFontSize = getStyleFontSize(sanitizedInputValue);
  onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const sanitizedInputValue = sanitizeInputValue(e.target.value, asset.decimals);
    const caretPosition = e.target.selectionStart;
    const inputElement = e.target;
    const inputCommaCount = e.target.value.split(',').length - 1;
    const sanitizedInputCommaCount = sanitizedInputValue.split(',').length - 1;

    window.requestAnimationFrame(() => {
      if (caretPosition && inputCommaCount === sanitizedInputCommaCount + 1) {
        inputElement.selectionStart = caretPosition - 1;
        inputElement.selectionEnd = caretPosition - 1;
      } else if (caretPosition && inputCommaCount === sanitizedInputCommaCount - 1) {
        inputElement.selectionStart = caretPosition + 1;
        inputElement.selectionEnd = caretPosition + 1;
      } else {
        inputElement.selectionStart = caretPosition;
        inputElement.selectionEnd = caretPosition;
      }
    });

    setInput(e.target.value);
    setMaxClicked(false);

    setPendingActionAmount(maybeBigIntFromString(sanitizedInputValue, asset.decimals));
  };

  return {
    asset,
    title,
    modifier,
    actionHintString,
    titleAdditionalContent,
    inputFontSize,
    inputDisabled,
    maxButtonDisabled,
    sanitizedInputValue,
    availableAmount,
    confirmButtonDisabled,
    confirmButtonText,
    onConfirmButtonClicked,
    onInputChange,
    onMaxButtonClicked,
  };
}

function sanitizeInputValue(inputValue: string, assetDecimals: number): string {
  if (inputValue.length === 0) {
    return '';
  }

  const valueBefore = inputValue;
  const dotSeparator = '.';

  const indexOfDotSeparator = valueBefore.indexOf(dotSeparator);
  let wholeNumberString = valueBefore;
  if (indexOfDotSeparator > 0) {
    wholeNumberString = valueBefore.substring(0, indexOfDotSeparator);
  } else if (indexOfDotSeparator === 0) {
    wholeNumberString = '';
  }

  const wholeNumberPart = parseInt(wholeNumberString.replace(/\D/g, ''), 10) || 0;

  // Next we should try to verify the input of the fractional portion
  let decimalsSuffix = '';
  if (indexOfDotSeparator > -1 && indexOfDotSeparator < valueBefore.length - 1) {
    const decimalsString = valueBefore.substring(indexOfDotSeparator).substring(0, assetDecimals + 1);
    decimalsSuffix = dotSeparator + decimalsString.replace(/\D/g, '');
  } else if (valueBefore.endsWith(dotSeparator)) {
    decimalsSuffix = dotSeparator;
  }

  return wholeNumberString === '' ? decimalsSuffix : wholeNumberPart.toLocaleString('en') + decimalsSuffix;
}

function getStyleFontSize(inputValue: string): string {
  const threshold = 12;
  const fontDecrement = 0.2;
  const fontMinSize = 1.4;
  const startingSize = 2;

  if (inputValue.length > threshold) {
    const adjustedDecrementedValue = (inputValue.length - threshold) * fontDecrement;
    const newFontSize = Math.max(startingSize - adjustedDecrementedValue, fontMinSize);
    return `${newFontSize}rem`;
  } else {
    return `${startingSize}rem`;
  }
}

function maybeBigIntFromString(inputValue: string, precision: number): bigint | undefined {
  try {
    const sanitized = inputValue.replace(/$|,/g, '');
    const [whole, maybeDecimals] = sanitized.split('.');

    const wholeNumber = BigInt(whole) * BigInt(10 ** precision);
    const decimals = maybeDecimals
      ? BigInt(maybeDecimals) * BigInt(10 ** (precision - maybeDecimals.length))
      : BigInt(0);

    return wholeNumber + decimals;
  } catch (e) {
    return undefined;
  }
}

export function stringFromBigInt(inputValue: bigint, precision: number): string {
  // Note: We purposely avoid ever converting to a number because the conversion
  // can be lossy
  const scale = BigInt(10 ** precision);
  const integerValue = (inputValue / scale).toString();
  const fractionalValue = (inputValue % scale).toString();

  // Pad leading zeroes onto fractional value
  const numLeadingZeroesForFractional = precision - fractionalValue.length;
  const leadingZeroes = '0'.repeat(numLeadingZeroesForFractional);

  const decimalValue = integerValue.toString() + '.' + leadingZeroes + fractionalValue.toString();
  // Remove trailing 0's and decimals
  return decimalValue.replace(/0+$/g, '').replace(/\.$/g, '');
}

export default ActionInputView;

import { ReactNode, useContext, useEffect, useState } from 'react';

import { isUnwrappedCollateralAsset } from '@constants/chains';
import { getActionQueueContext } from '@contexts/ActionQueueContext';
import RewardsStateContext from '@contexts/RewardsStateContext';
import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import {
  isSameToken,
  calculateUpdatedBalances,
  getActionFromPendingAction,
  sanitizedAmountForAction,
} from '@helpers/actions';
import { arrayPartition } from '@helpers/functions';
import { getKeyForActions, PreEstimatedAction } from '@helpers/gasEstimator';
import { DEFAULT_MARKET } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { getRewardsForSelectedMarket } from '@helpers/rewards';
import { isStETH, isWrappedStETH } from '@helpers/steth';
import { Theme } from '@hooks/useThemeManager';
import { AddTransaction } from '@hooks/useTransactionManager';
import { useWriteCometState, WriteCometState } from '@hooks/useWriteCometState';
import {
  Action,
  ActionModalBulker,
  ActionModalBulkerApprove,
  ActionModalState,
  ActionType,
  BaseAssetWithAccountState,
  CometState,
  MarketDataLoaded,
  ModalType,
  PendingAction,
  ProtocolAndAccountState,
  SelectedMarketData,
  StateType,
  Token,
  TokenWithAccountState,
  Transaction,
} from '@types';

import ActionModal from './components/ActionModal';
import AssetRow from './components/AssetRow';
import Masthead, { MastheadState } from './components/Masthead';
import PositionCard, { PositionCardState } from './components/PositionCard';

const sortTokensAlphabetically = (a: Token, b: Token): number => (a.name > b.name ? 1 : a.name === b.name ? 0 : -1);

type HomeProps = {
  transactions: Transaction[];
  web3: Web3;
  selectedMarketData: SelectedMarketData;
  cometState: CometState;
  addTransaction: AddTransaction;
  switchWriteNetwork: (chainId: number) => Promise<boolean>;
  estimatedGasMap: Map<string, number>;
  theme: Theme;
};

const Home = ({
  transactions,
  web3,
  cometState: state,
  addTransaction,
  switchWriteNetwork,
  estimatedGasMap,
  theme,
}: HomeProps) => {
  // when V2 market was selected from market page and open up a new window default dashboard with default market
  const { selectedMarket, selectMarket } = useContext(getSelectedMarketContext());

  // We use a useEffect here to prevent infinite renders by the state update in selectMarket
  useEffect(() => {
    if (selectedMarket[0] === 'hydrated' && selectedMarket[1].baseAsset.symbol == 'Compound V2') {
      selectMarket(DEFAULT_MARKET);
    }
  }, [selectedMarket[0], selectedMarket[1]?.baseAsset?.symbol]);

  const rewards = useContext(RewardsStateContext);
  const writeState = useWriteCometState(web3, addTransaction);
  const { addOrUpdateAction, clearActions, getActions, getPendingAction, removeAction, setPendingAction } = useContext(
    getActionQueueContext()
  );

  const [actionModalState, setActionModalState] = useState<ActionModalState>(undefined);
  const [compare, setCompare] = useState(false);
  const [cometState] = state;

  let assetRows: ReactNode[];
  let otherAssetRows: ReactNode[] = [];
  let mastheadState: MastheadState;
  let positionCardState: PositionCardState;
  let isBulkerAllowed = false;
  let borrowRewardsAPR: bigint | undefined, earnRewardsAPR: bigint | undefined, rewardsAsset: Token | undefined;
  const rewardsState = getRewardsForSelectedMarket(rewards, selectedMarket);
  if (rewardsState !== undefined) {
    borrowRewardsAPR = rewardsState.borrowRewardsAPR;
    earnRewardsAPR = rewardsState.earnRewardsAPR;
    rewardsAsset = rewardsState.rewardAsset;
  }

  if (cometState === StateType.Loading) {
    mastheadState = [StateType.Loading];
    assetRows = [0, 0, 0, 0, 0, 0].map((_, index) => <AssetRow key={index} state={[StateType.Loading]} />);
    positionCardState = [StateType.Loading];
  } else if (cometState === StateType.NoWallet) {
    const { baseAsset, borrowAPR, collateralAssets, earnAPR } = state[1];

    mastheadState = [StateType.NoWallet, { baseAsset, earnAPR }];
    assetRows = collateralAssets
      .sort(sortTokensAlphabetically)
      .map((token, index) => <AssetRow key={index} state={[StateType.NoWallet, { asset: token }]} />);
    positionCardState = [
      StateType.NoWallet,
      {
        baseAsset,
        borrowAPR,
        borrowRewardsAPR,
        earnAPR,
        earnRewardsAPR,
        rewardsAsset,
        theme,
      },
    ];
  } else {
    const market = selectedMarket[1] as MarketDataLoaded; // It must be loaded if in StateType.Hydrated
    const { baseAsset, borrowAPR, collateralAssets, collateralValue, earnAPR, liquidationCapacity } = state[1];
    isBulkerAllowed = state[1].isBulkerAllowed;
    const actions = getActions(baseAsset, collateralAssets, rewards);
    const actionsForCompare = compare ? [] : actions;
    const updatedDataPostActions = calculateUpdatedBalances(baseAsset, collateralAssets, actionsForCompare);
    const pendingAction = getPendingAction(updatedDataPostActions.baseAsset, updatedDataPostActions.collateralAssets);

    const onRequestClose = () => setActionModalState(undefined);
    const submitBulkerAction = () => {
      const description = `${actions.length} Action${actions.length > 1 ? 's' : ''}`;
      const estimatedGasLimit = estimatedGasMap.get(getKeyForActions(actions)) || 0;
      writeState.invokeBulker(market, actions, baseAsset, collateralAssets, description, estimatedGasLimit, () => {
        setPendingAction(undefined);
        clearActions();
        setActionModalState(undefined);
      });
      setActionModalState(
        actionModalStateBulker(market, transactions, actions, baseAsset, collateralAssets, onRequestClose)
      );
    };

    const submitSingleAction = (singleAction: Action) => {
      const [actionType, assetInfo, amount] = singleAction;

      const submitSingleActionCallback = () => {
        setPendingAction(undefined);
        clearActions();
        setActionModalState(undefined);
      };

      const estimatedGasLimit = estimatedGasMap.get(getKeyForActions([singleAction])) || 0;

      switch (actionType) {
        case ActionType.Repay:
          writeState.supply(
            market,
            assetInfo.address,
            amount,
            `Repay ${assetInfo.name}`,
            estimatedGasLimit,
            submitSingleActionCallback
          );
          break;
        case ActionType.Supply: {
          const amount = sanitizedAmountForAction(baseAsset, collateralAssets, [], singleAction);
          writeState.supply(
            market,
            assetInfo.address,
            amount,
            `Supply ${assetInfo.name}`,
            estimatedGasLimit,
            submitSingleActionCallback
          );
          break;
        }
        case ActionType.SupplyCollateral:
          writeState.supply(
            market,
            assetInfo.address,
            amount,
            `Supply ${assetInfo.name}`,
            estimatedGasLimit,
            submitSingleActionCallback
          );
          break;
        case ActionType.Borrow: {
          const amount = sanitizedAmountForAction(baseAsset, collateralAssets, [], singleAction);
          writeState.withdraw(
            market,
            assetInfo.address,
            amount,
            `Borrow ${assetInfo.name}`,
            estimatedGasLimit,
            submitSingleActionCallback
          );
          break;
        }
        case ActionType.Withdraw:
        case ActionType.WithdrawCollateral:
          writeState.withdraw(
            market,
            assetInfo.address,
            amount,
            `Withdraw ${assetInfo.name}`,
            estimatedGasLimit,
            submitSingleActionCallback
          );
          break;
        case ActionType.ClaimRewards:
          writeState.claimReward(
            singleAction[3],
            assetInfo.address,
            `Claim Rewards`,
            estimatedGasLimit,
            submitSingleActionCallback
          );
          break;
        default:
          throw new Error(`Cannot execute ActionType ${actionType} as a single action`);
      }
    };

    const approvalTransactions = transactions.filter(
      (transaction) =>
        transaction.key !== market.bulkerAddress &&
        transaction.key !== market.marketAddress &&
        transaction.key !== market.rewardsAddress
    );
    const bulkerTransaction = transactions.find((transaction) => transaction.key === market.bulkerAddress);
    const cometTransaction = transactions.find((transaction) => transaction.key === market.marketAddress);
    const rewardTransaction = transactions.find((transaction) => transaction.key === market.rewardsAddress);
    // block the UI when there is a bulker transaction, or a single action to
    // Comet or the Rewards contract (i.e. do not block if you're just approving
    // an ERC token)
    const blockingTransaction = bulkerTransaction || cometTransaction || rewardTransaction;

    mastheadState = [
      StateType.Hydrated,
      {
        actions,
        baseAsset,
        baseAssetPost: updatedDataPostActions.baseAsset,
        borrowAPR,
        borrowRewardsAPR,
        collateralAssets,
        collateralValue,
        collateralValuePost: updatedDataPostActions.collateralValue,
        compare,
        earnAPR,
        earnRewardsAPR,
        liquidationCapacity,
        liquidationCapacityPost: updatedDataPostActions.liquidationCapacity,
        pendingAction,
        rewardsAsset,
        theme,
        transaction: blockingTransaction,
        onWithdrawAction: (pendingAction?: PendingAction) => {
          setPendingAction(pendingAction);
        },
        onSupplyAction: (pendingAction?: PendingAction) => {
          if (web3.read.chainId !== undefined && web3.write.chainId !== undefined) {
            setPendingAction(pendingAction);
            setActionModalState(undefined);
          }
        },
        setCompare,
      },
    ];
    positionCardState = [
      StateType.Hydrated,
      {
        actions,
        approvalTransactions,
        baseAsset,
        borrowAPR,
        borrowRewardsAPR,
        baseAssetPost: updatedDataPostActions.baseAsset,
        collateralAssets,
        collateralValue: collateralValue,
        collateralValuePost: updatedDataPostActions.collateralValue,
        earnAPR,
        earnRewardsAPR,
        liquidationCapacity: liquidationCapacity,
        liquidationCapacityPost: updatedDataPostActions.liquidationCapacity,
        pendingAction,
        rewardsAsset,
        theme,
        transaction: blockingTransaction,
        onClearClicked: () => {
          clearActions();
        },
        onCompareClicked: () => {
          setCompare(!compare);
        },
        onDeleteAction: (action: Action) => {
          removeAction(action);
        },
        onDripClicked: () => {
          writeState.drip(market, baseAsset.address);
        },
        onSelectAction: (action: Action) => {
          setPendingAction(getPendingActionFromAction(action, updatedDataPostActions.baseAsset));
        },
        onPendingActionCancel: () => {
          setPendingAction(undefined);
        },
        onPendingActionConfirm: (amount: bigint) => {
          if (pendingAction !== undefined) {
            const action = getActionFromPendingAction(pendingAction, amount);
            const confirmAction = () => {
              setPendingAction(undefined);
              addOrUpdateAction(action);
            };
            const asset = action[1] as BaseAssetWithAccountState | TokenWithAccountState;
            const actionType = action[0] as ActionType;
            if (
              ([ActionType.Supply, ActionType.SupplyCollateral, ActionType.Repay].includes(actionType) &&
                !isStETH(asset.symbol) &&
                asset.allowance < amount) ||
              (isStETH(asset.symbol) && asset.bulkerAllowance < amount)
            ) {
              if (web3.read.chainId && web3.write.chainId !== web3.read.chainId) {
                switchWriteNetwork(web3.read.chainId);
              } else {
                let spender = market.marketAddress;
                const assetAddress = asset.address;
                if (isStETH(asset.symbol) && isUnwrappedCollateralAsset(market.chainInformation, assetAddress)) {
                  spender = market.bulkerAddress;
                }
                const approveGasLimit = estimatedGasMap.get(PreEstimatedAction.Approve) || 0;
                writeState.approve(spender, assetAddress, `Enable ${asset.symbol}`, approveGasLimit);
                confirmAction();
              }
            } else {
              confirmAction();
            }
          }
        },
        onPendingActionUpdateAmount: (amount?: bigint) => {
          if (pendingAction !== undefined) {
            setPendingAction(getPendingActionWithUpdatedAmount(pendingAction, amount));
          }
        },
        onSubmitClicked: () => {
          setPendingAction(undefined);

          if (web3.read.chainId !== undefined && web3.write.chainId !== undefined) {
            if (web3.write.chainId !== web3.read.chainId) {
              switchWriteNetwork(web3.read.chainId);
            } else {
              const nativeTokenSymbol = market.chainInformation.nativeToken.symbol;
              const actionAssetSymbol = actions[0][1].symbol;

              if (actions.length === 1 && actionAssetSymbol !== nativeTokenSymbol && actionAssetSymbol !== 'stETH') {
                // don't use bulker if you're only taking a single action (that
                // doesn't involve wrapping Ether or stETH)
                submitSingleAction(actions[0]);
              } else if (!isBulkerAllowed) {
                setActionModalState(
                  actionModalStateBulkerApprove(
                    market,
                    state[1],
                    transactions,
                    writeState,
                    estimatedGasMap,
                    onRequestClose,
                    submitBulkerAction
                  )
                );
              } else {
                submitBulkerAction();
              }
            }
          }
        },
      },
    ];

    const [unwrappedAdditionalCollateralAssets, onlyActualCollateralAssets] = arrayPartition(
      collateralAssets,
      (asset) => isUnwrappedCollateralAsset(market.chainInformation, asset.address)
    );

    const positiveBalanceAssets = onlyActualCollateralAssets
      .filter((asset) => asset.balance > 0n)
      .sort(sortTokensAlphabetically);
    const zeroProtocolBalanceAssets = onlyActualCollateralAssets
      .filter((asset) => asset.balance === 0n && asset.walletBalance > 0n)
      .sort(sortTokensAlphabetically);
    const zeroBalanceAssets = onlyActualCollateralAssets
      .filter((asset) => asset.balance === 0n && asset.walletBalance === 0n)
      .sort(sortTokensAlphabetically);

    assetRows = [...positiveBalanceAssets, ...zeroProtocolBalanceAssets, ...zeroBalanceAssets].map((token, index) => {
      const action = actions.find((action) => action[0] !== ActionType.ClaimRewards && isSameToken(action[1], token));
      let displayAction: Action | undefined;
      if (action !== undefined) {
        let actionAmount = action[2];
        if (action[0] === ActionType.WithdrawCollateral && action[2] === MAX_UINT256) {
          actionAmount = token.balance;
        }
        displayAction = [action[0], action[1], actionAmount] as Action;
      }
      const pendingActionOrUndefined =
        pendingAction !== undefined && isSameToken(pendingAction[1], token) ? pendingAction : undefined;

      const stEthWrapSupplyAction = actions.find(
        (action) =>
          action[0] === ActionType.SupplyCollateral && isStETH(action[1].symbol) && isWrappedStETH(token.symbol)
      );
      return (
        <AssetRow
          key={index}
          state={[
            StateType.Hydrated,
            {
              action: displayAction,
              asset: token,
              baseAsset,
              pendingAction: pendingActionOrUndefined,
              transaction: blockingTransaction,
              unwrappedAssetSupplyAction: stEthWrapSupplyAction,
              onDripClicked: () => {
                writeState.drip(market, token.address);
              },
              onCancelClicked: () => {
                if (pendingActionOrUndefined) {
                  setPendingAction(undefined);
                  action && removeAction(action);
                }
              },
              onEditClicked: () => {
                if (action) {
                  setPendingAction(getPendingActionFromAction(action, updatedDataPostActions.baseAsset));
                }
              },
              onSupplyClicked: () => {
                if (web3.read.chainId !== undefined && web3.write.chainId !== undefined) {
                  setPendingAction([ActionType.SupplyCollateral, token, undefined]);
                  setActionModalState(undefined);
                }
              },
              onWithdrawClicked: () => {
                setPendingAction([ActionType.WithdrawCollateral, token, updatedDataPostActions.baseAsset, undefined]);
              },
            },
          ]}
        />
      );
    });

    otherAssetRows = unwrappedAdditionalCollateralAssets.map((token, index) => {
      const action = actions.find((action) => action[0] !== ActionType.ClaimRewards && isSameToken(action[1], token));
      let displayAction: Action | undefined;
      if (action !== undefined) {
        const actionAmount = action[2];
        displayAction = [action[0], action[1], actionAmount] as Action;
      }

      const pendingActionOrUndefined =
        pendingAction !== undefined && isSameToken(pendingAction[1], token) ? pendingAction : undefined;

      const matchingWrappedAsset = isStETH(token.symbol)
        ? onlyActualCollateralAssets.find((asset) => isWrappedStETH(asset.symbol))
        : undefined;

      return (
        <AssetRow
          key={index}
          state={[
            StateType.Hydrated,
            {
              action: displayAction,
              asset: token,
              baseAsset,
              pendingAction: pendingActionOrUndefined,
              transaction: blockingTransaction,
              wrappedAsset: matchingWrappedAsset,
              onCancelClicked: () => {
                if (pendingActionOrUndefined) {
                  setPendingAction(undefined);
                  action && removeAction(action);
                }
              },
              onEditClicked: () => {
                if (action) {
                  setPendingAction(getPendingActionFromAction(action, updatedDataPostActions.baseAsset));
                }
              },
              onSupplyClicked: () => {
                if (web3.read.chainId !== undefined && web3.write.chainId !== undefined) {
                  setPendingAction([ActionType.SupplyCollateral, token, undefined]);
                  setActionModalState(undefined);
                }
              },
            },
          ]}
        />
      );
    });
  }

  return (
    <div className="page home">
      <ActionModal isBulkerAllowed={isBulkerAllowed} state={actionModalState} transactions={transactions} />
      <Masthead state={mastheadState} />
      <div className="home__content grid-container">
        <div className="home__assets grid-column--7">
          <div className="panel panel--assets">
            <div className="panel__header-row">
              <label className="L2 label text-color--2">Collateral Asset</label>
              <label className="L2 label text-color--2">Protocol Balance</label>
            </div>
            {assetRows}
          </div>
          {otherAssetRows.length > 0 && (
            <div className="panel panel--assets">
              <div className="panel__header-row">
                <label className="L2 label text-color--2">Other Assets</label>
              </div>
              <div className="panel__description">
                <p className={`L4 meta text-color--2`}>
                  Rebasing tokens are automatically wrapped when supplied to Compound to enable yield on protocol
                  balances.
                </p>
              </div>
              {otherAssetRows}
            </div>
          )}
        </div>
        <div className="grid-column--5">
          <PositionCard state={positionCardState} />
        </div>
      </div>
    </div>
  );
};

function getPendingActionFromAction(action: Action, baseAsset: BaseAssetWithAccountState): PendingAction | undefined {
  switch (action[0]) {
    case ActionType.ClaimRewards:
      return undefined;
    case ActionType.WithdrawCollateral:
      return [action[0], action[1], baseAsset, action[2]];
    default:
      return [action[0], action[1], action[2]] as PendingAction;
  }
}

function getPendingActionWithUpdatedAmount(pendingAction: PendingAction, amount?: bigint): PendingAction {
  switch (pendingAction[0]) {
    case ActionType.WithdrawCollateral:
      return [pendingAction[0], pendingAction[1], pendingAction[2], amount];
    default:
      return [pendingAction[0], pendingAction[1], amount] as PendingAction;
  }
}

function actionModalStateBulker(
  market: MarketDataLoaded,
  transactions: Transaction[],
  actions: Action[],
  baseAsset: BaseAssetWithAccountState,
  collateralAssets: TokenWithAccountState[],
  onRequestClose: () => void
): ActionModalBulker | undefined {
  const transactionPredicate = (transactions: Transaction[]) => {
    return transactions.find((transaction) => transaction.key === market.bulkerAddress);
  };

  return [
    ModalType.Bulker,
    {
      actions,
      baseAsset,
      collateralAssets,
      transactions,
      onRequestClose,
      transactionPredicate,
    },
  ];
}

function actionModalStateBulkerApprove(
  market: MarketDataLoaded,
  state: ProtocolAndAccountState,
  transactions: Transaction[],
  writeState: WriteCometState,
  estimatedGasMap: Map<string, number>,
  onRequestClose: () => void,
  onCompleteClicked: () => void
): ActionModalBulkerApprove {
  const transactionPredicate = (transactions: Transaction[]) => {
    return transactions.find((transaction) => transaction.key === market.bulkerAddress);
  };
  return [
    ModalType.BulkerApprove,
    {
      isBulkerAllowed: state.isBulkerAllowed,
      transactions,
      onActionClicked: () => {
        const allowOperatorGasLimit = estimatedGasMap.get(PreEstimatedAction.AllowOperator) || 0;
        writeState.allowOperator(market, market.bulkerAddress, 'Approve Compound III Proxy', allowOperatorGasLimit);
      },
      onCompleteClicked,
      onRequestClose,
      transactionPredicate,
    },
  ];
}

export default Home;

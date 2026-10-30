import { ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { isUnwrappedCollateralAsset } from '@constants/chains';
import { WRAPPED_MARKET_REGISTRY } from '@constants/wrappedMarkets';
import { getActionQueueContext } from '@contexts/ActionQueueContext';
import RewardsStateContext from '@contexts/RewardsStateContext';
import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import { useWrappedLending } from '@contexts/WrappedLendingContext';
import {
  ActionRules,
  isSameToken,
  calculateUpdatedBalances,
  getActionFromPendingAction,
  sanitizedAmountForAction,
} from '@helpers/actions';
import { withCometStateSource } from '@helpers/cometStateSource';
import { arrayPartition } from '@helpers/functions';
import { getKeyForActions, PreEstimatedAction } from '@helpers/gasEstimator';
import { institutionalWhitelistStatus } from '@helpers/institutionalWhitelist';
import { DEFAULT_MARKET, getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { isStETH, isWrappedStETH } from '@helpers/steth';
import { SendWithdrawnError } from '@helpers/walletErrors';
import { isDirectExecution } from '@helpers/wrappedActions';
import {
  CometStateWithMarket,
  isSameWalletSession,
  isSubmissionRefused,
  LiveSubmissionState,
  MarketIdentity,
  supplyIncentivesForRoute,
  WalletSession,
} from '@helpers/wrappedPositions';
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
import WrappedSupplyModal from './components/ActionModal/WrappedSupplyModal';
import AssetRow from './components/AssetRow';
import InstitutionalBanner from './components/InstitutionalBanner';
import Masthead, { MastheadState } from './components/Masthead';
import PositionCard, { PositionCardState } from './components/PositionCard';
import SupplyPausedBanner from './components/SupplyPausedBanner';
import WrappedPositionPanel from './components/WrappedPositionPanel';

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
  const { addOrUpdateAction, clearActions, getActions, getPendingAction, removeAction, setPendingAction } = useContext(
    getActionQueueContext()
  );

  const [compare, setCompare] = useState(false);
  const [cometState] = state;

  const wrappedLending = useWrappedLending();
  const isWrappedRoute = wrappedLending.route.kind === 'wrapped';
  const actionRules: ActionRules = { blockDirectBaseSupply: isWrappedRoute };
  const selectedMarketIdentity: MarketIdentity | undefined =
    selectedMarket[1] === undefined
      ? undefined
      : { chainId: selectedMarket[1].chainInformation.chainId, cometAddress: selectedMarket[1].marketAddress };
  // The wallet session this render's writes sign in. The callbacks made below keep it, and are
  // refused once another session is live.
  const walletSession: WalletSession = {
    account: web3.write.account,
    connector: web3.write.connector?.uid,
    chainId: web3.write.chainId,
  };
  const liveWalletSession = useRef(walletSession);
  liveWalletSession.current = walletSession;
  // The app keeps its Comet state across a change of market or account until the next read
  // arrives, including while another page is shown. So the state is labelled with the market and
  // account useCometState read it for, never with the ones selected when this page renders it.
  const cometStateMarket = useRef<CometStateWithMarket>(withCometStateSource(state));
  if (cometStateMarket.current.state !== state) {
    cometStateMarket.current = withCometStateSource(state);
  }
  // Submissions can start from a callback a dialog kept from an earlier render, so they are
  // judged by the session as it is now, not as it was when the callback was made.
  const liveSession = useRef<LiveSubmissionState>({
    route: wrappedLending.route,
    account: web3.write.account,
    selectedMarket: selectedMarketIdentity,
    comet: cometStateMarket.current,
  });
  liveSession.current = {
    route: wrappedLending.route,
    account: web3.write.account,
    selectedMarket: selectedMarketIdentity,
    comet: cometStateMarket.current,
  };
  // Review dialogs and writes belong to a visit: the account, connector, connection status, wallet
  // network and market they were made for. A change of any of them starts a new visit in the same
  // render, so a reconnect with the same account and connector does too. A callback kept from an
  // earlier visit, even one to the same account and market, starts no write. It can open or close
  // only a dialog of its own visit, which is never shown.
  const visitIdentity = [
    web3.write.account?.toLowerCase() ?? '',
    web3.write.connector?.uid ?? '',
    web3.write.status,
    web3.write.chainId ?? '',
    selectedMarketIdentity === undefined
      ? ''
      : `${selectedMarketIdentity.chainId}:${selectedMarketIdentity.cometAddress.toLowerCase()}`,
  ].join('|');
  const visit = useRef({ identity: visitIdentity, count: 0 });
  if (visit.current.identity !== visitIdentity) {
    visit.current = { identity: visitIdentity, count: visit.current.count + 1 };
  }
  const visitKey = `${visitIdentity}#${visit.current.count}`;
  const liveVisitKey = useRef(visitKey);
  liveVisitKey.current = visitKey;
  // Leaving Home also ends the visit. An unmounted Home renders no more, so its refs keep the last
  // visit forever, and Home mounted again has refs of its own that cannot end it.
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);
  const isLiveVisit = (key: string) => isMounted.current && liveVisitKey.current === key;
  // Dialogs and the position card keep the callbacks of the render that made them.
  const isFromEarlierVisit = () => !isLiveVisit(visitKey);
  // On the wrapped route, a wallet session found unusable stops direct writes as well.
  const liveWalletUnusable = useRef(false);
  liveWalletUnusable.current = wrappedLending.action.session.status === 'unusable';
  // App writes each new gas estimate into a new map, for example once the Bulker approval settles,
  // so a kept callback reads the map through this ref. App keeps the estimates for the same
  // account, connector, connection status, wallet network and market as a visit, so the map of the
  // callback's own visit is the live one.
  const liveEstimatedGasMap = useRef(estimatedGasMap);
  liveEstimatedGasMap.current = estimatedGasMap;

  // The manager reads the network and nonce, and can estimate gas, before it asks the wallet. If
  // the write's visit ends, Home unmounts or the session is found unusable in that time, the write
  // is withdrawn. Otherwise the wallet is asked to sign for a session, market or page the user has
  // left. A write the wallet was already asked for stays with the manager, which tracks it.
  const addTransactionWhileCurrent: AddTransaction = (
    key,
    description,
    trxFn,
    estimatedGas,
    trxEstimateGasFn,
    fnArgs,
    value,
    callback
  ) => {
    const visitKeyBefore = liveVisitKey.current;
    const sendWhileCurrent: typeof trxFn = (...args) =>
      isLiveVisit(visitKeyBefore) && !liveWalletUnusable.current
        ? trxFn(...args)
        : Promise.reject(new SendWithdrawnError());
    return addTransaction(key, description, sendWhileCurrent, estimatedGas, trxEstimateGasFn, fnArgs, value, callback);
  };
  const writeState = useWriteCometState(web3, addTransactionWhileCurrent);

  const [openDialog, setOpenDialog] = useState<{ key: string; state: ActionModalState }>();
  const actionModalState = openDialog?.key === visitKey ? openDialog.state : undefined;
  const setActionModalState = (dialog: ActionModalState) =>
    setOpenDialog((current) => {
      if (dialog !== undefined) return { key: visitKey, state: dialog };
      return current?.key === visitKey ? undefined : current;
    });
  // A dialog from an earlier visit is hidden in the render above and cleared here, so it does not
  // return with the session.
  useEffect(() => {
    if (openDialog !== undefined && openDialog.key !== visitKey) setOpenDialog(undefined);
  }, [openDialog, visitKey]);

  let assetRows: ReactNode[];
  let otherAssetRows: ReactNode[] = [];
  let mastheadState: MastheadState;
  let positionCardState: PositionCardState;
  let isBulkerAllowed = false;

  const whitelistStatus = institutionalWhitelistStatus(web3.read.account);

  if (cometState === StateType.Loading) {
    mastheadState = [StateType.Loading];
    assetRows = [0, 0, 0, 0, 0, 0].map((_, index) => <AssetRow key={index} state={[StateType.Loading]} />);
    positionCardState = [StateType.Loading];
  } else if (cometState === StateType.NoWallet) {
    const {
      baseAsset,
      borrowAPR,
      collateralAssets,
      earnAPR,
      borrowRewardsAPR,
      supplyRewardsAPR,
      rewardsAssetSymbol,
      isInstitutional,
      isRewardsLoading,
    } = state[1];

    const supplyIncentives = supplyIncentivesForRoute(isWrappedRoute, 0n, {
      earnRewardsAPR: supplyRewardsAPR,
      isInstitutional,
    });
    mastheadState = [StateType.NoWallet, { baseAsset, earnAPR }];
    assetRows = collateralAssets
      .sort(sortTokensAlphabetically)
      .map((token, index) => <AssetRow key={index} state={[StateType.NoWallet, { asset: token }]} />);
    positionCardState = [
      StateType.NoWallet,
      {
        baseAsset,
        borrowAPR,
        rewardsAssetSymbol,
        borrowRewardsAPR,
        earnAPR,
        earnRewardsAPR: supplyIncentives.earnRewardsAPR,
        institutionalWhitelistStatus: whitelistStatus,
        isInstitutional: supplyIncentives.isInstitutional,
        isRewardsLoading,
        theme,
      },
    ];
  } else {
    const market = selectedMarket[1] as MarketDataLoaded; // It must be loaded if in StateType.Hydrated
    const {
      baseAsset,
      borrowAPR,
      collateralAssets,
      collateralValue,
      earnAPR,
      liquidationCapacity,
      borrowRewardsAPR,
      supplyRewardsAPR,
      isInstitutional,
      rewardsAssetSymbol,
      isRewardsLoading
    } = state[1];
    isBulkerAllowed = state[1].isBulkerAllowed;
    const supplyIncentives = supplyIncentivesForRoute(isWrappedRoute, baseAsset.balance, {
      earnRewardsAPR: supplyRewardsAPR,
      isInstitutional,
    });
    // Dialogs keep the callbacks below, so they check the session when they run.
    const isBlockedOnLiveRoute = (actionsToSubmit: Action[]) =>
      liveWalletUnusable.current ||
      // A queue holding a wrapper action is refused whole, never submitted without it.
      !isDirectExecution(actionsToSubmit) ||
      isSubmissionRefused(
        liveSession.current,
        { chainId: market.chainInformation.chainId, cometAddress: market.marketAddress },
        actionsToSubmit
      ) ||
      // A kept callback writes through the session it was made in, whatever the live balances allow.
      !isSameWalletSession(walletSession, liveWalletSession.current);

    const actions = getActions(baseAsset, collateralAssets, rewards);
    const actionsForCompare = compare ? [] : actions;
    const updatedDataPostActions = calculateUpdatedBalances(baseAsset, collateralAssets, actionsForCompare);
    const pendingAction = getPendingAction(updatedDataPostActions.baseAsset, updatedDataPostActions.collateralAssets);

    const onRequestClose = () => setActionModalState(undefined);
    // The approval dialog keeps this, so it checks the session when the user clicks.
    const allowOperatorWhileCurrent: WriteCometState['allowOperator'] = async (...args) => {
      if (isFromEarlierVisit() || liveWalletUnusable.current) return;
      return writeState.allowOperator(...args);
    };
    const submitBulkerAction = () => {
      if (isFromEarlierVisit()) return;
      if (isBlockedOnLiveRoute(actions)) {
        setActionModalState(undefined);
        return;
      }
      const description = `${actions.length} Action${actions.length > 1 ? 's' : ''}`;
      const estimatedGasLimit = liveEstimatedGasMap.current.get(getKeyForActions(actions)) || 0;
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
      if (isFromEarlierVisit()) return;
      if (isBlockedOnLiveRoute([singleAction])) {
        setActionModalState(undefined);
        return;
      }
      const [actionType, assetInfo, amount] = singleAction;

      const submitSingleActionCallback = () => {
        setPendingAction(undefined);
        clearActions();
        setActionModalState(undefined);
      };

      const estimatedGasLimit = liveEstimatedGasMap.current.get(getKeyForActions([singleAction])) || 0;

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
        earnRewardsAPR: supplyIncentives.earnRewardsAPR,
        isInstitutional: supplyIncentives.isInstitutional ?? false,
        isDirectBaseSupplyBlocked: isWrappedRoute,
        institutionalWhitelistStatus: whitelistStatus,
        liquidationCapacity,
        liquidationCapacityPost: updatedDataPostActions.liquidationCapacity,
        pendingAction,
        rewardsAssetSymbol,
        theme,
        transaction: blockingTransaction,
        onWithdrawAction: (pendingAction?: PendingAction) => {
          setPendingAction(pendingAction);
        },
        onSupplyAction: (pendingAction?: PendingAction) => {
          if (isWrappedRoute && pendingAction?.[0] === ActionType.Supply) return;
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
        earnRewardsAPR: supplyIncentives.earnRewardsAPR,
        isInstitutional: supplyIncentives.isInstitutional,
        institutionalWhitelistStatus: whitelistStatus,
        actionRules,
        rewardsAssetSymbol,
        liquidationCapacity: liquidationCapacity,
        liquidationCapacityPost: updatedDataPostActions.liquidationCapacity,
        pendingAction,
        theme,
        isRewardsLoading,
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
          if (isFromEarlierVisit()) return;
          writeState.drip(market, baseAsset.address);
        },
        onSelectAction: (action: Action) => {
          setPendingAction(getPendingActionFromAction(action, updatedDataPostActions.baseAsset));
        },
        onPendingActionCancel: () => {
          setPendingAction(undefined);
        },
        onPendingActionConfirm: (amount: bigint) => {
          // The amount form keeps this callback. One from an earlier visit asks for no approval or
          // network switch, and queues nothing.
          if (isFromEarlierVisit()) return;
          if (pendingAction !== undefined) {
            const action = getActionFromPendingAction(pendingAction, amount);
            // The form already refuses a base supply on the wrapped route. Refusing it here as well
            // keeps an approval for it from being requested.
            if (isWrappedRoute && action[0] === ActionType.Supply) return;
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
                if (liveWalletUnusable.current) return;
                const approveGasLimit = liveEstimatedGasMap.current.get(PreEstimatedAction.Approve) || 0;
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
          if (isFromEarlierVisit()) return;
          setPendingAction(undefined);
          if (isBlockedOnLiveRoute(actions)) return;

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
                    { ...writeState, allowOperator: allowOperatorWhileCurrent },
                    estimatedGasMap,
                    onRequestClose,
                    submitBulkerAction,
                    () => !isSameWalletSession(walletSession, liveWalletSession.current)
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
                if (isFromEarlierVisit()) return;
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

  let wrappedPanel: ReactNode = null;
  // The direct Comet borrow a wrapped supply's dialog warns about, or undefined while unknown.
  let directBorrowBalance: bigint | undefined;
  const { route: wrappedRoute, action: wrappedAction } = wrappedLending;
  if (wrappedRoute.kind === 'wrapped') {
    // The rate and price belong to the market whose Comet state this is, which can still be
    // the previous market for a render after a switch.
    const cometMarket = cometStateMarket.current.market;
    const isCometStateForRoute =
      cometMarket !== undefined &&
      cometMarket.chainId === wrappedRoute.chainId &&
      cometMarket.cometAddress.toLowerCase() === wrappedRoute.cometAddress.toLowerCase();
    const cometForRoute = cometState !== StateType.Loading && isCometStateForRoute ? state[1] : undefined;
    // The borrow comes from the Comet state read for this market and the connected account only.
    const cometAccount = cometStateMarket.current.account;
    if (
      state[0] === StateType.Hydrated &&
      isCometStateForRoute &&
      cometAccount !== undefined &&
      cometAccount.toLowerCase() === web3.write.account?.toLowerCase()
    ) {
      const { balance } = state[1].baseAsset;
      directBorrowBalance = balance < 0n ? -balance : 0n;
    }
    // Only the loaded figures need the Comet state. A read failure or an unavailable wrapper
    // shows at once, so its Retry or Reload is never hidden behind a slow Comet read.
    const position =
      wrappedLending.position.status === 'loaded' && cometForRoute === undefined
        ? { status: 'loading' as const }
        : wrappedLending.position;
    wrappedPanel = (
      <WrappedPositionPanel
        route={wrappedRoute}
        position={position}
        baseAsset={
          cometForRoute?.baseAsset ?? {
            symbol: selectedMarket[1]?.baseAsset.symbol ?? '',
            baseAssetPriceInDollars: 0n,
            balanceOfComet: 0n,
          }
        }
        earnAPR={cometForRoute?.earnAPR ?? 0n}
        session={wrappedAction.session}
        isRecoveredRequestPendingInWallet={wrappedAction.isRecoveredRequestPendingInWallet}
        canDismissRecovered={wrappedAction.canDismissRecovered}
        onDismissRecovered={wrappedAction.dismissRecovered}
        hasUnansweredWalletRequest={wrappedAction.hasUnansweredWalletRequest}
        walletRefusalMessage={wrappedAction.walletRefusalMessage}
        supply={{
          blockedReason: wrappedAction.blockedReason('supply'),
          // A callback kept from an earlier visit starts no review.
          onReview: (amount) => (isFromEarlierVisit() ? 'identity-changed' : wrappedLending.write.supply(amount)),
        }}
        onRetry={wrappedLending.retry}
      />
    );
  }

  // The supply dialog describes its draft's own market. A completed or stopped draft stays on
  // screen after the user selects another market.
  const { state: wrappedActionState } = wrappedAction;
  const draftIdentity =
    'draft' in wrappedActionState
      ? wrappedActionState.draft.identity
      : 'identity' in wrappedActionState
      ? wrappedActionState.identity
      : undefined;
  const draftLookup =
    draftIdentity === undefined
      ? undefined
      : WRAPPED_MARKET_REGISTRY.lookup(draftIdentity.chainId, draftIdentity.cometAddress);

  return (
    <div className="page home">
      <ActionModal isBulkerAllowed={isBulkerAllowed} state={actionModalState} transactions={transactions} />
      <WrappedSupplyModal
        state={wrappedActionState}
        symbol={
          draftIdentity === undefined
            ? ''
            : getMarket(draftIdentity.chainId, draftIdentity.cometAddress)?.baseAsset.symbol ?? ''
        }
        decimals={draftLookup?.status === 'valid' ? draftLookup.market.baseDecimals : undefined}
        directBorrowBalance={directBorrowBalance}
        onConfirm={wrappedAction.confirm}
        onClose={wrappedAction.discard}
      />
      <SupplyPausedBanner />
      <InstitutionalBanner market={selectedMarket[1]} />
      <Masthead state={mastheadState} />
      {wrappedPanel}
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
  onCompleteClicked: () => void,
  isFromAnotherWalletSession: () => boolean
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
        // The dialog keeps this callback, which asks the session that opened it to sign.
        if (isFromAnotherWalletSession()) {
          onRequestClose();
          return;
        }
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

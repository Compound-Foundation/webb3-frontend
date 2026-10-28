import { ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { CHAINS, isUnwrappedCollateralAsset } from '@constants/chains';
import { getActionQueueContext } from '@contexts/ActionQueueContext';
import RewardsStateContext from '@contexts/RewardsStateContext';
import { getSelectedMarketContext } from '@contexts/SelectedMarketContext';
import type { Web3 } from '@contexts/Web3Context';
import {
  queueScope,
  SentWrapperAction,
  SubmissionRecord,
  submissionScope,
  useWrappedLending,
} from '@contexts/WrappedLendingContext';
import {
  ActionRules,
  isSameToken,
  calculateUpdatedBalances,
  getActionFromPendingAction,
  sanitizedAmountForAction,
} from '@helpers/actions';
import { arrayPartition } from '@helpers/functions';
import { getKeyForActions, PreEstimatedAction } from '@helpers/gasEstimator';
import { institutionalWhitelistStatus } from '@helpers/institutionalWhitelist';
import { WriteBlockReason } from '@helpers/lendingRoute';
import { DEFAULT_MARKET } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import {
  isWrapperRouted,
  planQueuedExecution,
  QueuedExecutionPlan,
  QueuedWrapperAction,
  wrappedEntryBlockLabel,
} from '@helpers/queuedExecution';
import { isStETH, isWrappedStETH } from '@helpers/steth';
import { SendWithdrawnError } from '@helpers/walletErrors';
import { isDirectExecution, WrappedActionType, WrappedExecutionError } from '@helpers/wrappedActions';
import {
  CometStateWithMarket,
  isSubmissionRefused,
  LiveSubmissionState,
  MarketIdentity,
  supplyIncentivesForRoute,
  withWrappedSupply,
  WrappedPosition,
} from '@helpers/wrappedPositions';
import { getWithdrawalLimits, WithdrawalLimits } from '@helpers/wrappedWithdrawals';
import { Theme } from '@hooks/useThemeManager';
import { AddTransaction } from '@hooks/useTransactionManager';
import type { WrappedActionState } from '@hooks/useWrappedAction';
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
import QueuedSubmissionModal from './components/ActionModal/QueuedSubmissionModal';
import AssetRow from './components/AssetRow';
import InstitutionalBanner from './components/InstitutionalBanner';
import Masthead, { MastheadNotice, MastheadState } from './components/Masthead';
import PositionCard, { PositionCardNotice, PositionCardState } from './components/PositionCard';

const sortTokensAlphabetically = (a: Token, b: Token): number => (a.name > b.name ? 1 : a.name === b.name ? 0 : -1);

// The market and account current when Home first saw each Comet state, or no account for a state
// that was already there when Home mounted. The app keeps its Comet state while another page is
// shown, so the record outlives Home. The app replaces the state object on every read, so an old
// record is dropped with its state.
const cometStateProvenance = new WeakMap<CometState, CometStateWithMarket>();

/**
 * Whether a stopped wrapper action's last step can have executed, or can still: the wallet answered
 * with an error after it can have sent the request, the transaction was sent and can no longer be
 * followed, or another transaction took its nonce, which a sped-up copy of the same call also does.
 * A reverted step did not execute, and a refusal or a check sent nothing.
 */
function mayStillExecute(state: Extract<WrappedActionState, { phase: 'stopped' }>): boolean {
  const lastIndex = state.draft.steps.length - 1;
  const status = state.steps[lastIndex]?.status;
  return (
    state.stepIndex === lastIndex && (status === 'provider-failure' || status === 'unresolved' || status === 'replaced')
  );
}

/** What the masthead says about a wrapped position it cannot show. */
function unavailableNotice(reason: WriteBlockReason, reload: () => void): MastheadNotice {
  switch (reason) {
    case 'validation-failed':
      return {
        message: 'This market could not be checked for your wallet. Reload the page to try again.',
        actionLabel: 'Reload',
        onAction: reload,
      };
    case 'not-canonical':
    case 'asset-mismatch':
    case 'metadata-mismatch':
      return {
        message: "This market's wrapper did not pass its on-chain check, so supply and withdrawal are turned off.",
      };
    case 'missing-mapping':
    case 'invalid-mapping':
      return { message: 'Supply and withdrawal are not set up correctly for this market, so they are turned off.' };
    default:
      return { message: 'Your supplied balance is not available right now.' };
  }
}

/** What a full or partial withdrawal through the wrapper can pay now, or undefined if it cannot be worked out. */
function wrappedWithdrawalLimits(position: WrappedPosition, marketCash: bigint): WithdrawalLimits | undefined {
  const { shares, baseDecimals, isWithdrawPaused, snapshot } = position;
  try {
    return getWithdrawalLimits({ ...snapshot, shares, baseDecimals, isWithdrawPaused, cometCash: marketCash });
  } catch {
    return undefined;
  }
}

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
  const { route: lendingRoute, action: wrappedAction } = wrappedLending;
  const isWrappedRoute = lendingRoute.kind === 'wrapped';
  // Callbacks kept from an earlier render start wrapper actions through the live lending state.
  const liveWrappedLending = useRef(wrappedLending);
  liveWrappedLending.current = wrappedLending;
  const liveActionRules = useRef<ActionRules>({});
  const selectedMarketIdentity: MarketIdentity | undefined =
    selectedMarket[1] === undefined
      ? undefined
      : { chainId: selectedMarket[1].chainInformation.chainId, cometAddress: selectedMarket[1].marketAddress };
  // Comet state names no market or account, and it trails a change of either by a render. Each
  // new state is recorded with the market and account current when it arrived, so a stale one
  // keeps the old ones.
  const cometStateMarket = useRef<CometStateWithMarket>({
    market: selectedMarketIdentity,
    account: web3.read.account,
    state,
  });
  if (cometStateMarket.current.state !== state) {
    cometStateMarket.current = { market: selectedMarketIdentity, account: web3.read.account, state };
  }
  // On the wrapped route, the wrapped position joins a Comet state's balances only if the state is
  // known to be the connected account's. The app keeps its Comet state while another page is shown,
  // and after an account switch it keeps the previous account's state until the new read arrives,
  // so the label above can name an account the state was not read for. A state that arrives while
  // the dashboard is mounted is recorded with the account then connected, and the record outlives
  // the dashboard. A hydrated state already there when the dashboard mounts, and never recorded, has
  // an unknown account: the dashboard shows the direct balance alone, and offers no wrapped
  // withdrawal, until the next Comet read, at most the timed refresh later. Submissions are judged
  // by the label above, as before.
  const lastSeenCometState = useRef<CometState>();
  if (lastSeenCometState.current !== state) {
    if (!cometStateProvenance.has(state)) {
      const isRetainedFromBeforeMount = lastSeenCometState.current === undefined && state[0] === StateType.Hydrated;
      cometStateProvenance.set(state, {
        market: selectedMarketIdentity,
        account: isRetainedFromBeforeMount ? undefined : web3.read.account,
        state,
      });
    }
    lastSeenCometState.current = state;
  }
  const verifiedCometAccount = cometStateProvenance.get(state)?.account;
  const isCometStateVerifiedForAccount =
    verifiedCometAccount !== undefined && verifiedCometAccount.toLowerCase() === web3.write.account?.toLowerCase();
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
  const visitIdentity = submissionScope(web3.write, selectedMarketIdentity);
  const visit = useRef({ identity: visitIdentity, count: 0 });
  if (visit.current.identity !== visitIdentity) {
    visit.current = { identity: visitIdentity, count: visit.current.count + 1 };
  }
  const visitKey = `${visitIdentity}#${visit.current.count}`;
  const liveVisitKey = useRef(visitKey);
  liveVisitKey.current = visitKey;
  // Dialogs and the position card keep the callbacks of the render that made them.
  const isFromEarlierVisit = () => liveVisitKey.current !== visitKey;
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
  // the write's visit ends or the session is found unusable in that time, the write is withdrawn.
  // Otherwise the wallet is asked to sign for a session or market the user has left.
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
      liveVisitKey.current === visitKeyBefore && !liveWalletUnusable.current
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

  // A queue submitted through the wrapper belongs to its scope: the account, connector, connection
  // status, wallet network and market. App keeps it beside the wrapper action lifecycle, so it
  // survives a visit to another page. A change of scope drops it in the same render, and the
  // lifecycle discards its draft for the same change.
  const submissionStore = wrappedLending.submission;
  const submission = submissionStore.record?.scope === visitIdentity ? submissionStore.record : undefined;
  const setSubmissionRecord = (record: SubmissionRecord | undefined) => submissionStore.setRecord(() => record);
  const liveSubmission = useRef(submission);
  liveSubmission.current = submission;
  // The wrapper action a submission started belongs to the queue's scope, which leaves out the
  // wallet's network. App follows it until its last step's outcome is known, after the submission
  // itself is dropped or closed.
  const sentScope = queueScope(web3.write, selectedMarketIdentity);
  const sent = submissionStore.sent?.scope === sentScope ? submissionStore.sent : undefined;
  const liveSent = useRef(sent);
  liveSent.current = sent;
  // While a submission is in progress, the queue it was planned from cannot change. Nor can it while
  // the wrapper action it started may still be carried out, so the action is never offered again
  // before it is known whether it executed.
  const isQueueLocked = () => liveSubmission.current !== undefined || liveSent.current !== undefined;
  // The lifecycle's state, when it belongs to this submission. Until the submission's review
  // starts, the lifecycle can still show an earlier review, which this submission never acts on.
  const lifecycleState = wrappedAction.state;
  const isSubmissionState = (() => {
    if (submission === undefined || submission.refusal !== undefined) return false;
    if (lifecycleState === submission.stateBefore) return false;
    const type = submission.wrapper.type;
    switch (lifecycleState.phase) {
      case 'idle':
        return false;
      case 'reading':
      case 'read-failed':
        return lifecycleState.identity.type === type;
      case 'discarded':
        return lifecycleState.type === type;
      default: {
        const before = submission.stateBefore;
        return (
          lifecycleState.draft.identity.type === type && !('draft' in before && before.draft === lifecycleState.draft)
        );
      }
    }
  })();
  const submissionState: WrappedActionState = isSubmissionState ? lifecycleState : { phase: 'idle' };
  // Once the wrapper action confirms, it leaves the queue. The direct actions stay until they are
  // submitted. A wrapper action that stops before its last step was sent, or is closed, stays queued.
  // One that stops at its last step in a state where it can still go through leaves the queue too,
  // so it is not submitted twice.
  useEffect(() => {
    if (submission === undefined || submission.isWrapperDone || submission.mayHaveExecuted) return;
    if (submissionState.phase === 'complete') {
      removeAction(submission.wrapper.action);
      setSubmissionRecord({ ...submission, isWrapperDone: true });
    } else if (submissionState.phase === 'stopped' && mayStillExecute(submissionState)) {
      removeAction(submission.wrapper.action);
      setSubmissionRecord({ ...submission, mayHaveExecuted: true });
    }
  }, [submission, submissionState]);

  // The submission dialog shows the submission of this visit. While a step is being signed, the
  // user can hide it. It returns when the lifecycle moves to another step or stops.
  const hiddenWhileSigning = submission?.hiddenWhileSigning;
  const isHidden =
    hiddenWhileSigning !== undefined &&
    submissionState.phase === 'signing' &&
    submissionState.draft === hiddenWhileSigning.draft &&
    submissionState.stepIndex === hiddenWhileSigning.stepIndex;
  // Submit, or the position card's notice, shows a submission hidden while a step is signed.
  const showSubmission = () => {
    if (isFromEarlierVisit()) return;
    submissionStore.setRecord((current) =>
      current?.scope === visitIdentity && current.hiddenWhileSigning !== undefined
        ? { ...current, hiddenWhileSigning: undefined }
        : current
    );
  };

  let assetRows: ReactNode[];
  let otherAssetRows: ReactNode[] = [];
  let mastheadState: MastheadState;
  let positionCardState: PositionCardState;
  let isBulkerAllowed = false;
  // What the submission dialog needs from the dashboard's hydrated state.
  let submissionControls: { continueSubmission: () => void; symbol: string } | undefined;
  // The amount form keeps its confirm callback, so the callback reads the rules of the latest render.
  liveActionRules.current = {};
  // The market's wrapper sends every step of a wrapper action, approvals included, under its own address.
  const wrapperAddress = lendingRoute.kind === 'wrapped' ? lendingRoute.market?.wrapperAddress : undefined;
  const isWrapperTransaction = (transaction: Transaction) =>
    wrapperAddress !== undefined && transaction.key.toLowerCase() === wrapperAddress.toLowerCase();

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
      baseAsset: directBaseAsset,
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
    const supplyIncentives = supplyIncentivesForRoute(isWrappedRoute, directBaseAsset.balance, {
      earnRewardsAPR: supplyRewardsAPR,
      isInstitutional,
    });

    // On the wrapped route, the wrapped position is the account's base supply. It is shown only
    // with a Comet state read for the route's market and known to be the connected account's, so
    // one account's wrapped value is never added to another account's balances.
    let wrappedPosition: WrappedPosition | undefined;
    let notice: MastheadNotice | undefined;
    let actionRules: ActionRules = {};
    if (lendingRoute.kind === 'wrapped') {
      const cometMarket = cometStateMarket.current.market;
      const isCometStateForRoute =
        cometMarket !== undefined &&
        cometMarket.chainId === lendingRoute.chainId &&
        cometMarket.cometAddress.toLowerCase() === lendingRoute.cometAddress.toLowerCase();
      const { position } = wrappedLending;
      if (position.status === 'loaded' && isCometStateForRoute && isCometStateVerifiedForAccount) {
        wrappedPosition = position.position;
      }
      const reload = () => window.location.reload();
      if (wrappedAction.session.status === 'unusable') {
        notice = { message: wrappedAction.session.instruction, actionLabel: 'Reload', onAction: reload };
      } else if (position.status === 'error') {
        notice = {
          message: 'Your supplied balance could not be loaded. Check your connection and try again.',
          actionLabel: 'Retry',
          onAction: wrappedLending.retry,
        };
      } else if (position.status === 'unavailable') {
        notice = unavailableNotice(position.reason, reload);
      }
      const limits =
        wrappedPosition === undefined
          ? undefined
          : wrappedWithdrawalLimits(wrappedPosition, directBaseAsset.balanceOfComet);
      actionRules = {
        wrappedBase: {
          supplyBlockedReason: wrappedEntryBlockLabel(lendingRoute, 'supply'),
          withdrawBlockedReason: wrappedEntryBlockLabel(lendingRoute, 'withdraw'),
          maxPartialWithdrawal: limits?.maxPartialCash,
          canWithdrawAll: limits?.canExitFully ?? false,
          // The cash the submission asks the wrapper for on a full exit.
          fullExitCash: wrappedPosition?.fullExitCash,
        },
      };
    }
    const wrappedValue = wrappedPosition?.grossAssets ?? 0n;
    // The dashboard's base asset: the Comet one, with the wrapped value added to a supply. A direct
    // borrow is shown as it is, and the wrapped value beneath it.
    const baseAsset = withWrappedSupply(directBaseAsset, wrappedValue);
    const wrappedSupplyApart = baseAsset === directBaseAsset && wrappedValue > 0n ? wrappedValue : undefined;
    const isMixedSupply = wrappedValue > 0n && directBaseAsset.balance > 0n;
    liveActionRules.current = actionRules;

    // Dialogs keep the callbacks below, so they check the session when they run.
    const isBlockedOnLiveRoute = (actionsToSubmit: Action[]) =>
      liveWalletUnusable.current ||
      // A queue holding a wrapper action in any other form is refused whole, never submitted without it.
      !isDirectExecution(actionsToSubmit) ||
      isSubmissionRefused(
        liveSession.current,
        { chainId: market.chainInformation.chainId, cometAddress: market.marketAddress },
        actionsToSubmit
      );

    const actions = getActions(baseAsset, collateralAssets, rewards);
    // The same queue against the Comet base asset, which the direct actions are submitted with.
    const queuedActions = getActions(directBaseAsset, collateralAssets, rewards);
    const actionsForCompare = compare ? [] : actions;
    const updatedDataPostActions = calculateUpdatedBalances(baseAsset, collateralAssets, actionsForCompare);
    const pendingAction = getPendingAction(updatedDataPostActions.baseAsset, updatedDataPostActions.collateralAssets);

    const onRequestClose = () => setActionModalState(undefined);
    // The approval dialog keeps this, so it checks the session when the user clicks.
    const allowOperatorWhileCurrent: WriteCometState['allowOperator'] = async (...args) => {
      if (isFromEarlierVisit() || liveWalletUnusable.current) return;
      return writeState.allowOperator(...args);
    };
    const submitBulkerAction = (directActions: Action[]) => {
      if (isFromEarlierVisit()) return;
      if (isBlockedOnLiveRoute(directActions)) {
        setActionModalState(undefined);
        return;
      }
      const description = `${directActions.length} Action${directActions.length > 1 ? 's' : ''}`;
      const estimatedGasLimit = liveEstimatedGasMap.current.get(getKeyForActions(directActions)) || 0;
      writeState.invokeBulker(
        market,
        directActions,
        directBaseAsset,
        collateralAssets,
        description,
        estimatedGasLimit,
        () => {
          setPendingAction(undefined);
          clearActions();
          setActionModalState(undefined);
        }
      );
      setActionModalState(
        actionModalStateBulker(market, transactions, directActions, directBaseAsset, collateralAssets, onRequestClose)
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
          const amount = sanitizedAmountForAction(directBaseAsset, collateralAssets, [], singleAction);
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
          const amount = sanitizedAmountForAction(directBaseAsset, collateralAssets, [], singleAction);
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

    // The direct actions go to Comet or the Bulker as before: a single action directly, except
    // native-token or stETH wrapping, and several through the Bulker.
    const submitDirectActions = (directActions: Action[]) => {
      const nativeTokenSymbol = market.chainInformation.nativeToken.symbol;
      const actionAssetSymbol = directActions[0][1].symbol;

      if (directActions.length === 1 && actionAssetSymbol !== nativeTokenSymbol && actionAssetSymbol !== 'stETH') {
        // don't use bulker if you're only taking a single action (that
        // doesn't involve wrapping Ether or stETH)
        submitSingleAction(directActions[0]);
      } else if (!isBulkerAllowed) {
        setActionModalState(
          actionModalStateBulkerApprove(
            market,
            state[1],
            transactions,
            { ...writeState, allowOperator: allowOperatorWhileCurrent },
            estimatedGasMap,
            onRequestClose,
            () => submitBulkerAction(directActions)
          )
        );
      } else {
        submitBulkerAction(directActions);
      }
    };

    /**
     * Plans the queue against the live route, or undefined when the plan refuses it. A wrapper
     * action is never passed to Comet or the Bulker: the plan holds it apart, and the direct part
     * is checked again before it is sent.
     */
    const planQueue = (): QueuedExecutionPlan | undefined => {
      try {
        return planQueuedExecution(liveSession.current.route, directBaseAsset, collateralAssets, queuedActions);
      } catch (error) {
        if (error instanceof WrappedExecutionError) return undefined;
        throw error;
      }
    };

    // Starts the wrapper action, which goes first. Its steps are confirmed one at a time in the
    // submission dialog. The direct actions wait until it confirms.
    const startWrapperAction = (wrapper: QueuedWrapperAction, directCount: number) => {
      const { write, action } = liveWrappedLending.current;
      const stateBefore = action.state;
      const refusal =
        wrapper.type === 'supply'
          ? write.supply(wrapper.amount)
          : write.withdraw(
              wrapper.request,
              wrapper.request.kind === 'full' ? wrappedPosition?.fullExitCash : undefined
            );
      setSubmissionRecord({
        scope: visitIdentity,
        wrapper,
        directCount,
        refusal,
        isWrapperDone: false,
        stateBefore,
      });
      const { route } = liveSession.current;
      const account = web3.write.account?.toLowerCase();
      const chainId = web3.write.chainId;
      if (refusal !== undefined || route.kind !== 'wrapped' || route.market === undefined) return;
      if (account === undefined || chainId === undefined) return;
      const started: SentWrapperAction = {
        scope: sentScope,
        action: wrapper.action,
        type: wrapper.type,
        account,
        chainId,
        wrapperAddress: route.market.wrapperAddress,
      };
      submissionStore.setSent(started);
    };

    const submitQueue = () => {
      if (web3.read.chainId === undefined || web3.write.chainId === undefined) return;
      const plan = planQueue();
      if (plan === undefined) return;
      if (plan.direct.length > 0 && isBlockedOnLiveRoute(plan.direct)) return;
      if (web3.write.chainId !== web3.read.chainId) {
        switchWriteNetwork(web3.read.chainId);
      } else if (plan.wrapper !== undefined) {
        startWrapperAction(plan.wrapper, plan.direct.length);
      } else if (plan.direct.length > 0) {
        submitDirectActions(plan.direct);
      }
    };

    // The submission dialog's Continue: the direct actions, once the wrapper action left the queue.
    const continueSubmission = () => {
      if (isFromEarlierVisit()) return;
      const plan = planQueue();
      setSubmissionRecord(undefined);
      if (plan === undefined || plan.wrapper !== undefined || plan.direct.length === 0) return;
      if (isBlockedOnLiveRoute(plan.direct)) return;
      submitDirectActions(plan.direct);
    };

    const approvalTransactions = transactions.filter(
      (transaction) =>
        transaction.key !== market.bulkerAddress &&
        transaction.key !== market.marketAddress &&
        transaction.key !== market.rewardsAddress &&
        !isWrapperTransaction(transaction)
    );
    const bulkerTransaction = transactions.find((transaction) => transaction.key === market.bulkerAddress);
    const cometTransaction = transactions.find((transaction) => transaction.key === market.marketAddress);
    const rewardTransaction = transactions.find((transaction) => transaction.key === market.rewardsAddress);
    const wrapperTransaction = transactions.find(isWrapperTransaction);
    // block the UI when there is a bulker transaction, or a single action to
    // Comet, the Rewards contract or the market's wrapper (i.e. do not block
    // if you're just approving an ERC token)
    const blockingTransaction = bulkerTransaction || cometTransaction || rewardTransaction || wrapperTransaction;

    // Why the queue is held while no submission dialog shows it. A wrapper action sent before a
    // change of network holds it until its transaction settles on the market's network, where the
    // receipt is followed.
    let queueNotice: PositionCardNotice | undefined;
    const actionNoun = (type: WrappedActionType) =>
      `${directBaseAsset.symbol} ${type === 'supply' ? 'supply' : 'withdrawal'}`;
    if (submission !== undefined && isHidden) {
      const noun = actionNoun(submission.wrapper.type);
      queueNotice = {
        message: `Your ${noun} is in progress. The queue stays as it is until it finishes.`,
        actionLabel: 'Show Progress',
        onAction: showSubmission,
      };
    } else if (submission === undefined && sent !== undefined) {
      const network = CHAINS[sent.chainId]?.name ?? `network ${sent.chainId}`;
      const switchBack = web3.write.chainId === sent.chainId ? '' : ` Switch your wallet to ${network} to follow it.`;
      const noun = actionNoun(sent.type);
      queueNotice = {
        message: `Your ${noun} is pending on ${network}. The queue stays as it is until it settles.${switchBack}`,
      };
    }

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
        institutionalWhitelistStatus: whitelistStatus,
        liquidationCapacity,
        liquidationCapacityPost: updatedDataPostActions.liquidationCapacity,
        pendingAction,
        rewardsAssetSymbol,
        theme,
        transaction: blockingTransaction,
        wrappedSupplyApart,
        isMixedSupply,
        notice,
        onWithdrawAction: (pendingAction?: PendingAction) => {
          if (isQueueLocked()) return;
          setPendingAction(pendingAction);
        },
        onSupplyAction: (pendingAction?: PendingAction) => {
          if (isQueueLocked()) return;
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
        queueNotice,
        onClearClicked: () => {
          if (isQueueLocked()) return;
          clearActions();
        },
        onCompareClicked: () => {
          setCompare(!compare);
        },
        onDeleteAction: (action: Action) => {
          if (isQueueLocked()) return;
          removeAction(action);
        },
        onDripClicked: () => {
          if (isFromEarlierVisit()) return;
          writeState.drip(market, directBaseAsset.address);
        },
        onSelectAction: (action: Action) => {
          if (isQueueLocked()) return;
          setPendingAction(getPendingActionFromAction(action, updatedDataPostActions.baseAsset));
        },
        onPendingActionCancel: () => {
          setPendingAction(undefined);
        },
        onPendingActionConfirm: (amount: bigint) => {
          // The amount form keeps this callback. One from an earlier visit asks for no approval or
          // network switch, and queues nothing. Nor does one during a submission.
          if (isFromEarlierVisit() || isQueueLocked()) return;
          if (pendingAction !== undefined) {
            const action = getActionFromPendingAction(pendingAction, amount);
            const confirmAction = () => {
              setPendingAction(undefined);
              addOrUpdateAction(action);
            };
            // The wrapper's approval is requested at submission, for exactly the amount, so a base
            // supply or withdrawal on the wrapped route is queued as it is. A form kept from before
            // the release controls closed queues nothing.
            if (isWrapperRouted(liveSession.current.route, action)) {
              const rules = liveActionRules.current.wrappedBase;
              const blockedReason =
                action[0] === ActionType.Supply ? rules?.supplyBlockedReason : rules?.withdrawBlockedReason;
              if (rules !== undefined && blockedReason === undefined) confirmAction();
              return;
            }
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
          // One submission at a time: a submission in progress, one whose dialog is hidden while a
          // step is signed, or a wrapper action whose last step may still execute holds back another.
          // Submit shows a hidden submission again, and starts nothing.
          if (liveSubmission.current?.hiddenWhileSigning !== undefined) {
            showSubmission();
            return;
          }
          if (isQueueLocked()) return;
          setPendingAction(undefined);
          submitQueue();
        },
      },
    ];
    submissionControls = { continueSubmission, symbol: directBaseAsset.symbol };

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
              isLocked: isQueueLocked(),
              unwrappedAssetSupplyAction: stEthWrapSupplyAction,
              onDripClicked: () => {
                if (isFromEarlierVisit()) return;
                writeState.drip(market, token.address);
              },
              onCancelClicked: () => {
                if (isFromEarlierVisit() || isQueueLocked()) return;
                if (pendingActionOrUndefined) {
                  setPendingAction(undefined);
                  action && removeAction(action);
                }
              },
              onEditClicked: () => {
                if (isFromEarlierVisit() || isQueueLocked()) return;
                if (action) {
                  setPendingAction(getPendingActionFromAction(action, updatedDataPostActions.baseAsset));
                }
              },
              onSupplyClicked: () => {
                if (isFromEarlierVisit() || isQueueLocked()) return;
                if (web3.read.chainId !== undefined && web3.write.chainId !== undefined) {
                  setPendingAction([ActionType.SupplyCollateral, token, undefined]);
                  setActionModalState(undefined);
                }
              },
              onWithdrawClicked: () => {
                if (isFromEarlierVisit() || isQueueLocked()) return;
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
              isLocked: isQueueLocked(),
              wrappedAsset: matchingWrappedAsset,
              onCancelClicked: () => {
                if (isFromEarlierVisit() || isQueueLocked()) return;
                if (pendingActionOrUndefined) {
                  setPendingAction(undefined);
                  action && removeAction(action);
                }
              },
              onEditClicked: () => {
                if (isFromEarlierVisit() || isQueueLocked()) return;
                if (action) {
                  setPendingAction(getPendingActionFromAction(action, updatedDataPostActions.baseAsset));
                }
              },
              onSupplyClicked: () => {
                if (isFromEarlierVisit() || isQueueLocked()) return;
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

  const closeSubmission = () => {
    if (submission === undefined) return;
    if (submissionState.phase === 'signing') {
      const { draft, stepIndex } = submissionState;
      setSubmissionRecord({ ...submission, hiddenWhileSigning: { draft, stepIndex } });
      return;
    }
    // Nothing more is sent from a closed submission. Its wrapper action stays queued unless it confirmed.
    if (isSubmissionState) wrappedAction.discard();
    setSubmissionRecord(undefined);
  };
  // A confirmation belongs to this submission's review. One kept from an earlier visit does nothing.
  const confirmSubmissionStep = () => {
    if (isFromEarlierVisit() || submissionState.phase !== 'review') return;
    wrappedAction.confirm();
  };
  const submissionModal = submission !== undefined && submissionControls !== undefined && !isHidden && (
    <QueuedSubmissionModal
      submission={submission}
      state={submissionState}
      symbol={submissionControls.symbol}
      decimals={lendingRoute.kind === 'wrapped' ? lendingRoute.market?.baseDecimals : undefined}
      recovery={{
        canDismissRecovered: wrappedAction.canDismissRecovered,
        isRecoveredRequestPendingInWallet: wrappedAction.isRecoveredRequestPendingInWallet,
        hasUnansweredWalletRequest: wrappedAction.hasUnansweredWalletRequest,
        walletRefusalMessage: wrappedAction.walletRefusalMessage,
        sessionInstruction: wrappedAction.session.status === 'unusable' ? wrappedAction.session.instruction : undefined,
      }}
      onConfirm={confirmSubmissionStep}
      onClose={closeSubmission}
      onContinue={submissionControls.continueSubmission}
      onDismissRecovered={wrappedAction.dismissRecovered}
    />
  );

  return (
    <div className="page home">
      <ActionModal isBulkerAllowed={isBulkerAllowed} state={actionModalState} transactions={transactions} />
      {submissionModal}
      <InstitutionalBanner market={selectedMarket[1]} />
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

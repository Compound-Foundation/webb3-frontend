import type { TransactionResponse } from '@ethersproject/providers';
import { ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { isUnwrappedCollateralAsset } from '@constants/chains';
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
  isSameAction,
  isSameToken,
  calculateUpdatedBalances,
  addsSecondAction,
  getActionFromPendingAction,
  sanitizedAmountForAction,
} from '@helpers/actions';
import { withCometStateSource } from '@helpers/cometStateSource';
import {
  anchorBlock,
  directWithdrawalCalldata,
  directWithdrawalHolds,
  HoldKey,
  holdKey,
  HoldRecord,
  isHoldResolved,
} from '@helpers/directWithdrawalHold';
import { arrayPartition } from '@helpers/functions';
import { getKeyForActions, PreEstimatedAction } from '@helpers/gasEstimator';
import { institutionalWhitelistStatus } from '@helpers/institutionalWhitelist';
import { WriteBlockReason } from '@helpers/lendingRoute';
import { getStatusCollateralAddress } from '@helpers/marketStatus';
import { formatValue, MAX_UINT256 } from '@helpers/numbers';
import {
  isSingleActionRoute,
  isWrapperRouted,
  planQueuedExecution,
  QueuedExecutionPlan,
  QueuedWrapperAction,
  splitWrappedWithdrawal,
  WithdrawalSplit,
  wrappedEntryBlockLabel,
} from '@helpers/queuedExecution';
import { isStETH, isWrappedStETH } from '@helpers/steth';
import { classifyWalletError, NotSentError, SendWithdrawnError, WalletErrorKind } from '@helpers/walletErrors';
import {
  isDirectExecution,
  isWrappedCometAddress,
  WrappedBlockReason,
  WrappedExecutionError,
} from '@helpers/wrappedActions';
import {
  CometStateWithMarket,
  getWrappedRouteWithdrawalLimits,
  isDirectWithdrawalRefused,
  isSameWalletSession,
  isSubmissionRefused,
  LiveSubmissionState,
  MarketIdentity,
  readDirectBalance,
  supplyIncentivesForRoute,
  withdrawnFromReceipt,
  WalletSession,
  withWrappedSupply,
  WrappedPosition,
} from '@helpers/wrappedPositions';
import { getWithdrawalLimits, WithdrawalLimits, WithdrawalRequest } from '@helpers/wrappedWithdrawals';
import { useMarkets } from '@hooks/useMarkets';
import { Theme } from '@hooks/useThemeManager';
import type { AddTransaction } from '@hooks/useTransactionManager';
import type { WrappedActionState } from '@hooks/useWrappedAction';
import { useWriteCometState, WriteCometState } from '@hooks/useWriteCometState';
import { WRAPPED_SUPPLY_STEP_IDS } from '@hooks/useWriteWrappedState';
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
  TransactionOutcome,
  TransactionState,
} from '@types';

import ActionModal from './components/ActionModal';
import AssetRow from './components/AssetRow';
import InstitutionalBanner from './components/InstitutionalBanner';
import Masthead, { MastheadNotice, MastheadState } from './components/Masthead';
import PositionCard, { PositionCardState } from './components/PositionCard';
import SupplyPausedBanner from './components/SupplyPausedBanner';

const sortTokensAlphabetically = (a: Token, b: Token): number => (a.name > b.name ? 1 : a.name === b.name ? 0 : -1);

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

/** The label a queued wrapper action's row shows after a check stopped it before anything was sent. */
const NOT_SENT_LABEL = 'Not Sent, Try Again';
/**
 * The label instead, when the check was that an earlier wrapper request of the account is still
 * pending or open in the wallet. That request can still go through, so the row does not ask for
 * another try.
 */
const EARLIER_PENDING_LABEL = 'Earlier Request Still Pending';

/** The row's label for a wrapper action refused before anything was sent, by why it was refused. */
function notSentLabel(reason: WrappedBlockReason): string {
  return reason === 'transaction-pending' || reason === 'action-in-progress' ? EARLIER_PENDING_LABEL : NOT_SENT_LABEL;
}

/**
 * The label a submitted wrapper action's queue row shows once it stopped with the action still
 * queued, or undefined for none. A rejection in the wallet returns the queue as a direct action's
 * does, with nothing said. An action that can still execute has left the queue.
 */
function stoppedLabel(state: Extract<WrappedActionState, { phase: 'stopped' }>): string | undefined {
  const step = state.steps[state.stepIndex];
  switch (step?.status) {
    case 'blocked':
      return notSentLabel(step.reason);
    case 'refused':
      return 'Reconnect Your Wallet';
    case 'reverted':
      return 'Transaction Failed';
    default:
      return undefined;
  }
}

/**
 * A wrapper action's place in the transaction list while its checks run, before the manager tracks
 * its wallet request, so the dashboard shows it as it shows a direct action from the press on.
 */
function inFlightTransaction(key: string, description: string, networkId: number): Transaction {
  return {
    id: `in-flight-${key}`,
    key,
    networkId,
    networkName: '',
    description,
    nonce: 0,
    state: TransactionState.AwaitingConfirmation,
  };
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

/**
 * What the masthead says when part of the account's balance on the wrapped route is supplied to
 * Comet directly, outside the wrapper.
 */
function directSupplyNotice(
  amount: bigint,
  baseAsset: BaseAssetWithAccountState,
  isWithdrawOpen: boolean
): MastheadNotice {
  const supplied = `${formatValue(baseAsset.decimals, amount)} ${
    baseAsset.symbol
  } of your balance is supplied to Comet directly, outside the wrapper.`;
  return { message: isWithdrawOpen ? `${supplied} Withdraw takes it out first.` : supplied };
}

/** How long Home waits before it asks again for the block after a replaced Comet step, in milliseconds. */
const REPLACED_BLOCK_RETRY_MS = 3_000;

/** The row's label when a withdrawal stopped before its Comet step because the direct supply fell. */
const DIRECT_BALANCE_CHANGED_LABEL = 'Balance Changed, Edit Amount';
/**
 * The Comet step of a wrapped-route withdrawal while it is being sent: the reservation, the fresh
 * read and split made before its gas is estimated, the hold stored just before the wallet is asked,
 * what follows the outcome, and what the wallet answered.
 */
type DirectStepRequest = {
  /** The Comet address and the arguments the step's `withdraw` call must carry. */
  cometAddress: string;
  args: [string, string];
  /**
   * Reserves the account's Comet withdrawals on the market for this step, before the fresh read and
   * the gas estimate. Throws, so that nothing is sent, while another one is reserved or held.
   */
  reserve: () => Promise<void>;
  /**
   * Reads the direct supply again and splits the withdrawal from it into `replanned`, before the gas
   * is estimated. Throws, so that nothing is sent, unless the step may be signed now.
   */
  planFromFreshRead: () => Promise<void>;
  /**
   * After the gas estimate: checks the session and reads the direct supply again, then stores the
   * hold with the calldata of `sentArgs` and reads it back. Throws, so that nothing is sent, unless
   * the session is live, the planned call is still safe by the second read, and storage holds the
   * hold. The wallet is asked only after this.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  holdBeforeWallet: (sentArgs: any[]) => Promise<void>;
  /** Adds the transaction's hash to the hold, once the wallet gave it. */
  onHash: (response: TransactionResponse) => void;
  /** Called with the manager's answer once the request is made. */
  onRequested: (sent: Promise<unknown>) => void;
  onSettled: (outcome: TransactionOutcome) => void;
  /**
   * The arguments the Comet step is sent with: the planned call's, with the amount of `replanned`.
   * Throws unless the call is the planned one and the fresh read has split the withdrawal again.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sentArgs: (args: any[]) => any[];
  /** The direct supply the fresh read before the gas estimate showed. */
  freshBalance?: bigint;
  /** The withdrawal split again from `freshBalance`, which decides the Comet step's amount. */
  replanned?: WithdrawalSplit;
  /**
   * Set when the read before or after the gas estimate left nothing for the Comet step, more than
   * the wrapper pays now, or less than a finite part above it.
   */
  isBalanceShort?: boolean;
  /** Set when an earlier Comet step that can still execute held this one back. */
  isHeldBack?: boolean;
  /** The block of the fresh read, which the hold keeps. */
  readBlock?: number;
  /** The calldata whose gas was estimated, which the wallet request must carry byte for byte. */
  estimatedCalldata?: string;
  /** The id of this step's reservation, and then its hold, once reserved. */
  holdId?: string;
  /** How the wallet's error was classified, when the wallet was asked and answered with one. */
  walletError?: WalletErrorKind;
};

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
  cometState: cometStateProp,
  addTransaction,
  switchWriteNetwork,
  estimatedGasMap,
  theme,
}: HomeProps) => {
  // when V2 market was selected from market page and open up a new window default dashboard with default market
  const { selectedMarket, selectMarket } = useContext(getSelectedMarketContext());
  const [marketsStateType, marketsState] = useMarkets();
  const defaultMarket = marketsStateType === StateType.Hydrated ? marketsState.defaultMarket : undefined;

  // We use a useEffect here to prevent infinite renders by the state update in selectMarket
  useEffect(() => {
    const isV2Selected = selectedMarket[0] === 'hydrated' && selectedMarket[1].baseAsset.symbol == 'Compound V2';
    if (isV2Selected && defaultMarket !== undefined) {
      selectMarket(defaultMarket);
    }
  }, [selectedMarket[0], selectedMarket[1]?.baseAsset?.symbol, defaultMarket]);

  const rewards = useContext(RewardsStateContext);
  const { addOrUpdateAction, clearActions, getActions, getPendingAction, removeAction, setPendingAction } = useContext(
    getActionQueueContext()
  );

  const [compare, setCompare] = useState(false);
  // A market the summary reports in the error status is shown like one whose on-chain data failed to load
  const selected = selectedMarket[1];
  const isMarketStatusError = selected?.status === 'error';
  const getCollateralStatusFor = (assetAddress: string) => {
    if (selected === undefined) return undefined;
    const statusAddress = getStatusCollateralAddress(selected.chainInformation, assetAddress).toLowerCase();
    return selected.collaterals?.find((collateral) => collateral.address.toLowerCase() === statusAddress)?.status;
  };
  const state: CometState = isMarketStatusError ? [StateType.Loading, undefined] : cometStateProp;
  const [cometState] = state;

  const wrappedLending = useWrappedLending();
  const { route: lendingRoute, action: wrappedAction } = wrappedLending;
  const isWrappedRoute = lendingRoute.kind === 'wrapped';
  // Callbacks kept from an earlier render start wrapper actions through the live lending state.
  const liveWrappedLending = useRef(wrappedLending);
  liveWrappedLending.current = wrappedLending;
  const liveActionRules = useRef<ActionRules>({});
  // The queue as the latest render shows it, which the amount form's kept confirm callback reads.
  const liveQueuedActions = useRef<Action[]>([]);
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
  // On the wrapped route, the wrapped position joins a Comet state's balances only if useCometState
  // read the state for the connected account. For a state read for another account, or with no
  // record, the dashboard shows the direct balance alone, and offers no wrapped withdrawal, until
  // the next Comet read.
  const cometAccount = cometStateMarket.current.account;
  const isCometStateVerifiedForAccount =
    cometAccount !== undefined && cometAccount.toLowerCase() === web3.write.account?.toLowerCase();
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

  // A Comet base withdrawal or borrow that Home sends for the connected account, on either route and
  // through any connector, waits while a Comet step of a wrapped-route withdrawal of the account on
  // the market is reserved or held (`directWithdrawalHolds`): together they can take more than the
  // direct supply, and Comet then lends the rest. It only checks: a standard-route withdrawal holds
  // nothing back itself, and the Extensions page's transactions are not checked. Only a configured
  // wrapped market can have one. Storage that cannot be read, or holds anything other than a JSON
  // list, is unknown, never empty, and holds the withdrawal back too. Storage read cleanly with no record for the key sends
  // as on main. The wrapped route refuses every other base withdrawal to Comet anyway
  // (`isSubmissionRefused`). `baseWithdrawalHold` is set only for the synchronous call that sends
  // such a write, which checks again just before the wallet is asked.
  const baseWithdrawalHold = useRef<HoldKey>();
  const isBaseWithdrawalHeld = (key: HoldKey | undefined) => {
    if (key === undefined) return false;
    const read = directWithdrawalHolds.read(key);
    return read.status === 'unknown' || read.records.length > 0;
  };

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
    const heldKey = baseWithdrawalHold.current;
    baseWithdrawalHold.current = undefined;
    const sendWhileCurrent: typeof trxFn = (...args) =>
      isLiveVisit(visitKeyBefore) && !liveWalletUnusable.current && !isBaseWithdrawalHeld(heldKey)
        ? trxFn(...args)
        : Promise.reject(new SendWithdrawnError());
    return addTransaction(key, description, sendWhileCurrent, estimatedGas, trxEstimateGasFn, fnArgs, value, callback);
  };
  // The Comet step of a wrapped-route withdrawal, which takes the account's direct supply before the
  // wrapper step, is production's Comet base withdrawal: `withdraw` of the write state below. Its
  // request is set only for the synchronous call that sends it, and adds a check just before the
  // wallet is asked. A call that does not carry the planned Comet address and arguments sends nothing.
  const directStepRequest = useRef<DirectStepRequest>();
  const addDirectStepTransaction: AddTransaction = (key, description, trxFn, estimatedGas, estimateGasFn, fnArgs) => {
    const request = directStepRequest.current;
    directStepRequest.current = undefined;
    const isPlannedCall =
      request !== undefined &&
      key.toLowerCase() === request.cometAddress.toLowerCase() &&
      fnArgs.length === 2 &&
      fnArgs[0] === request.args[0] &&
      fnArgs[1] === request.args[1];
    if (request === undefined) return Promise.resolve(undefined);
    if (!isPlannedCall) {
      const notSent = Promise.resolve(undefined);
      request.onRequested(notSent);
      return notSent;
    }
    const checkedSend: typeof trxFn = async (...args) => {
      const sentArgs = request.sentArgs(args);
      // The wallet is asked for exactly the call whose gas was estimated, and for nothing when no
      // estimate was made. `estimatedCalldata` is set in `estimatePlannedCall`, and `replanned` in
      // `planFromFreshRead`, which only `estimatePlannedCall` calls, once, so this check fails only if
      // that changes.
      const calldata = directWithdrawalCalldata(sentArgs[0], sentArgs[1]);
      if (request.estimatedCalldata === undefined || calldata !== request.estimatedCalldata) {
        throw new NotSentError(new Error('The withdrawal changed after its gas was estimated.'));
      }
      // The wallet is asked only once storage holds the request's calldata.
      await request.holdBeforeWallet(sentArgs);
      let response: TransactionResponse;
      try {
        response = await trxFn(...sentArgs);
      } catch (error) {
        request.walletError = classifyWalletError(error);
        throw error;
      }
      request.onHash(response);
      return response;
    };
    // The account's Comet withdrawals on the market are reserved for this step before anything else.
    // The withdrawal is then split again from a fresh read of the direct supply, and the gas is
    // estimated for exactly the call that split sends: `withdraw(baseToken, amount)` or
    // `withdraw(baseToken, type(uint256).max)`. A failed estimate sends nothing.
    const estimatePlannedCall: typeof estimateGasFn = async (...args) => {
      await request.reserve();
      await request.planFromFreshRead();
      const plannedArgs = request.sentArgs(args);
      request.estimatedCalldata = directWithdrawalCalldata(plannedArgs[0], plannedArgs[1]);
      try {
        return await estimateGasFn(...plannedArgs);
      } catch (error) {
        throw new NotSentError(error);
      }
    };
    const sent = addTransactionWhileCurrent(
      key,
      description,
      checkedSend,
      estimatedGas,
      estimatePlannedCall,
      fnArgs,
      0n,
      request.onSettled
    );
    request.onRequested(sent);
    return sent;
  };
  const directStepWriteState = useWriteCometState(web3, addDirectStepTransaction);
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

  // A wrapped run, Approve & Add's approval or Submit's supply or withdrawal, belongs to its scope:
  // the account, connector, connection status, wallet network and market. App keeps it beside the
  // wrapper action lifecycle, so it survives a visit to another page. A change of scope drops it in
  // the same render, and the lifecycle discards its draft for the same change.
  const submissionStore = wrappedLending.submission;
  const submission = submissionStore.record?.scope === visitIdentity ? submissionStore.record : undefined;
  const setSubmissionRecord = (record: SubmissionRecord | undefined) => submissionStore.setRecord(() => record);
  const liveSubmission = useRef(submission);
  liveSubmission.current = submission;
  // The wrapper action a run submitted belongs to the queue's scope, which leaves out the wallet's
  // network. App follows it until its last step's outcome is known, after the run itself is dropped.
  const sentScope = queueScope(web3.write, selectedMarketIdentity);
  const sent = submissionStore.sent?.scope === sentScope ? submissionStore.sent : undefined;
  const liveSent = useRef(sent);
  liveSent.current = sent;
  // A held Comet withdrawal of the account on the selected market ends only on evidence about the
  // request itself (`isHoldResolved`), read at a block from `anchorBlock`. Any tab can end it, since
  // the evidence is the chain's. A failed read keeps it. `holdScans` keeps how far the logs were read
  // for each hashless hold, so the next look continues from there.
  const holdScans = useRef(new Map<string, number>());
  const releaseResolvedHolds = async (key: HoldKey, records: readonly HoldRecord[]): Promise<boolean> => {
    const readProvider = web3.read.provider;
    if (readProvider === undefined) return false;
    let isAnyReleased = false;
    for (const record of records) {
      if (record.kind !== 'held') continue;
      try {
        const throughBlock = await anchorBlock(readProvider, web3.write.provider, [record.blockNumber]);
        // The node's own nonce for the hash is stored once known, so a later replacement can be judged.
        const storeNonce = (nonce: number) => {
          if (record.hash !== undefined) directWithdrawalHolds.recordHash(key, record.id, record.hash, nonce);
        };
        if (
          (await isHoldResolved(record, readProvider, throughBlock, holdScans.current, storeNonce)) &&
          (await directWithdrawalHolds.release(key, record.id))
        ) {
          isAnyReleased = true;
        }
      } catch (error) {
        console.warn('Could not check an earlier withdrawal from Comet:', error);
      }
    }
    return isAnyReleased;
  };
  const liveReleaseResolvedHolds = useRef(releaseResolvedHolds);
  liveReleaseResolvedHolds.current = releaseResolvedHolds;
  const heldAccount = web3.write.account;
  const heldChainId = selectedMarketIdentity?.chainId;
  const heldCometAddress = selectedMarketIdentity?.cometAddress;
  // Looked at again whenever the Comet state is read again.
  useEffect(() => {
    if (heldAccount === undefined || heldChainId === undefined || heldCometAddress === undefined) return;
    const key = holdKey(heldAccount, heldChainId, heldCometAddress);
    const read = directWithdrawalHolds.read(key);
    if (read.status !== 'known' || !read.records.some((record) => record.kind === 'held')) return;
    liveReleaseResolvedHolds.current(key, read.records);
  }, [state, heldAccount, heldChainId, heldCometAddress, web3.read.provider, web3.write.provider]);
  // While a supply or withdrawal runs, the queue it was planned from cannot change. Nor can it while
  // the wrapper action it submitted may still be carried out, so the action is never sent again
  // before it is known whether it executed. The dashboard shows this as it shows a direct action
  // awaiting confirmation or pending. These checks keep callbacks kept from earlier renders in step.
  const isQueueLocked = () => {
    const current = liveSubmission.current;
    const isRunning = current?.status.kind === 'running' || current?.status.kind === 'direct';
    return (current?.kind === 'execute' && isRunning) || liveSent.current !== undefined;
  };
  // The lifecycle's state, when it belongs to this run. Until the run's draft starts, the lifecycle
  // can still show an earlier one, which this run never acts on.
  const lifecycleState = wrappedAction.state;
  const isSubmissionState = (() => {
    if (submission === undefined || submission.status.kind !== 'running') return false;
    if (lifecycleState === submission.stateBefore) return false;
    const type = submission.kind === 'approve' ? 'supply' : submission.wrapper.type;
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
  const isRunInFlight =
    submissionState.phase === 'reading' || submissionState.phase === 'review' || submissionState.phase === 'signing';
  // An approval ends when it confirms or stops, and its queued supply stays as it is: the row says
  // whether the allowance now covers it. A supply or withdrawal that confirms leaves the queue, and
  // so does one that confirmed while another page was shown. One that stops with nothing sent stays
  // queued, with a label on its row unless the wallet declined it. One that stops at its last step in
  // a state where it can still go through leaves the queue too, so it is not submitted twice.
  useEffect(() => {
    if (submission === undefined || submission.status.kind !== 'running') return;
    const { phase } = submissionState;
    if (phase === 'idle' || phase === 'reading' || phase === 'review' || phase === 'signing') return;
    if (submission.kind === 'approve') {
      setSubmissionRecord(undefined);
      return;
    }
    if (phase === 'complete') {
      removeAction(submission.wrapper.action);
      setSubmissionRecord(undefined);
    } else if (phase === 'stopped') {
      if (mayStillExecute(submissionState)) removeAction(submission.wrapper.action);
      const step = submissionState.steps[submissionState.stepIndex];
      if (step?.status === 'blocked')
        console.warn('The wrapped transaction was not sent:', step.message ?? step.reason);
      const label = mayStillExecute(submissionState) ? undefined : stoppedLabel(submissionState);
      setSubmissionRecord(label === undefined ? undefined : { ...submission, status: { kind: 'stopped', label } });
    } else if (phase === 'read-failed') {
      console.warn('The wrapped transaction was not sent:', submissionState.message);
      setSubmissionRecord({ ...submission, status: { kind: 'stopped', label: NOT_SENT_LABEL } });
    } else {
      setSubmissionRecord(undefined);
    }
  }, [submission, submissionState]);
  let assetRows: ReactNode[];
  let otherAssetRows: ReactNode[] = [];
  let mastheadState: MastheadState;
  let positionCardState: PositionCardState;
  let isBulkerAllowed = false;
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
      .map((token, index) => (
        <AssetRow
          key={index}
          state={[StateType.NoWallet, { asset: token, isCollateralError: getCollateralStatusFor(token.address) === 'error' }]}
        />
      ));
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
      isRewardsLoading,
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
    // The account's base supply to Comet directly, outside the wrapper. A withdrawal on the wrapped
    // route takes it first.
    const directSupply = directBaseAsset.balance > 0n ? directBaseAsset.balance : 0n;
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
      } else if (directSupply > 0n && isCometStateForRoute && isCometStateVerifiedForAccount) {
        const isWithdrawOpen = wrappedEntryBlockLabel(lendingRoute, 'withdraw') === undefined;
        notice = directSupplyNotice(directSupply, directBaseAsset, isWithdrawOpen);
      }
      const readPosition = wrappedPosition;
      const limits =
        readPosition === undefined
          ? undefined
          : getWrappedRouteWithdrawalLimits({
              directSupply,
              cometCash: directBaseAsset.balanceOfComet,
              hasShares: readPosition.shares > 0n,
              isWithdrawPaused: readPosition.isWithdrawPaused,
              wrapperLimitsAt: (cash) => wrappedWithdrawalLimits(readPosition, cash),
            });
      actionRules = {
        isSingleAction: isSingleActionRoute(lendingRoute),
        wrappedBase: {
          supplyBlockedReason: wrappedEntryBlockLabel(lendingRoute, 'supply'),
          withdrawBlockedReason: wrappedEntryBlockLabel(lendingRoute, 'withdraw'),
          maxPartialWithdrawal: limits?.maxPartialCash,
          canWithdrawAll: limits?.canWithdrawAll ?? false,
          // The cash a maximum withdrawal pays: the direct supply, then the wrapper's full exit.
          fullExitCash: wrappedPosition === undefined ? undefined : directSupply + wrappedPosition.fullExitCash,
          directSupply:
            directSupply > 0n && isCometStateForRoute && isCometStateVerifiedForAccount ? directSupply : undefined,
          supplyAllowance: wrappedPosition?.wrapperAllowance,
          stopped:
            submission?.kind === 'execute' && submission.status.kind === 'stopped'
              ? { action: submission.wrapper.action, label: submission.status.label }
              : undefined,
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

    // The hold a Comet base withdrawal or borrow among `actionsToSubmit` waits for, if any.
    const baseWithdrawalHoldKey = (actionsToSubmit: Action[]): HoldKey | undefined => {
      const account = web3.write.account;
      const withdrawsBase = actionsToSubmit.some(
        ([type, asset]) =>
          (type === ActionType.Withdraw || type === ActionType.Borrow) &&
          asset.address.toLowerCase() === directBaseAsset.address.toLowerCase()
      );
      if (account === undefined || !withdrawsBase || !isWrappedCometAddress(market.marketAddress)) return undefined;
      return holdKey(account, market.chainInformation.chainId, market.marketAddress);
    };

    // Dialogs keep the callbacks below, so they check the session when they run.
    const isBlockedOnLiveRoute = (actionsToSubmit: Action[]) =>
      liveWalletUnusable.current ||
      isBaseWithdrawalHeld(baseWithdrawalHoldKey(actionsToSubmit)) ||
      // A queue holding a wrapper action in any other form is refused whole, never submitted without it.
      !isDirectExecution(actionsToSubmit) ||
      isSubmissionRefused(
        liveSession.current,
        { chainId: market.chainInformation.chainId, cometAddress: market.marketAddress },
        actionsToSubmit
      ) ||
      // A kept callback writes through the session it was made in, whatever the live balances allow.
      !isSameWalletSession(walletSession, liveWalletSession.current);

    const actions = getActions(baseAsset, collateralAssets, rewards);
    // The same queue against the Comet base asset, which the direct actions are submitted with.
    const queuedActions = getActions(directBaseAsset, collateralAssets, rewards);
    liveQueuedActions.current = queuedActions;
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
      baseWithdrawalHold.current = baseWithdrawalHoldKey(directActions);
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
      baseWithdrawalHold.current = undefined;
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

      baseWithdrawalHold.current = baseWithdrawalHoldKey([singleAction]);
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
          baseWithdrawalHold.current = undefined;
          throw new Error(`Cannot execute ActionType ${actionType} as a single action`);
      }
      baseWithdrawalHold.current = undefined;
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
            () => submitBulkerAction(directActions),
            () => !isSameWalletSession(walletSession, liveWalletSession.current)
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
    const planQueue = (actionsToPlan: Action[] = queuedActions): QueuedExecutionPlan | undefined => {
      try {
        return planQueuedExecution(liveSession.current.route, directBaseAsset, collateralAssets, actionsToPlan);
      } catch (error) {
        if (error instanceof WrappedExecutionError) return undefined;
        throw error;
      }
    };

    // Starts the queued wrapper action. The press of Submit Transaction confirms it: the lifecycle
    // checks it and asks the wallet with no other screen.
    const startWrapperAction = (wrapper: QueuedWrapperAction) => {
      const { write, action } = liveWrappedLending.current;
      const stateBefore = action.state;
      const refusal = wrapper.type === 'supply' ? write.supply(wrapper.amount) : write.withdraw(wrapper.request);
      const run = { kind: 'execute' as const, wrapper, scope: visitIdentity, stateBefore };
      if (refusal !== undefined) {
        console.warn('The wrapped transaction was not sent:', refusal);
        // An approval still running keeps its record, so its row keeps showing Approval Pending.
        const stopped: SubmissionRecord = { ...run, status: { kind: 'stopped', label: notSentLabel(refusal) } };
        submissionStore.setRecord((current) =>
          current?.kind === 'approve' && current.status.kind === 'running' && current.scope === visitIdentity
            ? current
            : stopped
        );
        return;
      }
      setSubmissionRecord({ ...run, status: { kind: 'running' } });
      const { route } = liveSession.current;
      const account = web3.write.account?.toLowerCase();
      const chainId = web3.write.chainId;
      if (route.kind !== 'wrapped' || route.market === undefined) return;
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

    // Approve & Add's approval of the wrapper for a base supply, for exactly the amount. Returns
    // whether the approval started.
    const startApproval = (action: Action, amount: bigint): boolean => {
      const { write, action: lifecycle } = liveWrappedLending.current;
      const stateBefore = lifecycle.state;
      const refusal = write.approve(amount);
      if (refusal !== undefined) {
        console.warn('The approval was not requested:', refusal);
        return false;
      }
      setSubmissionRecord({ kind: 'approve', action, scope: visitIdentity, stateBefore, status: { kind: 'running' } });
      return true;
    };

    // A withdrawal on the wrapped route takes the account's direct Comet supply first, as one Comet
    // base withdrawal, the transaction production sends. Any rest follows through the wrapper, which
    // starts only once the Comet step confirms, with no other press. Both steps belong to the queue's
    // one withdrawal row, which stays locked until the last of them ends. Nothing reaches the wrapper
    // unless the Comet step confirmed.
    const startSplitWithdrawal = (withdrawal: Extract<QueuedWrapperAction, { type: 'withdraw' }>) => {
      const visitKeyAtStart = visitKey;
      const stateBefore = liveWrappedLending.current.action.state;
      const run = { kind: 'execute' as const, wrapper: withdrawal, scope: visitIdentity, stateBefore };
      const recordStopped = (label: string): SubmissionRecord => ({ ...run, status: { kind: 'stopped', label } });
      // The run stopped once its Comet step confirmed, with `rest` still to pay on its row.
      const recordStoppedOnRest = (rest: Action, label: string): SubmissionRecord => ({
        ...run,
        wrapper: { ...withdrawal, action: rest },
        status: { kind: 'stopped', label },
      });
      const submittedMarket = { chainId: market.chainInformation.chainId, cometAddress: market.marketAddress };
      let split: WithdrawalSplit;
      try {
        split = splitWrappedWithdrawal(withdrawal.action[2], directBaseAsset.balance, wrappedPosition?.shares);
      } catch (error) {
        if (!(error instanceof WrappedExecutionError)) throw error;
        console.warn('The withdrawal was not sent:', error.message);
        setSubmissionRecord(recordStopped(NOT_SENT_LABEL));
        return;
      }
      const direct = split.direct;
      if (direct === undefined) {
        startWrapperAction(withdrawal);
        return;
      }
      // An earlier Comet withdrawal of the account on the market that can still execute holds back
      // every new one: together they can take more than the direct supply, and Comet then lends the
      // rest. The holds are stored (`directWithdrawalHolds`), so a reload, a change of market, another
      // tab and Clear keep them. While storage cannot be read, whether one exists is unknown, and
      // nothing is sent.
      const account = web3.write.account;
      if (account === undefined) {
        setSubmissionRecord(recordStopped(NOT_SENT_LABEL));
        return;
      }
      const key = holdKey(account, market.chainInformation.chainId, market.marketAddress);
      if (directWithdrawalHolds.read(key).status === 'unknown') {
        setSubmissionRecord(recordStopped(EARLIER_PENDING_LABEL));
        return;
      }
      const earlierStep = liveWrappedLending.current.submission.directStep;
      const minBlock = earlierStep?.scope === sentScope ? earlierStep.blockNumber : undefined;
      // The visit and wallet session the press was made in are still live and usable.
      const isSessionLive = () =>
        isLiveVisit(visitKeyAtStart) &&
        !liveWalletUnusable.current &&
        isSameWalletSession(walletSession, liveWalletSession.current);
      if (!isSessionLive() || isDirectWithdrawalRefused(liveSession.current, submittedMarket)) {
        setSubmissionRecord(recordStopped(NOT_SENT_LABEL));
        return;
      }
      const record: SubmissionRecord = { ...run, status: { kind: 'direct' } };
      // Changes the run only while it is still this one. A change of scope drops it meanwhile.
      const endRun = (next: SubmissionRecord | undefined) =>
        submissionStore.setRecord((current) => (current === record ? next : current));
      const queuedAmount = withdrawal.action[2];
      const baseAction = withdrawal.action[1] as BaseAssetWithAccountState;
      // The wrapper's part once the Comet step has taken `taken`: a maximum stays a full exit, and an
      // amount pays what the Comet step left of it.
      const restAfter = (taken: bigint): { action: Action; request: WithdrawalRequest } | undefined => {
        if (queuedAmount === MAX_UINT256) {
          return directStep.replanned?.request === undefined
            ? undefined
            : { action: withdrawal.action, request: { kind: 'full' } };
        }
        const cash = queuedAmount - taken;
        if (cash <= 0n) return undefined;
        return { action: [ActionType.Withdraw, baseAction, cash], request: { kind: 'partial', cash } };
      };
      // The row once the Comet step executed, or may have: the rest, or nothing when there is none.
      const queueRest = (rest: { action: Action } | undefined) =>
        rest === undefined ? removeAction(withdrawal.action) : addOrUpdateAction(rest.action);
      // What the Comet step takes at least, by the fresh read: the part itself, or the whole supply read.
      const takenAtLeast = () => {
        const sent = directStep.replanned?.direct?.amount;
        return sent === undefined || sent === MAX_UINT256 ? directStep.freshBalance ?? 0n : sent;
      };
      // The Comet step can have executed, or still can, so its row keeps only the rest. When it can
      // still execute, its stored hold holds back the next Comet step.
      const keepRestOnly = () => {
        queueRest(restAfter(takenAtLeast()));
        endRun(undefined);
      };
      // Whether the wrapper can pay `cash` now, within the market's cash once the Comet step has taken
      // `directTaken`, by the live position.
      const canWrapperPay = (cash: bigint, directTaken: bigint) => {
        const { position } = liveWrappedLending.current;
        if (position.status !== 'loaded') return false;
        const marketCash = directBaseAsset.balanceOfComet - directTaken;
        const limits = marketCash < 0n ? undefined : wrappedWithdrawalLimits(position.position, marketCash);
        return limits !== undefined && cash <= limits.maxPartialCash;
      };
      const readProvider = web3.read.provider;
      const walletProvider = web3.write.provider;
      // Removes this step's reservation or hold: it never reached the wallet, or can no longer execute.
      const releaseOwnHold = () => {
        const id = directStep.holdId;
        if (id !== undefined) directWithdrawalHolds.release(key, id);
      };
      // Reads the direct supply at a block from `anchorBlock`, no older than the wallet node's block
      // and every block in `floors`, and splits the withdrawal from it. Throws, so that nothing is
      // sent, when the read fails, no direct supply is left, or the wrapper cannot pay what the
      // direct supply no longer does. The row then asks for a new amount.
      const readAndSplit = async (floors: (number | undefined)[]) => {
        if (readProvider === undefined) {
          throw new NotSentError(new Error("This market's network cannot be read right now."));
        }
        let balance: bigint;
        let readBlock: number;
        try {
          readBlock = await anchorBlock(readProvider, walletProvider, floors);
          balance = await readDirectBalance(readProvider, market.marketAddress, account, readBlock);
        } catch (error) {
          throw new NotSentError(error);
        }
        const { position } = liveWrappedLending.current;
        const shares = position.status === 'loaded' ? position.position.shares : undefined;
        let replanned: WithdrawalSplit;
        try {
          replanned = splitWrappedWithdrawal(queuedAmount, balance, shares);
        } catch (error) {
          throw new NotSentError(error);
        }
        const replannedRequest = replanned.request;
        const isShort =
          replanned.direct === undefined ||
          (replannedRequest?.kind === 'partial' && !canWrapperPay(replannedRequest.cash, balance));
        if (isShort) {
          directStep.isBalanceShort = true;
          throw new SendWithdrawnError('The direct supply changed before the withdrawal was signed.');
        }
        return { balance, readBlock, replanned };
      };
      let reservation: Promise<void> | undefined;
      const directStep: DirectStepRequest = {
        cometAddress: market.marketAddress,
        args: [directBaseAsset.address, direct.amount.toString()],
        // Before the fresh read and the gas estimate, under the lock every tab respects: no other Comet
        // withdrawal of the account on the market is reserved or held, so this one is reserved. A held
        // one that the chain shows can no longer execute is released first.
        reserve: () => {
          reservation ??= (async () => {
            let reserved = await directWithdrawalHolds.reserve(key);
            if (reserved.status === 'held-back' && (await releaseResolvedHolds(key, reserved.records))) {
              reserved = await directWithdrawalHolds.reserve(key);
            }
            if (reserved.status === 'held-back') {
              directStep.isHeldBack = true;
              throw new SendWithdrawnError('An earlier withdrawal from Comet can still execute.');
            }
            if (reserved.status === 'unknown') {
              throw new NotSentError(new Error('Your earlier withdrawals from Comet cannot be read.'));
            }
            directStep.holdId = reserved.id;
          })();
          return reservation;
        },
        // Once reserved, before the gas estimate: the session and the live Comet state still allow the
        // step, and the withdrawal is split again from a fresh read of the direct supply, so the two
        // steps pay the queued amount whatever the supply is now, and the estimate is of the call
        // that split sends. The read is of a block from `anchorBlock`: no older than the wallet
        // node's and the last confirmed Comet step's.
        planFromFreshRead: async () => {
          if (!isSessionLive() || isDirectWithdrawalRefused(liveSession.current, submittedMarket)) {
            throw new SendWithdrawnError();
          }
          const fresh = await readAndSplit([minBlock]);
          directStep.freshBalance = fresh.balance;
          directStep.replanned = fresh.replanned;
          directStep.readBlock = fresh.readBlock;
          if (!isSessionLive()) throw new SendWithdrawnError();
        },
        holdBeforeWallet: async (sentArgs) => {
          // The session and the live Comet state still allow the step after the gas estimate.
          if (!isSessionLive() || isDirectWithdrawalRefused(liveSession.current, submittedMarket)) {
            throw new SendWithdrawnError();
          }
          const id = directStep.holdId;
          const amount = directStep.replanned?.direct?.amount;
          const blockNumber = directStep.readBlock;
          if (id === undefined || amount === undefined || blockNumber === undefined) throw new SendWithdrawnError();
          // The direct supply is read again after the estimate, at a block no older than the first
          // read's. A finite part is sent only while the supply is still above it, so a fall during
          // the estimate never makes Comet borrow, and a whole-supply step only while the split still
          // has a direct part and a rest the wrapper can pay. Otherwise nothing is sent, and the row
          // asks for a new amount. The hold keeps the first read's block, the earlier of the two.
          // A rise during the estimate does not stop a whole-supply step, which then pays the risen
          // supply, as after the first read.
          const recheck = await readAndSplit([minBlock, blockNumber]);
          if (amount !== MAX_UINT256 && recheck.replanned.direct?.amount !== amount) {
            directStep.isBalanceShort = true;
            throw new SendWithdrawnError('The direct supply changed before the withdrawal was signed.');
          }
          // The session and the live Comet state still allow the step after the second read.
          if (!isSessionLive() || isDirectWithdrawalRefused(liveSession.current, submittedMarket)) {
            throw new SendWithdrawnError();
          }
          const calldata = directWithdrawalCalldata(sentArgs[0], sentArgs[1]);
          if (!(await directWithdrawalHolds.hold(key, id, { calldata, amount, blockNumber }))) {
            throw new NotSentError(new Error('The withdrawal could not be stored before signing.'));
          }
          if (!isSessionLive()) throw new SendWithdrawnError();
        },
        onHash: (response) => {
          const id = directStep.holdId;
          if (id === undefined) return;
          const nonce = typeof response.nonce === 'number' ? response.nonce : undefined;
          directWithdrawalHolds.recordHash(key, id, response.hash, nonce).then((isStored) => {
            // The hold stays without the hash, and ends once the same calldata is found mined.
            if (!isStored) console.warn('The hash of a Comet withdrawal could not be stored.');
          });
        },
        sentArgs: (args) => {
          const amount = directStep.replanned?.direct?.amount;
          // Only the planned call, with the amount the fresh read gave, is ever sent.
          if (amount === undefined || args.length !== 3 || args[0] !== directStep.args[0]) {
            throw new SendWithdrawnError();
          }
          return [args[0], amount.toString(), args[2]];
        },
        onRequested: (sent) => {
          sent.then((response) => {
            if (response !== undefined) return;
            const walletError = directStep.walletError;
            // Only a wallet that had the request and answered ambiguously can still send it. Otherwise
            // nothing reached the chain, and the reservation or hold goes.
            const canStillExecute =
              walletError !== undefined && walletError !== 'rejected' && walletError !== 'refused';
            if (!canStillExecute) releaseOwnHold();
            if (directStep.isHeldBack) {
              endRun(recordStopped(EARLIER_PENDING_LABEL));
            } else if (directStep.isBalanceShort) {
              endRun(recordStopped(DIRECT_BALANCE_CHANGED_LABEL));
            } else if (directStep.walletError === 'rejected') {
              // As for a wrapper action, a rejection returns the queue with nothing said.
              endRun(undefined);
            } else if (directStep.walletError === 'refused') {
              endRun(recordStopped('Reconnect Your Wallet'));
            } else if (directStep.walletError !== undefined) {
              // The wallet had the request and can still send it. Nothing is sent to the wrapper.
              keepRestOnly();
            } else {
              endRun(recordStopped(NOT_SENT_LABEL));
            }
          });
        },
        onSettled: (outcome) => {
          if (outcome.status === 'reverted') {
            releaseOwnHold();
            endRun(recordStopped('Transaction Failed'));
            return;
          }
          // The manager found the step's nonce taken without a receipt. Its nonce can be the lower bound
          // it read before sending, which a request queued behind another transaction passes while it
          // is still pending, so this alone ends no hold. The row keeps only the rest, nothing more is
          // sent for it, the next Comet step's fresh read is of a block no older than the one the
          // wallet's node had then, and the hold ends only once `isHoldResolved` shows a receipt or
          // the step's own nonce taken.
          if (outcome.status === 'replaced') {
            // The run and its row stay until that block is known. A failed lookup tries again while
            // the run is live.
            const settleReplaced = () => {
              if (readProvider === undefined) return;
              anchorBlock(readProvider, walletProvider, [minBlock]).then(
                (blockNumber) => {
                  if (!isLiveVisit(visitKeyAtStart) || liveSubmission.current !== record) return;
                  submissionStore.setDirectStep({ scope: sentScope, blockNumber });
                  keepRestOnly();
                  const read = directWithdrawalHolds.read(key);
                  if (read.status === 'known') {
                    releaseResolvedHolds(
                      key,
                      read.records.filter((held) => held.id === directStep.holdId)
                    );
                  }
                },
                (error) => {
                  console.warn('The block of a replaced Comet withdrawal is not known:', error);
                  if (isLiveVisit(visitKeyAtStart) && liveSubmission.current === record) {
                    setTimeout(settleReplaced, REPLACED_BLOCK_RETRY_MS);
                  }
                }
              );
            };
            settleReplaced();
            return;
          }
          releaseOwnHold();
          submissionStore.setDirectStep({ scope: sentScope, blockNumber: outcome.receipt.blockNumber });
          // What the Comet step took: the part itself, or, for the whole supply, the amount its
          // receipt's Withdraw event names. The supply can have grown since the fresh read.
          const sentAmount = directStep.replanned?.direct?.amount;
          const taken =
            sentAmount !== undefined && sentAmount !== MAX_UINT256
              ? sentAmount
              : withdrawnFromReceipt(outcome.receipt, market.marketAddress, account);
          if (taken === undefined) {
            // Without the event, the rest is known only to within what the supply earned since the
            // fresh read. The row keeps the rest by that read, and nothing is sent to the wrapper.
            console.warn('The Comet withdrawal confirmed, but its receipt names no amount.');
            const rest = restAfter(takenAtLeast());
            queueRest(rest);
            endRun(rest === undefined ? undefined : recordStoppedOnRest(rest.action, DIRECT_BALANCE_CHANGED_LABEL));
            return;
          }
          const rest = restAfter(taken);
          queueRest(rest);
          // The split made at signing planned no wrapper step, but the supply fell before the Comet
          // step executed, so it took less than the amount. The row keeps the rest, and no wallet
          // request that the split did not plan opens.
          if (rest !== undefined && directStep.replanned?.request === undefined) {
            endRun(recordStoppedOnRest(rest.action, DIRECT_BALANCE_CHANGED_LABEL));
            return;
          }
          // The wrapper step follows at once while the run and its visit are live. Otherwise the rest
          // stays queued for the next Submit, as a wrapper action that confirmed while another page
          // was shown leaves the queue as it is.
          if (rest === undefined || !isLiveVisit(visitKeyAtStart) || liveSubmission.current !== record) {
            endRun(undefined);
            return;
          }
          startWrapperAction({ type: 'withdraw', action: rest.action, request: rest.request });
        },
      };
      setSubmissionRecord(record);
      directStepRequest.current = directStep;
      directStepWriteState.withdraw(
        market,
        directBaseAsset.address,
        direct.amount,
        `Withdraw ${directBaseAsset.name}`,
        0,
        () => undefined
      );
      if (directStepRequest.current === directStep) {
        // The write did not start, as when the wallet session changed, so nothing was sent.
        directStepRequest.current = undefined;
        endRun(recordStopped(NOT_SENT_LABEL));
      }
    };

    // A wallet on another network is asked to switch first, as for direct actions, and nothing is
    // sent. A wrapper action that may still execute holds back another submission.
    const submitQueue = () => {
      if (web3.read.chainId === undefined || web3.write.chainId === undefined) return;
      const plan = planQueue();
      if (plan === undefined) return;
      if (plan.direct.length > 0 && isBlockedOnLiveRoute(plan.direct)) return;
      if (web3.write.chainId !== web3.read.chainId) {
        switchWriteNetwork(web3.read.chainId);
      } else if (isQueueLocked()) {
        return;
      } else if (plan.wrapper?.type === 'withdraw' && directSupply > 0n) {
        startSplitWithdrawal(plan.wrapper);
      } else if (plan.wrapper !== undefined) {
        startWrapperAction(plan.wrapper);
      } else if (plan.direct.length > 0) {
        submitDirectActions(plan.direct);
      }
    };

    // A wrapper approval shows on its supply's queue row as Approval Pending, as an approval of
    // Comet does, and does not hold the dashboard. Every other wrapper transaction does, as a
    // transaction to Comet does.
    const isWrapperApproval = (transaction: Transaction) =>
      isWrapperTransaction(transaction) &&
      (transaction.step === WRAPPED_SUPPLY_STEP_IDS.approve || transaction.step === WRAPPED_SUPPLY_STEP_IDS.reset);
    const wrapperApprovals = transactions.filter(isWrapperApproval);
    if (submission?.kind === 'approve' && isRunInFlight && wrapperApprovals.length === 0 && wrapperAddress) {
      wrapperApprovals.push(
        inFlightTransaction(wrapperAddress, `Enable ${directBaseAsset.symbol}`, market.chainInformation.chainId)
      );
    }
    const approvalTransactions = [
      ...transactions.filter(
        (transaction) =>
          transaction.key !== market.bulkerAddress &&
          transaction.key !== market.marketAddress &&
          transaction.key !== market.rewardsAddress &&
          !isWrapperTransaction(transaction)
      ),
      ...wrapperApprovals.map((transaction) => ({ ...transaction, key: directBaseAsset.address })),
    ];
    const bulkerTransaction = transactions.find((transaction) => transaction.key === market.bulkerAddress);
    let cometTransaction = transactions.find((transaction) => transaction.key === market.marketAddress);
    // A withdrawal's Comet step holds the dashboard from the press on, as its wrapper step does.
    if (cometTransaction === undefined && submission?.kind === 'execute' && submission.status.kind === 'direct') {
      const description = `Withdraw ${directBaseAsset.name}`;
      cometTransaction = inFlightTransaction(market.marketAddress, description, market.chainInformation.chainId);
    }
    const rewardTransaction = transactions.find((transaction) => transaction.key === market.rewardsAddress);
    let wrapperTransaction = transactions.find(
      (transaction) => isWrapperTransaction(transaction) && !isWrapperApproval(transaction)
    );
    if (wrapperTransaction === undefined && submission?.kind === 'execute' && isRunInFlight && wrapperAddress) {
      const description = `${submission.wrapper.type === 'supply' ? 'Supply' : 'Withdraw'} ${directBaseAsset.symbol}`;
      wrapperTransaction = inFlightTransaction(wrapperAddress, description, market.chainInformation.chainId);
    }
    // block the UI when there is a bulker transaction, or a single action to
    // Comet, the Rewards contract or the market's wrapper (i.e. do not block
    // if you're just approving an ERC token)
    const blockingTransaction = bulkerTransaction || cometTransaction || rewardTransaction || wrapperTransaction;

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
            // A queue limited to one action takes no second one, and asks for no approval for it.
            if (liveActionRules.current.isSingleAction && addsSecondAction(liveQueuedActions.current, action)) return;
            const confirmAction = () => {
              setPendingAction(undefined);
              addOrUpdateAction(action);
            };
            // A base supply on the wrapped route spends the allowance to the wrapper. As for a direct
            // supply, an allowance that does not cover it is approved when the supply is added, here
            // for exactly the amount. A form kept from before the release controls closed queues
            // nothing.
            if (isWrapperRouted(liveSession.current.route, action)) {
              const rules = liveActionRules.current.wrappedBase;
              const blockedReason =
                action[0] === ActionType.Supply ? rules?.supplyBlockedReason : rules?.withdrawBlockedReason;
              if (rules === undefined || blockedReason !== undefined) return;
              const others = queuedActions.filter((queued) => !isSameAction(queued, action));
              const supplied = sanitizedAmountForAction(directBaseAsset, collateralAssets, others, action);
              if (action[0] === ActionType.Withdraw || supplied <= (rules.supplyAllowance ?? 0n)) {
                confirmAction();
              } else if (web3.read.chainId && web3.write.chainId !== web3.read.chainId) {
                switchWriteNetwork(web3.read.chainId);
              } else if (!liveWalletUnusable.current && startApproval(action, supplied)) {
                // As in production, the press both asks for the approval and queues the supply. An
                // approval that cannot start now, as while an earlier one is pending, changes nothing,
                // and the form stays open to be pressed again.
                confirmAction();
              }
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
          setPendingAction(undefined);
          submitQueue();
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
              isCollateralError: getCollateralStatusFor(token.address) === 'error',
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
              isCollateralError: getCollateralStatusFor(token.address) === 'error',
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

  return (
    <div className="page home">
      <ActionModal isBulkerAllowed={isBulkerAllowed} state={actionModalState} transactions={transactions} />
      <SupplyPausedBanner />
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

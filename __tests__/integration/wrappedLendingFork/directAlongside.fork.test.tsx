import { act, renderHook, waitFor } from '@testing-library/react';

import type { Web3 } from '@contexts/Web3Context';
import { getBulkerTrxData } from '@helpers/bulkerActions';
import { getIsDeprecatedwUSDMMarket } from '@helpers/deprecatedMarkets';
import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { planExecution, submitExecution, WrappedExecutionError } from '@helpers/wrappedActions';
import { isSubmissionRefused } from '@helpers/wrappedPositions';
import { useCometState } from '@hooks/useCometState';
import { useWriteCometState } from '@hooks/useWriteCometState';
import {
  Action,
  ActionType,
  CometState,
  MarketData,
  MarketDataLoaded,
  MarketDataState,
  ProtocolAndAccountState,
  RewardsState,
  StateType,
  Transaction,
} from '@types';

import { MOCK_MARKETS } from '../../mocks/mockMarkets';

import {
  COMET,
  ERC20,
  expectExitPaid,
  forkAccount,
  FORK_MARKETS,
  read,
  readBigInt,
  receiptEffects,
  revertDataOf,
  units,
  WETH,
} from './fixtures';
import { anvil, assertLocalFork, forkProvider } from './fork';
import { fundedAccount, nonceOf, onSnapshot } from './injections';
import { scenario } from './results';
import { renderWrappedApp, WrappedApp } from './wrappedApp';

const NO_REWARDS: RewardsState = [StateType.Loading];
const NO_TRANSACTIONS: Transaction[] = [];
const SETTLE_TIMEOUT_MS = 180_000;

type DirectHooks = { comet: CometState; writeComet: ReturnType<typeof useWriteCometState> };

describe.each(FORK_MARKETS)('$label', (forkMarket) => {
  const { market, symbol, label } = forkMarket;
  const account = forkAccount('direct and wrapped', forkMarket);
  const marketData = getMarket(MOCK_MARKETS, 1, market.cometAddress) as MarketData;
  // The standard route's writes take a loaded market. They read only its addresses and native token.
  const loadedMarket = marketData as unknown as MarketDataLoaded;
  // App holds these in state, so every render passes the same objects.
  const marketState: MarketDataState = [StateType.Hydrated, marketData];
  const identity = { chainId: 1, cometAddress: market.cometAddress };

  beforeAll(assertLocalFork);

  /** The account's Comet state as the dashboard shows it, once it has loaded. */
  async function cometState(app: WrappedApp<DirectHooks>): Promise<ProtocolAndAccountState> {
    await waitFor(() => expect(app.result.current.extra.comet[0]).toBe(StateType.Hydrated), {
      timeout: SETTLE_TIMEOUT_MS,
      interval: 50,
    });
    return app.result.current.extra.comet[1] as ProtocolAndAccountState;
  }

  /** Waits until the dashboard's Comet state shows the chain's wallet balance and ETH collateral for `holder`. */
  async function freshCometState(app: WrappedApp<DirectHooks>, holder = account) {
    const [wallet, collateral] = await Promise.all([
      readBigInt(market.baseTokenAddress, ERC20, 'balanceOf', [holder]),
      readBigInt(market.cometAddress, COMET, 'collateralBalanceOf', [holder, WETH]),
    ]);
    await waitFor(
      () => {
        const [stateType, state] = app.result.current.extra.comet;
        expect(stateType).toBe(StateType.Hydrated);
        const accountState = state as ProtocolAndAccountState;
        expect(accountState.baseAsset.walletBalance).toBe(wallet);
        expect(accountState.collateralAssets.find((asset) => asset.symbol === 'ETH')?.balance).toBe(collateral);
      },
      { timeout: SETTLE_TIMEOUT_MS, interval: 50 }
    );
    return app.result.current.extra.comet[1] as ProtocolAndAccountState;
  }

  /** Runs one of the standard route's writes and waits until the transaction manager settles it. */
  async function standardWrite(app: WrappedApp<DirectHooks>, write: (hooks: DirectHooks) => Promise<void>) {
    const settledBefore = app.result.current.manager.settledTransactions.length;
    await act(() => write(app.result.current.extra));
    await waitFor(
      () => {
        const { transactions, settledTransactions } = app.result.current.manager;
        expect(transactions).toHaveLength(0);
        expect(settledTransactions.length).toBeGreaterThan(settledBefore);
      },
      { timeout: SETTLE_TIMEOUT_MS, interval: 50 }
    );
    const settled =
      app.result.current.manager.settledTransactions[app.result.current.manager.settledTransactions.length - 1];
    if (settled.outcome.status !== 'confirmed')
      throw new Error(`The standard transaction ended ${settled.outcome.status}.`);
    return settled.outcome.receipt;
  }

  /** The account's direct Comet position from the chain: principal, debt, collateral and supply. */
  async function directOnChain() {
    const basic = await read(market.cometAddress, COMET, 'userBasic', [account]);
    const [debt, collateral, supplied, cometTotalSupply, wrapperAssets, [isCollateralized]] = await Promise.all([
      readBigInt(market.cometAddress, COMET, 'borrowBalanceOf', [account]),
      readBigInt(market.cometAddress, COMET, 'collateralBalanceOf', [account, WETH]),
      readBigInt(market.cometAddress, COMET, 'balanceOf', [account]),
      readBigInt(market.cometAddress, COMET, 'totalSupply'),
      readBigInt(market.cometAddress, COMET, 'balanceOf', [market.wrapperAddress]),
      read(market.cometAddress, COMET, 'isBorrowCollateralized', [account]),
    ]);
    return {
      principal: BigInt(basic.principal.toString()),
      debt,
      collateral,
      supplied,
      cometTotalSupply,
      wrapperAssets,
      isCollateralized: Boolean(isCollateralized),
    };
  }

  /** The dashboard's figures for the account's direct position. */
  const directOnScreen = (state: ProtocolAndAccountState) => ({
    baseBalance: state.baseAsset.balance,
    borrowCapacity: state.baseAsset.borrowCapacity,
    ethCollateral: state.collateralAssets.find((asset) => asset.symbol === 'ETH')?.balance,
    collateralValue: state.collateralValue,
    liquidationCapacity: state.liquidationCapacity,
  });

  scenario('direct-alongside', label, (measured) =>
    onSnapshot(async () => {
      await fundedAccount(market, account, units(10_000));
      // Every later block keeps one timestamp, so the direct debt accrues nothing between readings.
      await anvil.freezeTime();
      const app = await renderWrappedApp<DirectHooks>(
        { market, symbol, account, cometAddress: market.cometAddress },
        ({ manager, web3 }) => ({
          comet: useCometState(web3, marketState, manager.transactions, NO_REWARDS),
          writeComet: useWriteCometState(web3, manager.addTransaction),
        })
      );
      try {
        // Mainnet USDT takes the app's deprecated price-feed path, which this Comet state read uses.
        measured.deprecatedFeedPath = getIsDeprecatedwUSDMMarket(marketData.baseAsset, marketData.chainInformation);
        // The standard route's own writes: allow the Bulker, then supply ETH and borrow through it.
        let state = await cometState(app);
        await standardWrite(app, ({ writeComet }) =>
          writeComet.allowOperator(marketData, marketData.bulkerAddress, 'Allow the Bulker', 0)
        );
        state = await freshCometState(app);
        const eth = state.collateralAssets.find((asset) => asset.symbol === 'ETH');
        if (eth === undefined) throw new Error('The market lists no ETH collateral.');
        const collateral = 10n * 10n ** 18n;
        const borrow = units(2_000);
        await standardWrite(app, ({ writeComet }) =>
          writeComet.invokeBulker(
            loadedMarket,
            [
              [ActionType.SupplyCollateral, eth, collateral],
              [ActionType.Borrow, state.baseAsset, borrow],
            ],
            state.baseAsset,
            state.collateralAssets,
            'Supply ETH and borrow',
            0
          )
        );
        const chainBefore = await directOnChain();
        state = await freshCometState(app);
        const screenBefore = directOnScreen(state);
        const marketSupplyUsdBefore = state.totalBaseSupplyUsd;
        Object.assign(measured, {
          directDebt: chainBefore.debt,
          directCollateralWei: chainBefore.collateral,
          dashboardBorrowCapacity: screenBefore.borrowCapacity,
          dashboardBaseBalance: screenBefore.baseBalance,
        });
        expect(chainBefore.collateral).toBe(collateral);
        // Comet rounds a borrower's principal up, so the debt it reports can be a unit above the borrow.
        expect(chainBefore.debt - borrow).toBeGreaterThanOrEqual(0n);
        expect(chainBefore.debt - borrow).toBeLessThanOrEqual(1n);

        // A wrapped supply beside the direct borrow: Approve & Add's approval, then Submit's supply.
        expect(await app.startApproval(units(1_000))).toBeUndefined();
        app.receiptOf(await app.confirmStep());
        expect(await app.startSupply(units(1_000))).toBeUndefined();
        const receipts = [app.receiptOf(await app.confirmStep())];
        const supplied = await receiptEffects(market, account, receipts[receipts.length - 1]);
        const credited = BigInt(supplied.deposit?.args.assets.toString() ?? '-1');
        const chainAfterSupply = await directOnChain();
        state = await freshCometState(app);
        const screenAfterSupply = directOnScreen(state);
        // The dashboard's market total, in dollars with 8 decimals, against the credit's own value.
        const price = state.baseAsset.baseAssetPriceInDollars;
        const creditUsd = (credited * price) / 10n ** BigInt(market.baseDecimals);
        Object.assign(measured, {
          wrappedCredited: credited,
          cometTotalSupplyDelta: chainAfterSupply.cometTotalSupply - chainBefore.cometTotalSupply,
          wrapperAssetsDelta: chainAfterSupply.wrapperAssets - chainBefore.wrapperAssets,
          dashboardMarketSupplyUsdDelta: state.totalBaseSupplyUsd - marketSupplyUsdBefore,
          wrappedCreditUsd: creditUsd,
        });
        const usdDifference = state.totalBaseSupplyUsd - marketSupplyUsdBefore - creditUsd;
        const oneUnitUsd = price / 10n ** BigInt(market.baseDecimals) + 1n;
        expect(usdDifference).toBeGreaterThanOrEqual(-oneUnitUsd);
        expect(usdDifference).toBeLessThanOrEqual(oneUnitUsd);
        // The direct position, as the chain and the dashboard show it, is unchanged.
        expect(chainAfterSupply).toMatchObject({
          principal: chainBefore.principal,
          debt: chainBefore.debt,
          collateral: chainBefore.collateral,
          supplied: chainBefore.supplied,
          isCollateralized: true,
        });
        expect(screenAfterSupply).toEqual(screenBefore);
        // Comet counts the wrapped supply once: as the wrapper's own balance.
        expect(chainAfterSupply.wrapperAssets - chainBefore.wrapperAssets).toBe(credited);
        const totalDelta = chainAfterSupply.cometTotalSupply - chainBefore.cometTotalSupply;
        expect(totalDelta - credited).toBeGreaterThanOrEqual(-1n);
        expect(totalDelta - credited).toBeLessThanOrEqual(1n);
        // Wrapper shares are not Comet collateral, so they add no borrowing capacity.
        measured.wrapperAsCollateral = String(
          await revertDataOf(account, {
            to: market.cometAddress,
            data: COMET.encodeFunctionData('getAssetInfoByAddress', [market.wrapperAddress]),
          }).then((data) => (data === undefined ? 'listed' : COMET.parseError(data).name))
        );
        expect(measured.wrapperAsCollateral).toBe('BadAsset');
        const panel = await app.positionShowing(supplied.after.shares);
        measured.panelGrossAssets = panel.grossAssets;
        expect(credited - panel.grossAssets).toBeGreaterThanOrEqual(0n);
        expect(credited - panel.grossAssets).toBeLessThanOrEqual(1n);

        // The read-only account view shows the same direct position.
        const readOnlyProvider = forkProvider();
        const readOnlyWeb3 = {
          read: { connector: undefined, chainId: 1, account, isActive: true, provider: readOnlyProvider },
          write: {
            connector: undefined,
            chainId: 1,
            account: undefined,
            isActive: false,
            status: 'disconnected',
            provider: undefined,
          },
          screeningStatus: 'idle',
        } as unknown as Web3;
        const readOnly = renderHook(() => useCometState(readOnlyWeb3, marketState, NO_TRANSACTIONS, NO_REWARDS));
        try {
          await waitFor(() => expect(readOnly.result.current[0]).toBe(StateType.Hydrated), {
            timeout: SETTLE_TIMEOUT_MS,
            interval: 50,
          });
          expect(directOnScreen(readOnly.result.current[1] as ProtocolAndAccountState)).toEqual(screenAfterSupply);
          measured.readOnlyViewMatches = true;
        } finally {
          readOnly.unmount();
        }

        // The app refuses a request that mixes a wrapped draft with direct actions, and the dashboard
        // refuses a direct base supply on this route. Nothing is sent.
        const nonce = await nonceOf(account);
        expect(await app.startApproval(units(100))).toBeUndefined();
        const draft = app.draft();
        const borrowMore: Action = [ActionType.Borrow, state.baseAsset, units(100)];
        let mixed: unknown;
        try {
          planExecution([draft, borrowMore]);
        } catch (error) {
          mixed = error;
        }
        measured.mixedRequest = mixed instanceof WrappedExecutionError ? mixed.problem : 'accepted';
        expect(measured.mixedRequest).toBe('mixed-execution');
        const direct = jest.fn();
        const wrapped = jest.fn();
        expect(() => submitExecution([borrowMore, draft], { direct, wrapped })).toThrow(WrappedExecutionError);
        expect([direct.mock.calls.length, wrapped.mock.calls.length]).toEqual([0, 0]);
        expect(() =>
          getBulkerTrxData(account, app.wallet, loadedMarket, state.baseAsset, state.collateralAssets, [
            draft as unknown as Action,
          ])
        ).toThrow(WrappedExecutionError);
        const live = {
          route: app.result.current.session.route,
          account,
          selectedMarket: identity,
          comet: { market: identity, account, state: app.result.current.extra.comet },
        };
        const refusedFor = (actions: Action[]) => isSubmissionRefused(live, identity, actions);
        Object.assign(measured, {
          directSupplyRefused: refusedFor([[ActionType.Supply, state.baseAsset, units(100)]]),
          borrowRefused: refusedFor([borrowMore]),
          repayWithinDebtRefused: refusedFor([[ActionType.Repay, state.baseAsset, units(100)]]),
          repayAboveDebtRefused: refusedFor([[ActionType.Repay, state.baseAsset, chainAfterSupply.debt + units(100)]]),
          fullRepayRefused: refusedFor([[ActionType.Repay, state.baseAsset, MAX_UINT256]]),
        });
        expect(measured).toMatchObject({
          directSupplyRefused: true,
          borrowRefused: false,
          repayWithinDebtRefused: false,
          repayAboveDebtRefused: true,
          fullRepayRefused: false,
        });
        act(() => app.result.current.action.discard());
        expect(await nonceOf(account)).toBe(nonce);

        // A wrapped full exit beside the direct borrow pays the wallet and leaves the debt alone.
        expect(await app.startWithdraw({ kind: 'full' })).toBeUndefined();
        const exitReview = app.draft().withdrawal?.quote;
        if (exitReview === undefined) throw new Error('The withdrawal draft has no quote.');
        const exited = await receiptEffects(market, account, app.receiptOf(await app.confirmStep()));
        const chainAfterExit = await directOnChain();
        measured.exitPaid = exited.cashDelta;
        // Every block has one timestamp here, so the exit pays the reviewed quote.
        expectExitPaid(exited, exitReview);
        expect(exited.after.shares).toBe(0n);
        expect(chainAfterExit).toMatchObject({
          principal: chainBefore.principal,
          debt: chainBefore.debt,
          collateral: chainBefore.collateral,
          supplied: chainBefore.supplied,
        });
        state = await freshCometState(app);
        expect(directOnScreen(state)).toEqual(screenBefore);

        // The standard route repays and withdraws the collateral as before.
        await standardWrite(app, ({ writeComet }) =>
          writeComet.approve(market.cometAddress, market.baseTokenAddress, `Approve ${symbol}`, 0)
        );
        state = await freshCometState(app);
        const ethNow = state.collateralAssets.find((asset) => asset.symbol === 'ETH');
        if (ethNow === undefined) throw new Error('The market lists no ETH collateral.');
        await standardWrite(app, ({ writeComet }) =>
          writeComet.invokeBulker(
            loadedMarket,
            [
              [ActionType.Repay, state.baseAsset, MAX_UINT256],
              [ActionType.WithdrawCollateral, ethNow, ethNow.balance],
            ],
            state.baseAsset,
            state.collateralAssets,
            'Repay and withdraw ETH',
            0
          )
        );
        const chainAfterRepay = await directOnChain();
        Object.assign(measured, {
          debtAfterRepay: chainAfterRepay.debt,
          collateralAfterWithdraw: chainAfterRepay.collateral,
        });
        expect(chainAfterRepay).toMatchObject({ principal: 0n, debt: 0n, collateral: 0n });
      } finally {
        app.unmount();
        await anvil.unfreezeTime();
      }
    })
  );
  scenario('standard-route-lending', label, (measured) =>
    onSnapshot(async () => {
      // Another wallet on the same market lends directly to Comet through the standard route.
      const lender = forkAccount('standard lender', forkMarket);
      await fundedAccount(market, lender, units(10_000));
      await anvil.freezeTime();
      const app = await renderWrappedApp<DirectHooks>(
        { market, symbol, account: lender, cometAddress: market.cometAddress, connectorId: 'io.metamask' },
        ({ manager, web3 }) => ({
          comet: useCometState(web3, marketState, manager.transactions, NO_REWARDS),
          writeComet: useWriteCometState(web3, manager.addTransaction),
        })
      );
      try {
        measured.route = app.result.current.session.route.kind;
        expect(measured.route).toBe('standard');
        await cometState(app);
        await standardWrite(app, ({ writeComet }) =>
          writeComet.approve(market.cometAddress, market.baseTokenAddress, `Approve ${symbol}`, 0)
        );
        await standardWrite(app, ({ writeComet }) =>
          writeComet.allowOperator(marketData, marketData.bulkerAddress, 'Allow the Bulker', 0)
        );
        let state = await freshCometState(app, lender);
        const supply: Action = [ActionType.Supply, state.baseAsset, units(1_000)];
        const live = {
          route: app.result.current.session.route,
          account: lender,
          selectedMarket: identity,
          comet: { market: identity, account: lender, state: app.result.current.extra.comet },
        };
        measured.directSupplyRefused = isSubmissionRefused(live, identity, [supply]);
        expect(measured.directSupplyRefused).toBe(false);
        await standardWrite(app, ({ writeComet }) =>
          writeComet.invokeBulker(loadedMarket, [supply], state.baseAsset, state.collateralAssets, 'Supply', 0)
        );
        const supplied = await readBigInt(market.cometAddress, COMET, 'balanceOf', [lender]);
        state = await freshCometState(app, lender);
        Object.assign(measured, { suppliedOnChain: supplied, dashboardBaseBalance: state.baseAsset.balance });
        // Comet credits up to 2 base units less than it supplies.
        expect(units(1_000) - supplied).toBeGreaterThanOrEqual(0n);
        expect(units(1_000) - supplied).toBeLessThanOrEqual(2n);
        expect(state.baseAsset.balance).toBe(supplied);

        await standardWrite(app, ({ writeComet }) =>
          writeComet.invokeBulker(
            loadedMarket,
            [[ActionType.Withdraw, state.baseAsset, MAX_UINT256]],
            state.baseAsset,
            state.collateralAssets,
            'Withdraw everything',
            0
          )
        );
        const left = await readBigInt(market.cometAddress, COMET, 'balanceOf', [lender]);
        const wallet = await readBigInt(market.baseTokenAddress, ERC20, 'balanceOf', [lender]);
        Object.assign(measured, { suppliedAfterWithdraw: left, walletAfterWithdraw: wallet });
        expect(left).toBe(0n);
        expect(units(10_000) - wallet).toBeLessThanOrEqual(2n);
      } finally {
        app.unmount();
        await anvil.unfreezeTime();
      }
    })
  );
});

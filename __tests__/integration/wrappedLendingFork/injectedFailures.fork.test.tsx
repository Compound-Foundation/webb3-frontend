import { act } from '@testing-library/react';
import { utils } from 'ethers';

import { WrappedStepState } from '@hooks/useWrappedAction';
import { parseExactUnits } from '@hooks/useWriteWrappedState';

import {
  COMET,
  dealToken,
  ERC20,
  expectExitPaid,
  forkAccount,
  FORK_MARKETS,
  prepareAccount,
  read,
  readBigInt,
  receiptEffects,
  revertDataOf,
  sendFrom,
  units,
  WRAPPER,
} from './fixtures';
import { anvil, assertLocalFork } from './fork';
import {
  backdateAccrual,
  donateToWrapper,
  drainCash,
  fundedAccount,
  nonceOf,
  onSnapshot,
  pauseComet,
  supplyDirectly,
  zeroTransferTo,
} from './injections';
import { scenario } from './results';
import { renderWrappedApp, WrappedApp } from './wrappedApp';

const ERROR_STRING = '0x08c379a0';

/** A revert as the chain gives it: a reason string, a named Comet or wrapper error, or no data. */
function revertName(data: string | undefined): string {
  if (data === undefined) return 'no revert';
  if (data === '0x') return 'revert without data';
  if (data.startsWith(ERROR_STRING))
    return `Error(${utils.defaultAbiCoder.decode(['string'], `0x${data.slice(10)}`)[0]})`;
  for (const contract of [WRAPPER, COMET]) {
    try {
      return contract.parseError(data).name;
    } catch {
      // Another contract's error.
    }
  }
  return `revert data ${data.slice(0, 10)}`;
}

const blockedMessage = (step: WrappedStepState) =>
  step.status === 'blocked' ? step.message ?? step.reason : step.status;

describe.each(FORK_MARKETS)('$label', (forkMarket) => {
  const { market, symbol, label } = forkMarket;
  const account = forkAccount('injected', forkMarket);
  const exitOf = (shares: bigint) => ({
    to: market.wrapperAddress,
    data: WRAPPER.encodeFunctionData('unwrapAndWithdraw', [shares]),
  });
  const sharesOf = (holder: string) => readBigInt(market.wrapperAddress, WRAPPER, 'balanceOf', [holder]);

  beforeAll(assertLocalFork);

  /** Renders the app for `holder` for the length of `run`. */
  async function withApp<T>(run: (app: WrappedApp) => Promise<T>, holder = account): Promise<T> {
    const app = await renderWrappedApp({ market, symbol, account: holder, cometAddress: market.cometAddress });
    try {
      return await run(app);
    } finally {
      app.unmount();
    }
  }

  /** The account with a 2,000 wrapped position, supplied outside the app. */
  async function setUp() {
    await fundedAccount(market, account, units(10_000));
    await supplyDirectly(market, account, units(2_000));
  }

  /** Confirms the step in review and expects the lifecycle to stop it with nothing sent. */
  async function expectStoppedBeforeSignature(app: WrappedApp) {
    const nonce = await nonceOf(account);
    const { number } = await anvil.latestBlock();
    const step = await app.confirmStep();
    expect(step.status).toBe('blocked');
    expect(await nonceOf(account)).toBe(nonce);
    expect((await anvil.latestBlock()).number).toBe(number);
    return step;
  }

  scenario('dust', label, (measured) =>
    onSnapshot(async () => {
      await setUp();
      const holder = await prepareAccount(forkAccount('dust holder', forkMarket));
      // Shares worth about two base units, below the buffer of three.
      const dustShares = 2n * 10n ** 12n;
      await sendFrom(account, {
        to: market.wrapperAddress,
        data: ERC20.encodeFunctionData('transfer', [holder, dustShares]),
      });
      await withApp(async (app) => {
        const position = await app.positionShowing(dustShares);
        Object.assign(measured, {
          dustShares,
          dustValue: position.grossAssets,
          redeemBuffer: position.redeemBuffer,
          panelFullExitCash: position.fullExitCash,
        });
        expect(position.grossAssets).toBeLessThanOrEqual(position.redeemBuffer);
        expect(position.fullExitCash).toBe(0n);
        expect(await app.startWithdraw({ kind: 'full' })).toBeUndefined();
        measured.reviewRefusal = app.readFailure() ?? 'none';
        expect(app.readFailure()).toMatch(/rounding buffer.*\(ZeroAssetsTransferred\)/);
      }, holder);
      const revert = await revertDataOf(holder, exitOf(dustShares));
      measured.onChainRevert = revertName(revert);
      expect(measured.onChainRevert).toBe('ZeroAssetsTransferred');

      // A partial exit of the whole position's cash leaves shares worth less than a base unit, which
      // cannot leave on their own.
      await withApp(async (app) => {
        const position = await app.refreshPosition();
        expect(await app.startWithdraw({ kind: 'partial', cash: position.fullExitCash })).toBeUndefined();
        const review = app.draft().withdrawal;
        if (review === undefined) throw new Error('The withdrawal draft has no quote.');
        await anvil.setNextBlockTimestamp((await anvil.latestBlock()).timestamp);
        const effects = await receiptEffects(market, account, app.receiptOf(await app.confirmStep()));
        Object.assign(measured, {
          wholeCashRequested: position.fullExitCash,
          wholeCashPaid: effects.cashDelta,
          leavesDustFlag: review.quote.leavesDust,
          leftoverShares: effects.after.shares,
        });
        expectExitPaid(effects, review.quote);
        expect(review.quote.leavesDust).toBe(effects.after.shares > 0n);
        expect(effects.after.shares).toBeGreaterThan(0n);
        expect(await app.startWithdraw({ kind: 'full' })).toBeUndefined();
        measured.leftoverRefusal = app.readFailure() ?? 'none';
        expect(app.readFailure()).toMatch(/\(ZeroAssetsTransferred\)/);
        measured.leftoverOnChainRevert = revertName(await revertDataOf(account, exitOf(effects.after.shares)));
        expect(measured.leftoverOnChainRevert).toBe('ZeroAssetsTransferred');
      });
    })
  );

  scenario('pause', label, (measured) =>
    onSnapshot(async () => {
      await setUp();
      await withApp(async (app) => {
        expect(await app.startWithdraw({ kind: 'partial', cash: units(100) })).toBeUndefined();
        expect(app.state().phase).toBe('review');
        measured.pauseGuardian = await pauseComet(market, { withdraw: true });
        const step = await expectStoppedBeforeSignature(app);
        measured.reviewedExitStop = step.status === 'blocked' ? step.reason : step.status;
        expect(step).toMatchObject({ status: 'blocked', reason: 'withdraw-paused' });
        expect(await app.startWithdraw({ kind: 'full' })).toBeUndefined();
        measured.freshExitRefusal = app.readFailure() ?? 'none';
        expect(app.readFailure()).toMatch(/Withdrawals from this market are paused/);
      });
      measured.onChainExitRevert = revertName(await revertDataOf(account, exitOf(await sharesOf(account))));
      expect(measured.onChainExitRevert).toBe('Paused');

      await pauseComet(market, { supply: true });
      await withApp(async (app) => {
        expect(await app.startSupply(units(100))).toBeUndefined();
        const step = await expectStoppedBeforeSignature(app);
        measured.reviewedSupplyStop = step.status === 'blocked' ? step.reason : step.status;
        expect(step).toMatchObject({ status: 'blocked', reason: 'supply-paused' });
      });
      await sendFrom(account, {
        to: market.baseTokenAddress,
        data: ERC20.encodeFunctionData('approve', [market.wrapperAddress, units(100)]),
      });
      const supply = { to: market.wrapperAddress, data: WRAPPER.encodeFunctionData('supplyAndWrap', [units(100)]) };
      measured.onChainSupplyRevert = revertName(await revertDataOf(account, supply));
      expect(measured.onChainSupplyRevert).toBe('Paused');

      // Once the guardian lifts the pause, a fresh exit review signs and pays exactly its check's quote.
      await pauseComet(market, {});
      await withApp(async (app) => {
        expect(await app.startWithdraw({ kind: 'partial', cash: units(100) })).toBeUndefined();
        await anvil.setNextBlockTimestamp((await anvil.latestBlock()).timestamp);
        const step = await app.confirmStep();
        measured.afterUnpause = step.status;
        expect(step.status).toBe('confirmed');
        const effects = await receiptEffects(market, account, app.receiptOf(step));
        const rechecked = app.rechecked();
        if (rechecked === undefined) throw new Error('The check returned no quote.');
        measured.afterUnpausePaid = effects.cashDelta;
        expectExitPaid(effects, rechecked.quote);
      });
    })
  );

  scenario('insufficient-liquidity', label, (measured) =>
    onSnapshot(async () => {
      await setUp();
      await withApp(async (app) => {
        const panel = await app.refreshPosition();
        expect(await app.startWithdraw({ kind: 'full' }, panel.fullExitCash)).toBeUndefined();
        expect(app.state().phase).toBe('review');
        const drain = await drainCash(market, forkAccount('borrower', forkMarket), units(50));
        Object.assign(measured, { borrowed: drain.borrowed, wethCollateral: drain.weth, cashLeft: drain.cashLeft });
        const step = await expectStoppedBeforeSignature(app);
        measured.reviewedExitStop = blockedMessage(step);
        expect(measured.reviewedExitStop).toMatch(/The market now holds only 50\.000000/);

        expect(await app.startWithdraw({ kind: 'full' }, panel.fullExitCash)).toBeUndefined();
        const refusal = app.readFailure() ?? '';
        measured.fullExitRefusal = refusal;
        const most = /Withdraw at most ([\d,]+\.\d+)/.exec(refusal);
        const maxPartial = most === null ? undefined : parseExactUnits(most[1].replace(/,/g, ''), market.baseDecimals);
        if (maxPartial === undefined) throw new Error(`The refusal names no amount: ${refusal}`);
        measured.maxPartialCash = maxPartial;
        expect(maxPartial).toBeLessThanOrEqual(drain.cashLeft);

        expect(await app.startWithdraw({ kind: 'partial', cash: maxPartial + 1n })).toBeUndefined();
        measured.aboveMaxRefusal = app.readFailure() ?? 'none';
        expect(app.readFailure()).toMatch(/The market holds only 50\.000000/);

        // The most the refusal offers is an exit the deployed wrapper and Comet pay in full.
        expect(await app.startWithdraw({ kind: 'partial', cash: maxPartial })).toBeUndefined();
        const review = app.draft().withdrawal;
        if (review === undefined) throw new Error('The withdrawal draft has no quote.');
        await anvil.setNextBlockTimestamp((await anvil.latestBlock()).timestamp);
        const effects = await receiptEffects(market, account, app.receiptOf(await app.confirmStep()));
        Object.assign(measured, {
          maxPartialQuoted: review.quote.cash,
          maxPartialPaid: effects.cashDelta,
          cashLeftAfter: effects.after.cometCash,
        });
        expectExitPaid(effects, review.quote);
      });
      // Comet's transfer of more base token than it holds: USDC reverts with its reason, USDT without data.
      measured.onChainFullExitRevert = revertName(await revertDataOf(account, exitOf(await sharesOf(account))));
      expect(measured.onChainFullExitRevert).toBe(
        symbol === 'USDT' ? 'revert without data' : 'Error(ERC20: transfer amount exceeds balance)'
      );
    })
  );

  scenario('excessive-debit', label, (measured) =>
    onSnapshot(async () => {
      await setUp();
      let injected = await backdateAccrual(market);
      if (injected === undefined) {
        // The market's rate is too low to reach the lag after the epoch. A borrow of nearly all its
        // cash raises the rate, and the cash left still pays these exits.
        const drain = await drainCash(market, forkAccount('borrower', forkMarket), units(1_000));
        measured.rateRaisedByBorrowing = drain.borrowed;
        injected = await backdateAccrual(market);
      }
      if (injected === undefined) throw new Error('The accrual cannot be back-dated far enough on this market.');
      Object.assign(measured, {
        storedIndex: injected.storedIndex,
        backdatedSeconds: injected.elapsedSeconds,
        supplyRatePerSecond: injected.supplyRate,
      });
      await withApp(async (app) => {
        // Search partial exits through the app's own review and pre-signature check for one the
        // deployed wrapper refuses.
        let found: { cash: bigint; shares: bigint; message: string } | undefined;
        let tried = 0;
        for (let cash = units(100); tried < 800 && found === undefined; cash += 7_919n, tried++) {
          expect(await app.startWithdraw({ kind: 'partial', cash })).toBeUndefined();
          const draft = app.draft();
          const check = await draft.steps[0].check?.();
          if (check !== undefined && !check.ok && /ExcessiveAssetsDebited/.test(check.message)) {
            found = { cash, shares: draft.amount, message: check.message };
          }
          act(() => app.result.current.action.discard());
        }
        measured.candidatesTried = tried;
        if (found === undefined)
          throw new Error(`None of ${tried} partial exits reverted with ExcessiveAssetsDebited.`);
        Object.assign(measured, { cash: found.cash, shares: found.shares, checkMessage: found.message });

        expect(await app.startWithdraw({ kind: 'partial', cash: found.cash })).toBeUndefined();
        const step = await expectStoppedBeforeSignature(app);
        measured.lifecycleStop = blockedMessage(step);
        expect(step).toMatchObject({ status: 'blocked', reason: 'step-check-failed' });
        expect(measured.lifecycleStop).toMatch(/\(ExcessiveAssetsDebited\)/);

        const revert = await revertDataOf(account, exitOf(found.shares));
        const parsed = revert === undefined ? undefined : WRAPPER.parseError(revert);
        expect(parsed?.name).toBe('ExcessiveAssetsDebited');
        measured.sharesRequired = BigInt(parsed?.args.sharesRequired.toString() ?? '0');
        measured.sharesBurned = BigInt(parsed?.args.sharesBurned.toString() ?? '0');
        // Sent outside the app, in a block with the simulated block's timestamp so that Comet accrues
        // to the same index. A later block accrues further, and can pay the same shares instead.
        await anvil.setNextBlockTimestamp((await anvil.latestBlock()).timestamp);
        const sent = await sendFrom(account, exitOf(found.shares), false);
        measured.sentOutsideAppStatus = sent.receipt.status ?? -1;
        expect(sent.receipt.status).toBe(0);
      });
    })
  );

  scenario('estimate-rose', label, (measured) =>
    onSnapshot(async () => {
      await setUp();
      const donor = await prepareAccount(forkAccount('donor', forkMarket));
      await withApp(async (app) => {
        // After a donation to the wrapper, a partial exit's shares pay more than 0.1% above the
        // reviewed cash. The exit stops for a fresh review, which burns fewer shares for the amount.
        expect(await app.startWithdraw({ kind: 'partial', cash: units(500) })).toBeUndefined();
        const stale = app.draft().withdrawal?.quote;
        if (stale === undefined) throw new Error('The withdrawal draft has no quote.');
        // At least 0.5% of the wrapper's assets, so that each share's value rises well past 0.1%.
        const wrapperAssets = await readBigInt(market.cometAddress, COMET, 'balanceOf', [market.wrapperAddress]);
        const donation = wrapperAssets / 200n > units(100) ? wrapperAssets / 200n : units(100);
        measured.donation = donation;
        await dealToken(market.baseTokenAddress, donor, 2n * donation);
        await donateToWrapper(market, donor, donation);
        measured.partialStop = blockedMessage(await expectStoppedBeforeSignature(app));
        expect(measured.partialStop).toMatch(/more than 0\.1% above the 500\.000000 .* you reviewed/);
        expect(await app.startWithdraw({ kind: 'partial', cash: units(500) })).toBeUndefined();
        const fresh = app.draft().withdrawal?.quote;
        if (fresh === undefined) throw new Error('The withdrawal draft has no quote.');
        await anvil.setNextBlockTimestamp((await anvil.latestBlock()).timestamp);
        const partial = await receiptEffects(market, account, app.receiptOf(await app.confirmStep()));
        Object.assign(measured, {
          staleShares: stale.shares,
          freshShares: fresh.shares,
          freshQuotedCash: fresh.cash,
          freshPaidCash: partial.cashDelta,
        });
        expect(fresh.shares).toBeLessThan(stale.shares);
        expectExitPaid(partial, fresh);

        // A full exit goes on however much its shares come to pay. It pays what the check quoted at
        // the signature's block, which the dialog then shows.
        expect(await app.startWithdraw({ kind: 'full' })).toBeUndefined();
        const reviewed = app.draft().withdrawal?.quote;
        if (reviewed === undefined) throw new Error('The withdrawal draft has no quote.');
        await donateToWrapper(market, donor, donation);
        await anvil.setNextBlockTimestamp((await anvil.latestBlock()).timestamp);
        const full = await receiptEffects(market, account, app.receiptOf(await app.confirmStep()));
        const rechecked = app.rechecked();
        if (rechecked === undefined) throw new Error('The check returned no quote.');
        Object.assign(measured, {
          fullReviewedCash: reviewed.cash,
          fullRecheckedCash: rechecked.quote.cash,
          fullPaidCash: full.cashDelta,
          fullRecheckedDescription: rechecked.description,
        });
        expect(rechecked.quote.shares).toBe(reviewed.shares);
        expect(rechecked.quote.cash).toBeGreaterThan(reviewed.cash);
        expectExitPaid(full, rechecked.quote);
        expect(full.after.shares).toBe(0n);
      });
    })
  );

  scenario('stale-state', label, (measured) =>
    onSnapshot(async () => {
      await setUp();
      const thirdParty = await fundedAccount(market, forkAccount('third party', forkMarket), units(10_000));
      await withApp(async (app) => {
        // A partial exit whose shares partly leave the account before the signature.
        expect(await app.startWithdraw({ kind: 'partial', cash: units(500) })).toBeUndefined();
        const partial = app.draft().withdrawal?.quote;
        if (partial === undefined) throw new Error('The withdrawal draft has no quote.');
        const held = await sharesOf(account);
        await sendFrom(account, {
          to: market.wrapperAddress,
          data: ERC20.encodeFunctionData('transfer', [thirdParty, held - partial.shares + 1n]),
        });
        measured.sharesMovedStop = blockedMessage(await expectStoppedBeforeSignature(app));
        expect(measured.sharesMovedStop).toMatch(/below the shares this withdrawal burns/);

        // A full exit whose balance grows before the signature.
        expect(await app.startWithdraw({ kind: 'full' })).toBeUndefined();
        await supplyDirectly(market, account, units(10));
        measured.sharesAddedStop = blockedMessage(await expectStoppedBeforeSignature(app));
        expect(measured.sharesAddedStop).toMatch(/no longer burns exactly all your shares/);

        // A partial exit whose shares pay less once a third party's zero transfers to the wrapper
        // take principal from it. The blocks keep the review's timestamp, so no interest offsets it.
        expect(await app.startWithdraw({ kind: 'partial', cash: units(500) })).toBeUndefined();
        const review = await anvil.latestBlock();
        const wrapperPrincipal = async () =>
          BigInt((await read(market.cometAddress, COMET, 'userBasic', [market.wrapperAddress])).principal.toString());
        const assetsBefore = await readBigInt(market.cometAddress, COMET, 'balanceOf', [market.wrapperAddress]);
        const principalBefore = await wrapperPrincipal();
        for (let transfer = 0; transfer < 3; transfer++) {
          await anvil.setNextBlockTimestamp(review.timestamp);
          await zeroTransferTo(market, thirdParty);
        }
        measured.wrapperAssetsShaved =
          assetsBefore - (await readBigInt(market.cometAddress, COMET, 'balanceOf', [market.wrapperAddress]));
        measured.wrapperPrincipalShaved = principalBefore - (await wrapperPrincipal());
        measured.cashFellStop = blockedMessage(await expectStoppedBeforeSignature(app));
        expect(measured.cashFellStop).toMatch(/now pays about .*, less than the .* you reviewed/);

        // A supply whose allowance changes before its approval is signed.
        expect(await app.startSupply(units(500))).toBeUndefined();
        expect(app.draft().steps.map((step) => step.kind)).toEqual(['approve', 'supply-and-wrap']);
        await sendFrom(account, {
          to: market.baseTokenAddress,
          data: ERC20.encodeFunctionData('approve', [market.wrapperAddress, units(123)]),
        });
        measured.allowanceChangedStop = blockedMessage(await expectStoppedBeforeSignature(app));
        expect(measured.allowanceChangedStop).toMatch(/allowance is now 123\.000000 .*not what this review expected/);

        // A supply whose wallet balance falls below it before the supply is signed.
        await sendFrom(account, {
          to: market.baseTokenAddress,
          data: ERC20.encodeFunctionData('approve', [market.wrapperAddress, 0]),
        });
        expect(await app.startSupply(units(500))).toBeUndefined();
        const wallet = await readBigInt(market.baseTokenAddress, ERC20, 'balanceOf', [account]);
        await sendFrom(account, {
          to: market.baseTokenAddress,
          data: ERC20.encodeFunctionData('transfer', [thirdParty, wallet - units(100)]),
        });
        measured.balanceFellStop = blockedMessage(await expectStoppedBeforeSignature(app));
        expect(measured.balanceFellStop).toMatch(/Your wallet now holds 100\.000000 .*, less than this supply/);
      });
    })
  );
});

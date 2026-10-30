import { WRAPPED_SUPPLY_STEP_IDS, WRAPPED_WITHDRAW_STEP_ID } from '@hooks/useWriteWrappedState';

import {
  balanceSlotOf,
  COMET,
  dealToken,
  ERC20,
  expectExitPaid,
  forkAccount,
  FORK_MARKETS,
  FORK_ONLY,
  prepareAccount,
  readAccount,
  readBigInt,
  receiptEffects,
  revertDataOf,
  sendFrom,
  units,
  WRAPPER,
} from './fixtures';
import { anvil, assertLocalFork } from './fork';
import { NotExercisedOnThisFork, scenario } from './results';
import { renderWrappedApp, WrappedApp } from './wrappedApp';

/** One Ethereum slot: how long a mainnet transaction waits at least after the block it was quoted at. */
const SLOT_SECONDS = 12;
const ONE_DAY = 24 * 60 * 60;
const THIRTY_DAYS = 30 * ONE_DAY;

const decodeCall = (data: string) => {
  for (const contract of [ERC20, WRAPPER]) {
    try {
      const call = contract.parseTransaction({ data });
      return { method: call.name, args: call.args.map((arg: { toString(): string }) => BigInt(arg.toString())) };
    } catch {
      // Another contract's call.
    }
  }
  throw new Error(`Undecodable step ${data.slice(0, 10)}.`);
};

describe.each(FORK_MARKETS)('$label', (forkMarket) => {
  const { market, symbol, label } = forkMarket;
  const account = forkAccount('lender', forkMarket);
  let snapshot: string;
  let app: WrappedApp;
  let supplied = 0n;
  let withdrawn = 0n;

  beforeAll(async () => {
    await assertLocalFork();
    snapshot = await anvil.snapshot();
    await prepareAccount(account);
    await dealToken(market.baseTokenAddress, account, units(10_000));
    app = await renderWrappedApp({ market, symbol, account, cometAddress: market.cometAddress });
  });

  afterAll(async () => {
    app?.unmount();
    await anvil.revert(snapshot);
  });

  /** Confirms every step of the draft in review, in order, and returns their receipts. */
  async function confirmAll() {
    const receipts = [];
    for (let index = 0; index < app.draft().steps.length; index++) {
      receipts.push(app.receiptOf(await app.confirmStep()));
    }
    return receipts;
  }

  /** Checks a supply's receipt against what the review asked: the exact amount out of the wallet. */
  async function expectSupplied(
    amount: bigint,
    receipt: Parameters<typeof receiptEffects>[2],
    measured: Record<string, unknown>
  ) {
    const effects = await receiptEffects(market, account, receipt);
    const minted = BigInt(effects.deposit?.args.shares.toString() ?? '-1');
    const credited = BigInt(effects.deposit?.args.assets.toString() ?? '-1');
    Object.assign(measured, {
      supplyBlock: receipt.blockNumber,
      supplyGasLimit: effects.gasLimit,
      supplyGasUsed: effects.gasUsed,
      amount,
      walletDelta: effects.cashDelta,
      shareDelta: effects.shareDelta,
      minted,
      cometCredited: credited,
    });
    expect(effects.cashDelta).toBe(-amount);
    expect(effects.shareDelta).toBe(minted);
    expect(minted).toBeGreaterThan(0n);
    // Comet credits the wrapper up to 2 base units less than it supplies (its floor on each side).
    expect(amount - credited).toBeGreaterThanOrEqual(0n);
    expect(amount - credited).toBeLessThanOrEqual(2n);
    const panel = await app.positionShowing(effects.after.shares);
    // The panel's value of all the account's shares, at the block after the supply.
    measured.panelGrossAssets = panel.grossAssets;
    measured.panelFullExitCash = panel.fullExitCash;
    supplied += amount;
    return effects;
  }

  scenario('supply-zero-allowance', label, async (measured) => {
    const amount = units(1_000);
    expect((await readAccount(market, account, await app.readProvider.getBlockNumber())).allowance).toBe(0n);
    // Approve & Add asks for the approval alone, and Submit for the supply alone.
    expect(await app.startApproval(amount)).toBeUndefined();
    const draft = app.draft();
    expect(draft.steps.map((step) => step.id)).toEqual([WRAPPED_SUPPLY_STEP_IDS.approve]);
    expect(decodeCall(draft.steps[0].request.data)).toEqual({
      method: 'approve',
      args: [BigInt(market.wrapperAddress), amount],
    });
    const [approval] = await confirmAll();
    expect(await app.startSupply(amount)).toBeUndefined();
    expect(app.draft().steps.map((step) => step.id)).toEqual([WRAPPED_SUPPLY_STEP_IDS.supply]);
    measured.steps = [...draft.steps, ...app.draft().steps].map((step) => step.id).join(' > ');
    const [supply] = await confirmAll();
    measured.allowanceAfterApproval = await readBigInt(
      market.baseTokenAddress,
      ERC20,
      'allowance',
      [account, market.wrapperAddress],
      approval.blockNumber
    );
    expect(measured.allowanceAfterApproval).toBe(amount);
    const effects = await expectSupplied(amount, supply, measured);
    measured.allowanceAfterSupply = effects.after.allowance;
    expect(effects.after.allowance).toBe(0n);
    measured.balanceSlot = balanceSlotOf(market.baseTokenAddress) ?? -1;
  });

  scenario('supply-sufficient-allowance', label, async (measured) => {
    const amount = units(1_000);
    // The account approved more than the supply earlier, outside the app.
    await sendFrom(account, {
      to: market.baseTokenAddress,
      data: ERC20.encodeFunctionData('approve', [market.wrapperAddress, 2n * amount]),
    });
    expect(await app.startSupply(amount)).toBeUndefined();
    measured.steps = app
      .draft()
      .steps.map((step) => step.id)
      .join(' > ');
    expect(app.draft().steps.map((step) => step.id)).toEqual([WRAPPED_SUPPLY_STEP_IDS.supply]);
    const [supply] = await confirmAll();
    const effects = await expectSupplied(amount, supply, measured);
    measured.allowanceAfterSupply = effects.after.allowance;
    expect(effects.after.allowance).toBe(amount);
  });

  scenario('supply-insufficient-allowance', label, async (measured) => {
    // The allowance left by the previous supply is 1,000, below this supply.
    const amount = units(1_500);
    const allowance = await readBigInt(market.baseTokenAddress, ERC20, 'allowance', [account, market.wrapperAddress]);
    measured.allowanceBefore = allowance;
    expect(allowance).toBe(units(1_000));
    // Whether the token itself refuses to change one nonzero allowance to another, from the chain.
    const directApprove = {
      to: market.baseTokenAddress,
      data: ERC20.encodeFunctionData('approve', [market.wrapperAddress, amount]),
    };
    const refusal = await revertDataOf(account, directApprove);
    measured.nonzeroToNonzeroApproveReverts = refusal !== undefined;
    measured.nonzeroToNonzeroRevertData = refusal ?? 'none';
    expect(measured.nonzeroToNonzeroApproveReverts).toBe(symbol === 'USDT');

    expect(await app.startApproval(amount)).toBeUndefined();
    const ids = app.draft().steps.map((step) => step.id);
    const expectedIds =
      symbol === 'USDT'
        ? [WRAPPED_SUPPLY_STEP_IDS.reset, WRAPPED_SUPPLY_STEP_IDS.approve]
        : [WRAPPED_SUPPLY_STEP_IDS.approve];
    expect(ids).toEqual(expectedIds);
    const approvals = app.draft().steps.map((step) => decodeCall(step.request.data).args[1]);
    expect(approvals).toEqual(symbol === 'USDT' ? [0n, amount] : [amount]);

    const receipts = await confirmAll();
    expect(await app.startSupply(amount)).toBeUndefined();
    measured.steps = [...ids, ...app.draft().steps.map((step) => step.id)].join(' > ');
    receipts.push(...(await confirmAll()));
    if (symbol === 'USDT') {
      measured.allowanceAfterReset = await readBigInt(
        market.baseTokenAddress,
        ERC20,
        'allowance',
        [account, market.wrapperAddress],
        receipts[0].blockNumber
      );
      expect(measured.allowanceAfterReset).toBe(0n);
    }
    const effects = await expectSupplied(amount, receipts[receipts.length - 1], measured);
    expect(effects.after.allowance).toBe(0n);
  });

  /**
   * Comet's supply rate at the latest block. At a rate of 0, no interest accrues, so a scenario about
   * interest is recorded as not exercised.
   */
  async function supplyRateForInterest() {
    const utilization = await readBigInt(market.cometAddress, COMET, 'getUtilization');
    const supplyRate = await readBigInt(market.cometAddress, COMET, 'getSupplyRate', [utilization]);
    if (supplyRate === 0n) {
      const block = await anvil.latestBlock();
      throw new NotExercisedOnThisFork(`Comet's supply rate is 0 at block ${block.number}, so no interest accrues.`);
    }
    return supplyRate;
  }

  scenario('accrued-value', label, async (measured) => {
    await supplyRateForInterest();
    const before = await app.refreshPosition();
    const startBlock = await anvil.latestBlock();
    await anvil.increaseTime(THIRTY_DAYS);
    await anvil.mine();
    const endBlock = await anvil.latestBlock();
    const after = await app.refreshPosition();
    // The wrapper's own public conversion of the same shares at the same block, which rounds down.
    const onChainValue = await readBigInt(market.wrapperAddress, FORK_ONLY, 'convertToAssets', [after.shares]);
    Object.assign(measured, {
      seconds: endBlock.timestamp - startBlock.timestamp,
      shares: after.shares,
      panelGrossBefore: before.grossAssets,
      panelGrossAfter: after.grossAssets,
      accrued: after.grossAssets - before.grossAssets,
      convertToAssets: onChainValue,
      panelFullExitCash: after.fullExitCash,
      redeemBuffer: after.redeemBuffer,
      supplied,
    });
    expect(after.shares).toBe(before.shares);
    expect(after.grossAssets).toBeGreaterThan(before.grossAssets);
    expect(after.grossAssets).toBeGreaterThan(supplied);
    expect(after.grossAssets).toBe(onChainValue);
  });

  scenario('partial-exit', label, async (measured) => {
    const requested = units(1_000);
    expect(await app.startWithdraw({ kind: 'partial', cash: requested })).toBeUndefined();
    const draft = app.draft();
    const review = draft.withdrawal;
    if (review === undefined) throw new Error('The withdrawal draft has no quote.');
    expect(draft.steps.map((step) => step.id)).toEqual([WRAPPED_WITHDRAW_STEP_ID]);
    expect(decodeCall(draft.steps[0].request.data)).toEqual({
      method: 'unwrapAndWithdraw',
      args: [review.quote.shares],
    });
    // The exit is mined in a block with the quote block's own timestamp, so the wrapper prices it
    // from exactly the state the quote read.
    const quoteBlock = await anvil.latestBlock();
    expect(quoteBlock.number).toBe(review.blockNumber);
    await anvil.setNextBlockTimestamp(quoteBlock.timestamp);
    const receipt = app.receiptOf(await app.confirmStep());
    const effects = await receiptEffects(market, account, receipt);
    const rechecked = app.rechecked();
    Object.assign(measured, {
      quoteBlock: review.blockNumber,
      checkBlock: rechecked?.blockNumber ?? -1,
      recheckedCash: rechecked?.quote.cash ?? -1n,
      exitBlock: receipt.blockNumber,
      requested,
      quotedShares: review.quote.shares,
      quotedCash: review.quote.cash,
      quotedGross: review.quote.grossAssets,
      redeemBuffer: review.quote.redeemBuffer,
      paidCash: effects.cashDelta,
      burnedShares: -effects.shareDelta,
      eventShares: BigInt(effects.withdraw?.args.shares.toString() ?? '-1'),
      eventDebited: BigInt(effects.withdraw?.args.assets.toString() ?? '-1'),
      cashMinusQuote: effects.cashDelta - review.quote.cash,
      cashPaidByTransfer: effects.cashPaidToAccount,
      exitGasLimit: effects.gasLimit,
      exitGasUsed: effects.gasUsed,
    });
    expect(review.quote.cash).toBeGreaterThanOrEqual(requested);
    // The check read the review's own block, so its quote of the same shares is the reviewed one.
    expect(rechecked?.quote).toEqual(review.quote);
    expectExitPaid(effects, review.quote);
    await app.positionShowing(effects.after.shares);
    withdrawn += effects.cashDelta;
  });

  scenario('partial-exit-delayed', label, async (measured) => {
    const requested = units(500);
    expect(await app.startWithdraw({ kind: 'partial', cash: requested })).toBeUndefined();
    const review = app.draft().withdrawal;
    if (review === undefined) throw new Error('The withdrawal draft has no quote.');
    const quoteBlock = await anvil.latestBlock();
    expect(quoteBlock.number).toBe(review.blockNumber);
    // The bound comes from the chain, not from the app's arithmetic. It is what the wrapper's own
    // `convertToAssets` says the shares are worth, times Comet's supply rate for one slot, rounded
    // up. The payout and the quote each round down, so they differ by at most 1 unit more than the
    // interest. Comet's rounding of the wrapper's balance adds less than 1 unit more to the shares'
    // value. No other transaction touches Comet between the quote and the exit.
    const worth = await readBigInt(market.wrapperAddress, FORK_ONLY, 'convertToAssets', [review.quote.shares]);
    const utilization = await readBigInt(market.cometAddress, COMET, 'getUtilization');
    const supplyRate = await readBigInt(market.cometAddress, COMET, 'getSupplyRate', [utilization]);
    const interestBound = (worth * supplyRate * BigInt(SLOT_SECONDS) + 10n ** 18n - 1n) / 10n ** 18n + 2n;
    await anvil.setNextBlockTimestamp(quoteBlock.timestamp + SLOT_SECONDS);
    const receipt = app.receiptOf(await app.confirmStep());
    const effects = await receiptEffects(market, account, receipt);
    Object.assign(measured, {
      requested,
      quotedShares: review.quote.shares,
      quotedCash: review.quote.cash,
      paidCash: effects.cashDelta,
      burnedShares: -effects.shareDelta,
      secondsAfterQuote: SLOT_SECONDS,
      cashMinusQuote: effects.cashDelta - review.quote.cash,
      upperBound: interestBound,
      supplyRatePerSecond: supplyRate,
    });
    expect(-effects.shareDelta).toBe(review.quote.shares);
    expect(BigInt(effects.withdraw?.args.shares.toString() ?? '-1')).toBe(review.quote.shares);
    expect(effects.cashPaidToAccount).toBe(effects.cashDelta);
    expect(effects.cashDelta - review.quote.cash).toBeGreaterThanOrEqual(0n);
    expect(effects.cashDelta - review.quote.cash).toBeLessThanOrEqual(interestBound);
    await app.positionShowing(effects.after.shares);
    withdrawn += effects.cashDelta;
  });

  /**
   * Reviews a partial exit, leaves the review open as a user who confirms later does, and confirms
   * it. `secondsFor` sets how long, from Comet's supply rate at the review's block. Returns the
   * review, the check's quote at the confirmation's block and the step.
   */
  async function confirmAfter(requested: bigint, secondsFor: (secondsToBound: number) => number) {
    // The review reads the same block as this read, because no block is mined between them.
    const supplyRate = await supplyRateForInterest();
    expect(await app.startWithdraw({ kind: 'partial', cash: requested })).toBeUndefined();
    const review = app.draft().withdrawal;
    if (review === undefined) throw new Error('The withdrawal draft has no quote.');
    // Interest at this rate raises a payout by 0.1% in 10^15 ÷ supplyRate seconds.
    const secondsToBound = Number(10n ** 15n / supplyRate);
    const seconds = secondsFor(secondsToBound);
    await anvil.increaseTime(seconds);
    await anvil.mine();
    const checkBlock = await anvil.latestBlock();
    // A signed exit is mined at the check's own timestamp, so it pays what the check quoted.
    await anvil.setNextBlockTimestamp(checkBlock.timestamp);
    const nonce = await app.wallet.getTransactionCount(account, 'latest');
    const step = await app.confirmStep();
    return { review, step, checkBlock, seconds, secondsToBound, nonce };
  }

  scenario('partial-exit-held-open', label, async (measured) => {
    // A day, or a quarter of the time interest takes to reach the 0.1% bound if that is shorter.
    const { review, step, checkBlock, seconds, secondsToBound } = await confirmAfter(units(300), (toBound) =>
      Math.min(ONE_DAY, Math.floor(toBound / 4))
    );
    const effects = await receiptEffects(market, account, app.receiptOf(step));
    const rechecked = app.rechecked();
    if (rechecked === undefined) throw new Error('The check returned no quote.');
    // The rise in basis points (hundredths of a percent), to three decimals.
    const riseBasisPoints =
      Number(((rechecked.quote.cash - review.quote.cash) * 10_000_000n) / review.quote.cash) / 1_000;
    Object.assign(measured, {
      secondsOpen: seconds,
      quotedShares: review.quote.shares,
      quotedCash: review.quote.cash,
      recheckedCash: rechecked.quote.cash,
      riseBasisPoints,
      checkBlock: rechecked.blockNumber,
      paidCash: effects.cashDelta,
      burnedShares: -effects.shareDelta,
      cashMinusRecheck: effects.cashDelta - rechecked.quote.cash,
      // How long interest alone takes, at this rate, to raise a payout by the 0.1% bound.
      daysOfInterestToBound: Math.round((secondsToBound / ONE_DAY) * 10) / 10,
    });
    expect(rechecked.blockNumber).toBe(checkBlock.number);
    expect(rechecked.quote.shares).toBe(review.quote.shares);
    expect(rechecked.quote.cash).toBeGreaterThan(review.quote.cash);
    expectExitPaid(effects, rechecked.quote);
    await app.positionShowing(effects.after.shares);
    withdrawn += effects.cashDelta;
  });

  scenario('partial-exit-held-too-long', label, async (measured) => {
    // Twice the time interest takes to reach the 0.1% bound, so the exit stops.
    const { review, step, nonce, seconds } = await confirmAfter(units(300), (toBound) => 2 * toBound);
    measured.secondsOpen = seconds;
    measured.quotedCash = review.quote.cash;
    measured.stop = step.status === 'blocked' ? step.message ?? step.reason : step.status;
    expect(step).toMatchObject({ status: 'blocked', reason: 'step-check-failed' });
    expect(measured.stop).toMatch(/more than 0\.1% above the 300\.000000 .* you reviewed/);
    expect(await app.wallet.getTransactionCount(account, 'latest')).toBe(nonce);
    // A fresh review of the same amount burns fewer shares, and pays exactly its quote.
    expect(await app.startWithdraw({ kind: 'partial', cash: units(300) })).toBeUndefined();
    const fresh = app.draft().withdrawal;
    if (fresh === undefined) throw new Error('The withdrawal draft has no quote.');
    await anvil.setNextBlockTimestamp((await anvil.latestBlock()).timestamp);
    const effects = await receiptEffects(market, account, app.receiptOf(await app.confirmStep()));
    Object.assign(measured, {
      staleShares: review.quote.shares,
      freshShares: fresh.quote.shares,
      freshQuotedCash: fresh.quote.cash,
      freshPaidCash: effects.cashDelta,
    });
    expect(fresh.quote.shares).toBeLessThan(review.quote.shares);
    expectExitPaid(effects, fresh.quote);
    await app.positionShowing(effects.after.shares);
    withdrawn += effects.cashDelta;
  });

  scenario('full-exit', label, async (measured) => {
    const panel = await app.refreshPosition();
    expect(await app.startWithdraw({ kind: 'full' })).toBeUndefined();
    const review = app.draft().withdrawal;
    if (review === undefined) throw new Error('The withdrawal draft has no quote.');
    const quoteBlock = await anvil.latestBlock();
    const sharesHeld = await readBigInt(market.wrapperAddress, WRAPPER, 'balanceOf', [account]);
    expect(review.quote.kind).toBe('full');
    expect(review.quote.shares).toBe(sharesHeld);
    await anvil.setNextBlockTimestamp(quoteBlock.timestamp);
    const receipt = app.receiptOf(await app.confirmStep());
    const effects = await receiptEffects(market, account, receipt);
    withdrawn += effects.cashDelta;
    Object.assign(measured, {
      quotedShares: review.quote.shares,
      quotedCash: review.quote.cash,
      recheckedCash: app.rechecked()?.quote.cash ?? -1n,
      panelShownCash: panel.fullExitCash,
      paidCash: effects.cashDelta,
      burnedShares: -effects.shareDelta,
      sharesAfter: effects.after.shares,
      cashMinusQuote: effects.cashDelta - review.quote.cash,
      totalSupplied: supplied,
      totalWithdrawn: withdrawn,
    });
    expect(effects.after.shares).toBe(0n);
    expectExitPaid(effects, review.quote);
    // The panel read the same state, so the full-exit cash it showed is what the exit paid.
    expect(effects.cashDelta).toBe(panel.fullExitCash);
    expect((await app.positionShowing(0n)).fullExitCash).toBe(0n);
  });
});

import { WRAPPED_SUPPLY_STEP_IDS, WRAPPED_WITHDRAW_STEP_ID } from '@hooks/useWriteWrappedState';

import {
  balanceSlotOf,
  COMET,
  dealToken,
  ERC20,
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
import { scenario } from './results';
import { renderWrappedApp, WrappedApp } from './wrappedApp';

/** One Ethereum slot: how long a mainnet transaction waits at least after the block it was quoted at. */
const SLOT_SECONDS = 12;
const THIRTY_DAYS = 30 * 24 * 60 * 60;

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
    expect(await app.startSupply(amount)).toBeUndefined();
    const draft = app.draft();
    measured.steps = draft.steps.map((step) => step.id).join(' > ');
    expect(draft.steps.map((step) => step.id)).toEqual([
      WRAPPED_SUPPLY_STEP_IDS.approve,
      WRAPPED_SUPPLY_STEP_IDS.supply,
    ]);
    expect(decodeCall(draft.steps[0].request.data)).toEqual({
      method: 'approve',
      args: [BigInt(market.wrapperAddress), amount],
    });
    const [approval, supply] = await confirmAll();
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

    expect(await app.startSupply(amount)).toBeUndefined();
    const ids = app.draft().steps.map((step) => step.id);
    measured.steps = ids.join(' > ');
    const expectedIds =
      symbol === 'USDT'
        ? [WRAPPED_SUPPLY_STEP_IDS.reset, WRAPPED_SUPPLY_STEP_IDS.approve, WRAPPED_SUPPLY_STEP_IDS.supply]
        : [WRAPPED_SUPPLY_STEP_IDS.approve, WRAPPED_SUPPLY_STEP_IDS.supply];
    expect(ids).toEqual(expectedIds);
    const approvals = app
      .draft()
      .steps.filter((step) => step.kind === 'approve')
      .map((step) => decodeCall(step.request.data).args[1]);
    expect(approvals).toEqual(symbol === 'USDT' ? [0n, amount] : [amount]);

    const receipts = await confirmAll();
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

  scenario('accrued-value', label, async (measured) => {
    const before = await app.refreshPosition();
    const startBlock = await anvil.latestBlock();
    await anvil.increaseTime(THIRTY_DAYS);
    await anvil.mine();
    const endBlock = await anvil.latestBlock();
    const after = await app.refreshPosition();
    // The wrapper's own public conversion of the same shares at the same block, rounding down.
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
    expect(after.fullExitCash).toBe(after.grossAssets - after.redeemBuffer);
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
    Object.assign(measured, {
      quoteBlock: review.blockNumber,
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
    });
    expect(review.quote.cash).toBeGreaterThanOrEqual(requested);
    expect(effects.cashDelta).toBe(review.quote.cash);
    expect(effects.cashPaidToAccount).toBe(review.quote.cash);
    expect(-effects.shareDelta).toBe(review.quote.shares);
    expect(measured.eventShares).toBe(review.quote.shares);
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
    // The bound comes from Comet's own rate, not from the wrapper's arithmetic: the shares can gain
    // at most the interest the wrapper's whole Comet balance earns in one slot, plus a unit of floor
    // rounding on each of the two values.
    const wrapperAssets = await readBigInt(market.cometAddress, COMET, 'balanceOf', [market.wrapperAddress]);
    const utilization = await readBigInt(market.cometAddress, COMET, 'getUtilization');
    const supplyRate = await readBigInt(market.cometAddress, COMET, 'getSupplyRate', [utilization]);
    const interestBound = (wrapperAssets * supplyRate * BigInt(SLOT_SECONDS) + 10n ** 18n - 1n) / 10n ** 18n + 2n;
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
    expect(effects.cashDelta - review.quote.cash).toBeGreaterThanOrEqual(0n);
    expect(effects.cashDelta - review.quote.cash).toBeLessThanOrEqual(interestBound);
    await app.positionShowing(effects.after.shares);
    withdrawn += effects.cashDelta;
  });

  scenario('full-exit', label, async (measured) => {
    const panel = await app.refreshPosition();
    expect(await app.startWithdraw({ kind: 'full' }, panel.fullExitCash)).toBeUndefined();
    const review = app.draft().withdrawal;
    if (review === undefined) throw new Error('The withdrawal draft has no quote.');
    const quoteBlock = await anvil.latestBlock();
    const sharesHeld = await readBigInt(market.wrapperAddress, WRAPPER, 'balanceOf', [account]);
    expect(review.quote.kind).toBe('full');
    expect(review.quote.shares).toBe(sharesHeld);
    expect(review.shownCash).toBe(panel.fullExitCash);
    await anvil.setNextBlockTimestamp(quoteBlock.timestamp);
    const receipt = app.receiptOf(await app.confirmStep());
    const effects = await receiptEffects(market, account, receipt);
    withdrawn += effects.cashDelta;
    Object.assign(measured, {
      quotedShares: review.quote.shares,
      quotedCash: review.quote.cash,
      panelShownCash: panel.fullExitCash,
      paidCash: effects.cashDelta,
      burnedShares: -effects.shareDelta,
      sharesAfter: effects.after.shares,
      cashMinusQuote: effects.cashDelta - review.quote.cash,
      totalSupplied: supplied,
      totalWithdrawn: withdrawn,
    });
    expect(effects.after.shares).toBe(0n);
    expect(-effects.shareDelta).toBe(review.quote.shares);
    expect(effects.cashDelta).toBe(review.quote.cash);
    expect((await app.positionShowing(0n)).fullExitCash).toBe(0n);
  });
});

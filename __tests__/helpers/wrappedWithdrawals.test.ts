import { WRAPPED_MARKET_REGISTRY, WrappedMarket } from '@constants/wrappedMarkets';
import {
  getExitCash,
  getSharesForCash,
  getWithdrawalLimits,
  planWrappedWithdrawal,
  recheckWithdrawal,
  requoteWithdrawal,
  WithdrawalPlan,
  WithdrawalQuote,
  WithdrawalSnapshot,
} from '@helpers/wrappedWithdrawals';

function marketAt(cometAddress: string): WrappedMarket {
  const lookup = WRAPPED_MARKET_REGISTRY.lookup(1, cometAddress);
  if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
  return lookup.market;
}
const MARKETS: [string, WrappedMarket][] = [
  ['USDC', marketAt('0xc3d688B66703497DAA19211EEdff47f25384cdc3')],
  ['USDT', marketAt('0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840')],
  ['institutional USDC', marketAt('0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C')],
];

const SAFE_INTEGER_LIMIT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * 1,000.5 USDC of wrapper assets and 1,000 whole shares, counting the 10^12 virtual shares. The
 * account holds 250 shares, worth `250 × 1,000,500,001 ÷ 1,000` = 250,125,000.25 base units before
 * rounding. The supply index 1.05e15 gives a buffer of 1 + 2 = 3 base units.
 */
const SNAPSHOT: WithdrawalSnapshot = {
  shares: 250n * 10n ** 18n,
  totalSupply: 1_000n * 10n ** 18n - 10n ** 12n,
  totalAssets: 1_000_500_000n,
  baseSupplyIndex: 1_050_000_000_000_000n,
  baseDecimals: 6,
  cometCash: 10n ** 15n,
  isWithdrawPaused: false,
};

/**
 * The cash `unwrapAndWithdraw(shares)` pays at the snapshot, transcribed from the wrapper at
 * 1152de2: `worth = shares × (totalAssets + 1) ÷ (totalSupply + 10^(18 − decimals))`, rounded
 * down, less `buffer = baseSupplyIndex ÷ 10^15 + 2`. Shares worth no more than the buffer revert
 * with `ZeroAssetsTransferred`, so they pay nothing.
 */
function cashByContract(shares: bigint, snapshot: WithdrawalSnapshot): bigint {
  const worth =
    (shares * (snapshot.totalAssets + 1n)) / (snapshot.totalSupply + 10n ** BigInt(18 - snapshot.baseDecimals));
  const buffer = snapshot.baseSupplyIndex / 10n ** 15n + 2n;
  return worth <= buffer ? 0n : worth - buffer;
}

function readyQuote(plan: WithdrawalPlan): WithdrawalQuote {
  if (plan.status !== 'ready') throw new Error(`the plan is not ready: ${plan.reason}`);
  return plan.quote;
}

/** A deterministic sequence of 64-bit numbers, so a failing case can be run again. */
function pseudoRandom(seed: bigint): () => bigint {
  let state = seed;
  return () => {
    state = (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % 2n ** 64n;
    return state;
  };
}

/** A number from `low` to `high`, both included, taken from 128 random bits. */
function between(next: () => bigint, low: bigint, high: bigint): bigint {
  return low + (((next() << 64n) | next()) % (high - low + 1n));
}

/** A wrapper of 0.1 to 10^12 USDC, priced at 1 to 3 times its seed price, with a share of it held by the account. */
function randomSnapshot(next: () => bigint, baseDecimals: number): WithdrawalSnapshot {
  const virtualShares = 10n ** BigInt(18 - baseDecimals);
  const totalAssets = between(next, 10n ** BigInt(baseDecimals - 1), 10n ** BigInt(baseDecimals + 12));
  const pricePerMillion = between(next, 1_000_000n, 3_000_000n);
  const totalSupply = (totalAssets * virtualShares * 1_000_000n) / pricePerMillion;
  return {
    shares: between(next, 1n, totalSupply),
    totalSupply,
    totalAssets,
    baseSupplyIndex: between(next, 10n ** 15n, 2n * 10n ** 15n - 1n),
    baseDecimals,
    cometCash: between(next, 0n, totalAssets * 2n),
    isWithdrawPaused: false,
  };
}

describe('wrappedWithdrawals: derives partial shares with ceiling bigint arithmetic and the contract buffer from one snapshot', () => {
  it.each(MARKETS)(
    'quotes the fewest shares that pay the target on the %s wrapper, above the safe-integer range',
    (_name, market) => {
      const snapshot: WithdrawalSnapshot = {
        shares: 9_000_000_000_000_000_000_000_000n,
        totalSupply: 9_876_543_210_987_654_321_098_765_432n,
        totalAssets: 12_345_678_901_234_567n,
        baseSupplyIndex: 1_201_900_000_000_000n,
        baseDecimals: market.baseDecimals,
        cometCash: 10n ** 16n,
        isWithdrawPaused: false,
      };
      const target = 7_777_777_777_777n;
      // A number loses whole units above 2^53. The supply index stays at a realistic 1.2019e15.
      for (const value of [snapshot.shares, snapshot.totalSupply, snapshot.totalAssets]) {
        expect(value).toBeGreaterThan(SAFE_INTEGER_LIMIT);
      }

      const quote = readyQuote(planWrappedWithdrawal({ kind: 'partial', cash: target }, snapshot));

      // ceil((7,777,777,777,777 + 3) × (totalSupply + 10^12) ÷ (totalAssets + 1)), by hand.
      expect(quote).toEqual({
        kind: 'partial',
        shares: 6_222_222_278_924_001_090_608_432n,
        grossAssets: 7_777_777_777_780n,
        redeemBuffer: 3n,
        cash: target,
        leavesDust: false,
      });
      expect(getSharesForCash(target, snapshot)).toBe(quote.shares);
      expect(cashByContract(quote.shares, snapshot)).toBeGreaterThanOrEqual(target);
      expect(cashByContract(quote.shares - 1n, snapshot)).toBeLessThan(target);
    }
  );

  it('rounds the shares up, where a rounding-down conversion such as the public convertToShares falls one share short', () => {
    const target = 100_000_000n;
    // floor((100,000,000 + 3) × 10^21 ÷ 1,000,500,001), as `convertToShares(target + buffer)` returns it.
    const roundedDown = 99_950_027_886_106_918_654n;
    expect(cashByContract(roundedDown, SNAPSHOT)).toBe(99_999_999n);

    expect(getSharesForCash(target, SNAPSHOT)).toBe(roundedDown + 1n);
    expect(cashByContract(roundedDown + 1n, SNAPSHOT)).toBe(target);
  });

  it("takes the buffer from the same snapshot's supply index", () => {
    const target = 100_000_000n;
    // At the index 2e15 the buffer is 2 + 2 = 4 base units, so the shares must be worth one unit more.
    const atHigherIndex = { ...SNAPSHOT, baseSupplyIndex: 2_000_000_000_000_000n };

    expect(readyQuote(planWrappedWithdrawal({ kind: 'partial', cash: target }, SNAPSHOT))).toMatchObject({
      shares: 99_950_027_886_106_918_655n,
      grossAssets: 100_000_003n,
      redeemBuffer: 3n,
    });
    expect(readyQuote(planWrappedWithdrawal({ kind: 'partial', cash: target }, atHigherIndex))).toMatchObject({
      shares: 99_950_028_885_607_167_531n,
      grossAssets: 100_000_004n,
      redeemBuffer: 4n,
      cash: target,
    });
  });

  it.each([6, 18])('quotes minimal sufficient shares for random snapshots with %i base decimals', (baseDecimals) => {
    const next = pseudoRandom(BigInt(baseDecimals) * 1_000_003n);
    for (let round = 0; round < 300; round++) {
      const snapshot = randomSnapshot(next, baseDecimals);
      const fullExitCash = cashByContract(snapshot.shares, snapshot);
      if (fullExitCash === 0n) continue;
      const target = between(next, 1n, fullExitCash);

      const shares = getSharesForCash(target, snapshot);

      expect(shares).toBeLessThanOrEqual(snapshot.shares);
      expect(cashByContract(shares, snapshot)).toBeGreaterThanOrEqual(target);
      expect(cashByContract(shares - 1n, snapshot)).toBeLessThan(target);
    }
  });

  it('refuses to quote shares for a cash amount of zero or less', () => {
    expect(() => getSharesForCash(0n, SNAPSHOT)).toThrow(RangeError);
    expect(() => getSharesForCash(-1n, SNAPSHOT)).toThrow(RangeError);
  });
});

describe('wrappedWithdrawals: computes gross = floor(shares * (totalAssets + 1) / (totalSupply + 10^(18-baseDecimals))) and cash = max(0, gross - buffer)', () => {
  it('values 250 of 1,000 shares of 1,000.5 USDC at 250,125,000 base units, and pays 3 fewer', () => {
    expect(getExitCash(SNAPSHOT.shares, SNAPSHOT)).toBe(250_124_997n);
    expect(readyQuote(planWrappedWithdrawal({ kind: 'full' }, SNAPSHOT))).toEqual({
      kind: 'full',
      shares: 250n * 10n ** 18n,
      grossAssets: 250_125_000n,
      redeemBuffer: 3n,
      cash: 250_124_997n,
      leavesDust: false,
    });
  });

  it('adds 1 to totalAssets', () => {
    // 5e17 of 10^18 shares, counting the virtual ones, of 999,999 base units: 5e17 × 1,000,000 ÷ 10^18.
    // Without the 1 the shares are worth 499,999.5, which rounds down to 499,999.
    const snapshot = {
      ...SNAPSHOT,
      shares: 5n * 10n ** 17n,
      totalSupply: 10n ** 18n - 10n ** 12n,
      totalAssets: 999_999n,
    };

    expect(readyQuote(planWrappedWithdrawal({ kind: 'full' }, snapshot))).toMatchObject({
      grossAssets: 500_000n,
      cash: 499_997n,
    });
  });

  it.each<[number, bigint]>([
    // 5e17 × 2,000,001 ÷ (10^18 + 10^12) = 999,999.5…
    [6, 999_999n],
    // 5e17 × 2,000,001 ÷ (10^18 + 1) = 1,000,000.4…
    [18, 1_000_000n],
  ])(
    'adds 10^(18 − baseDecimals) virtual shares to totalSupply, with %i base decimals',
    (baseDecimals, grossAssets) => {
      const snapshot = {
        ...SNAPSHOT,
        shares: 5n * 10n ** 17n,
        totalSupply: 10n ** 18n,
        totalAssets: 2_000_000n,
        baseDecimals,
      };

      expect(readyQuote(planWrappedWithdrawal({ kind: 'full' }, snapshot))).toMatchObject({
        grossAssets,
        cash: grossAssets - 3n,
      });
    }
  );

  it.each<[bigint, bigint]>([
    [1_000_000_000_000_000n, 3n],
    [1_201_900_000_000_000n, 3n],
    [1_999_999_999_999_999n, 3n],
    [2_000_000_000_000_000n, 4n],
    [2_999_999_999_999_999n, 4n],
  ])('takes floor(%p ÷ 10^15) + 2 as the buffer: %p', (baseSupplyIndex, redeemBuffer) => {
    const quote = readyQuote(planWrappedWithdrawal({ kind: 'full' }, { ...SNAPSHOT, baseSupplyIndex }));

    expect(quote.redeemBuffer).toBe(redeemBuffer);
    expect(quote.cash).toBe(250_125_000n - redeemBuffer);
  });

  it.each<[string, bigint, bigint]>([
    ['worth the buffer exactly', 2_998_500_746_629n, 0n],
    ['worth one unit more than the buffer', 3_998_000_995_505n, 1n],
  ])('pays nothing for shares worth no more than the buffer: shares %s', (_name, shares, cash) => {
    expect(getExitCash(shares, SNAPSHOT)).toBe(cash);
    expect(cashByContract(shares, SNAPSHOT)).toBe(cash);
  });

  it('quotes the minimal sufficient shares for the quoted target', () => {
    const quote = readyQuote(planWrappedWithdrawal({ kind: 'partial', cash: 100_000_000n }, SNAPSHOT));

    expect(quote).toEqual({
      kind: 'partial',
      shares: 99_950_027_886_106_918_655n,
      grossAssets: 100_000_003n,
      redeemBuffer: 3n,
      cash: 100_000_000n,
      leavesDust: false,
    });
    expect(getExitCash(quote.shares, SNAPSHOT)).toBe(100_000_000n);
    expect(getExitCash(quote.shares - 1n, SNAPSHOT)).toBe(99_999_999n);
  });
});

describe('wrappedWithdrawals: requires a revised target or explicit full exit when requested cash exceeds executable holdings', () => {
  it('refuses a target one unit above what the shares pay, and offers the full exit instead of a smaller amount', () => {
    const plan = planWrappedWithdrawal({ kind: 'partial', cash: 250_124_998n }, SNAPSHOT);

    expect(plan).toEqual({
      status: 'needs-revision',
      reason: 'exceeds-position',
      limits: { fullExitCash: 250_124_997n, maxPartialCash: 250_124_997n, canExitFully: true },
    });
  });

  it('accepts a target of exactly what the shares pay, and says it leaves shares that cannot be withdrawn', () => {
    const quote = readyQuote(planWrappedWithdrawal({ kind: 'partial', cash: 250_124_997n }, SNAPSHOT));

    // The fewest shares that pay the whole amount leave 249,875,062,219 shares, worth less than a base unit.
    expect(quote).toMatchObject({ shares: 249_999_999_750_124_937_781n, cash: 250_124_997n, leavesDust: true });
  });

  it('refuses a target above the cash Comet holds, and a full exit too, and offers what Comet can pay', () => {
    const snapshot = { ...SNAPSHOT, cometCash: 100_000_000n };
    const limits = { fullExitCash: 250_124_997n, maxPartialCash: 100_000_000n, canExitFully: false };

    expect(planWrappedWithdrawal({ kind: 'partial', cash: 100_000_001n }, snapshot)).toEqual({
      status: 'needs-revision',
      reason: 'exceeds-liquidity',
      limits,
    });
    expect(planWrappedWithdrawal({ kind: 'full' }, snapshot)).toEqual({
      status: 'needs-revision',
      reason: 'exceeds-liquidity',
      limits,
    });
    expect(readyQuote(planWrappedWithdrawal({ kind: 'partial', cash: 100_000_000n }, snapshot)).cash).toBe(
      100_000_000n
    );
  });

  it('caps the most a partial exit can pay at the cash Comet holds, as the shares can pay it', () => {
    // The largest number of shares Comet's 100 USDC can pay is worth 100,000,003 base units.
    expect(getWithdrawalLimits({ ...SNAPSHOT, cometCash: 100_000_000n })).toEqual({
      fullExitCash: 250_124_997n,
      maxPartialCash: 100_000_000n,
      canExitFully: false,
    });
    expect(getWithdrawalLimits({ ...SNAPSHOT, cometCash: 250_124_997n })).toEqual({
      fullExitCash: 250_124_997n,
      maxPartialCash: 250_124_997n,
      canExitFully: true,
    });
    expect(getWithdrawalLimits({ ...SNAPSHOT, cometCash: 0n })).toMatchObject({ maxPartialCash: 0n });
  });

  it('refuses every exit while Comet withdrawals are paused', () => {
    const snapshot = { ...SNAPSHOT, isWithdrawPaused: true };
    const revision = {
      status: 'needs-revision',
      reason: 'paused',
      limits: { fullExitCash: 250_124_997n, maxPartialCash: 0n, canExitFully: false },
    };

    expect(planWrappedWithdrawal({ kind: 'partial', cash: 1n }, snapshot)).toEqual(revision);
    expect(planWrappedWithdrawal({ kind: 'full' }, snapshot)).toEqual(revision);
  });

  it.each([6, 18])(
    'never quotes less cash than the target, more shares than held, or more cash than Comet holds, for random snapshots with %i base decimals',
    (baseDecimals) => {
      const next = pseudoRandom(BigInt(baseDecimals) * 7_919n);
      for (let round = 0; round < 300; round++) {
        const snapshot = randomSnapshot(next, baseDecimals);
        const target = between(next, 1n, cashByContract(snapshot.shares, snapshot) * 2n + 10n);

        const plan = planWrappedWithdrawal({ kind: 'partial', cash: target }, snapshot);

        if (plan.status === 'ready') {
          expect(plan.quote.cash).toBeGreaterThanOrEqual(target);
          expect(plan.quote.shares).toBeLessThanOrEqual(snapshot.shares);
          expect(plan.quote.cash).toBeLessThanOrEqual(snapshot.cometCash);
          expect(cashByContract(plan.quote.shares, snapshot)).toBe(plan.quote.cash);
        } else {
          expect(['exceeds-position', 'exceeds-liquidity', 'dust']).toContain(plan.reason);
          expect(target).toBeGreaterThan(plan.limits.maxPartialCash);
        }
      }
    }
  );
});

describe('wrappedWithdrawals: handles zero shares, a position at/below the buffer, one-base-unit boundaries, accrued value, and a changed snapshot', () => {
  it('refuses both exits of an account with no shares', () => {
    const snapshot = { ...SNAPSHOT, shares: 0n };
    const revision = {
      status: 'needs-revision',
      reason: 'no-shares',
      limits: { fullExitCash: 0n, maxPartialCash: 0n, canExitFully: false },
    };

    expect(planWrappedWithdrawal({ kind: 'full' }, snapshot)).toEqual(revision);
    expect(planWrappedWithdrawal({ kind: 'partial', cash: 1n }, snapshot)).toEqual(revision);
  });

  it.each<[string, bigint]>([
    ['worth the buffer exactly', 2_998_500_746_629n],
    ['worth less than the buffer', 1_000_000_000_000n],
  ])('refuses both exits of a position %s, which the wrapper refuses with ZeroAssetsTransferred', (_name, shares) => {
    const snapshot = { ...SNAPSHOT, shares };
    const revision = {
      status: 'needs-revision',
      reason: 'dust',
      limits: { fullExitCash: 0n, maxPartialCash: 0n, canExitFully: false },
    };

    expect(planWrappedWithdrawal({ kind: 'full' }, snapshot)).toEqual(revision);
    expect(planWrappedWithdrawal({ kind: 'partial', cash: 1n }, snapshot)).toEqual(revision);
  });

  it('exits a position worth one base unit more than the buffer, for its one unit of cash', () => {
    const snapshot = { ...SNAPSHOT, shares: 3_998_000_995_505n };

    expect(readyQuote(planWrappedWithdrawal({ kind: 'full' }, snapshot))).toEqual({
      kind: 'full',
      shares: 3_998_000_995_505n,
      grossAssets: 4n,
      redeemBuffer: 3n,
      cash: 1n,
      leavesDust: false,
    });
  });

  it('quotes one base unit of cash as the shares worth the buffer and one unit, and no fewer', () => {
    const quote = readyQuote(planWrappedWithdrawal({ kind: 'partial', cash: 1n }, SNAPSHOT));

    expect(quote).toMatchObject({ shares: 3_998_000_995_505n, grossAssets: 4n, cash: 1n });
    expect(getExitCash(quote.shares - 1n, SNAPSHOT)).toBe(0n);
  });

  it('refuses a target of zero', () => {
    expect(planWrappedWithdrawal({ kind: 'partial', cash: 0n }, SNAPSHOT)).toMatchObject({
      status: 'needs-revision',
      reason: 'no-amount',
    });
  });

  it.each<[bigint, boolean]>([
    // The shares left are worth 2 base units, no more than the buffer.
    [250_124_995n, true],
    // The shares left are worth 7 base units, so they can be withdrawn later.
    [250_124_990n, false],
  ])('says whether a partial exit of %p leaves shares worth no more than the buffer', (cash, leavesDust) => {
    expect(readyQuote(planWrappedWithdrawal({ kind: 'partial', cash }, SNAPSHOT)).leavesDust).toBe(leavesDust);
  });

  it('pays more for the same shares, and needs fewer shares for the same cash, once interest accrues', () => {
    const accrued = { ...SNAPSHOT, totalAssets: 1_001_000_000n };

    expect(getExitCash(SNAPSHOT.shares, accrued)).toBe(250_249_997n);
    expect(getSharesForCash(100_000_000n, accrued)).toBe(99_900_102_797_302_594_609n);
    expect(getSharesForCash(100_000_000n, accrued)).toBeLessThan(getSharesForCash(100_000_000n, SNAPSHOT));
  });

  describe('a reviewed exit checked against a newer snapshot', () => {
    const partialQuote = () => readyQuote(planWrappedWithdrawal({ kind: 'partial', cash: 100_000_000n }, SNAPSHOT));
    const fullQuote = () => readyQuote(planWrappedWithdrawal({ kind: 'full' }, SNAPSHOT));

    it('passes when nothing changed', () => {
      expect(recheckWithdrawal(partialQuote(), SNAPSHOT)).toEqual({ status: 'ready', cash: 100_000_000n });
      expect(recheckWithdrawal(fullQuote(), SNAPSHOT)).toEqual({ status: 'ready', cash: 250_124_997n });
    });

    it('passes with more cash once interest accrues', () => {
      const accrued = { ...SNAPSHOT, totalAssets: 1_001_000_000n };

      expect(recheckWithdrawal(partialQuote(), accrued)).toEqual({ status: 'ready', cash: 100_049_975n });
      expect(recheckWithdrawal(fullQuote(), accrued)).toEqual({ status: 'ready', cash: 250_249_997n });
    });

    it.each<[string, Partial<WithdrawalSnapshot>, 'partial' | 'full', string, bigint]>([
      ['the shares now pay one unit less', { totalAssets: 1_000_499_990n }, 'partial', 'cash-fell', 99_999_999n],
      ['the full exit now pays less', { totalAssets: 1_000_400_000n }, 'full', 'cash-fell', 250_099_997n],
      ['the account received shares', { shares: SNAPSHOT.shares + 1n }, 'full', 'shares-changed', 250_124_997n],
      ['the account sent shares', { shares: SNAPSHOT.shares - 1n }, 'full', 'shares-changed', 250_124_997n],
      [
        'the account holds fewer shares than the exit burns',
        { shares: 99_950_027_886_106_918_654n },
        'partial',
        'shares-changed',
        100_000_000n,
      ],
      ['withdrawals are paused', { isWithdrawPaused: true }, 'partial', 'paused', 100_000_000n],
      [
        'Comet holds less cash than the exit pays',
        { cometCash: 99_999_999n },
        'partial',
        'exceeds-liquidity',
        100_000_000n,
      ],
      ['the shares are now worth no more than the buffer', { totalAssets: 20n }, 'partial', 'dust', 0n],
      [
        'the shares now pay one unit more than 0.1% above the reviewed cash',
        { totalAssets: 1_001_500_510n },
        'partial',
        'cash-rose',
        100_100_001n,
      ],
      [
        "the wrapper's assets double, as a donation to the wrapper can make them",
        { totalAssets: 2_001_000_000n },
        'partial',
        'cash-rose',
        200_000_002n,
      ],
    ])('stops when %s', (_name, change, kind, reason, cash) => {
      const quote = kind === 'partial' ? partialQuote() : fullQuote();

      expect(recheckWithdrawal(quote, { ...SNAPSHOT, ...change })).toEqual({ status: 'changed', reason, cash });
    });

    it('lets a partial exit go on when its cash rises by exactly 0.1% of the reviewed cash', () => {
      expect(recheckWithdrawal(partialQuote(), { ...SNAPSHOT, totalAssets: 1_001_500_500n })).toEqual({
        status: 'ready',
        cash: 100_100_000n,
      });
    });

    it('lets a full exit go on when its cash doubles, because it still burns exactly the reviewed balance', () => {
      expect(recheckWithdrawal(fullQuote(), { ...SNAPSHOT, totalAssets: 2_001_000_000n })).toEqual({
        status: 'ready',
        cash: 500_249_997n,
      });
    });

    it('quotes the reviewed shares again at the newer snapshot, and never other shares', () => {
      const accrued = { ...SNAPSHOT, totalAssets: 1_001_000_000n };

      expect(requoteWithdrawal(partialQuote(), { ...accrued, shares: SNAPSHOT.shares * 2n })).toEqual({
        kind: 'partial',
        shares: 99_950_027_886_106_918_655n,
        grossAssets: 100_049_978n,
        redeemBuffer: 3n,
        cash: 100_049_975n,
        leavesDust: false,
      });
      expect(requoteWithdrawal(fullQuote(), accrued)).toEqual({
        kind: 'full',
        shares: SNAPSHOT.shares,
        grossAssets: 250_250_000n,
        redeemBuffer: 3n,
        cash: 250_249_997n,
        leavesDust: false,
      });
    });

    it('lets a partial exit burn its reviewed shares from a larger balance', () => {
      expect(recheckWithdrawal(partialQuote(), { ...SNAPSHOT, shares: SNAPSHOT.shares * 2n })).toEqual({
        status: 'ready',
        cash: 100_000_000n,
      });
    });
  });
});

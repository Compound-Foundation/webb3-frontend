// Fork-only changes to market state, for the failure scenarios. Each one acts on the local anvil
// fork alone. Most are ordinary transactions a real account can send, from impersonated accounts:
// the pause guardian's pause, a borrow of the market's cash, a third party's zero transfer. One is
// a direct storage write that no transaction can make: the back-dated accrual. None reaches mainnet.
import { WrappedMarket } from '@constants/wrappedMarkets';

import {
  COMET,
  dealToken,
  ERC20,
  FORK_ONLY,
  prepareAccount,
  read,
  readBigInt,
  sendFrom,
  WETH,
  WRAPPER,
} from './fixtures';
import { anvil, forkProvider } from './fork';

const provider = forkProvider();

/** Runs `run` and then returns the fork to the state before it, whatever `run` did or threw. */
export async function onSnapshot<T>(run: () => Promise<T>): Promise<T> {
  const snapshot = await anvil.snapshot();
  try {
    return await run();
  } finally {
    // Reverting a snapshot resets anvil's clock, not its block interval. Otherwise a scenario that
    // froze time and failed before it unfroze it leaves every later block at one timestamp.
    await anvil.unfreezeTime();
    await anvil.revert(snapshot);
    // The transaction manager keeps transactions in local storage, and the blocks they name are gone.
    window.localStorage.clear();
  }
}

/** The account's nonce: it moves only when the account sends a transaction. */
export const nonceOf = (account: string) => provider.getTransactionCount(account, 'latest');

/** Supplies through the wrapper outside the app, as set-up: an exact approval, then `supplyAndWrap`. */
export async function supplyDirectly(market: WrappedMarket, account: string, amount: bigint) {
  await sendFrom(account, {
    to: market.baseTokenAddress,
    data: ERC20.encodeFunctionData('approve', [market.wrapperAddress, amount]),
  });
  return sendFrom(account, { to: market.wrapperAddress, data: WRAPPER.encodeFunctionData('supplyAndWrap', [amount]) });
}

/** Comet's pause flags, set by its pause guardian, the account Comet allows to pause. */
export async function pauseComet(
  market: WrappedMarket,
  flags: { supply?: boolean; transfer?: boolean; withdraw?: boolean; absorb?: boolean; buy?: boolean }
) {
  const pauseGuardian = String((await read(market.cometAddress, COMET, 'pauseGuardian'))[0]);
  await prepareAccount(pauseGuardian, { existing: true });
  await sendFrom(pauseGuardian, {
    to: market.cometAddress,
    data: COMET.encodeFunctionData('pause', [
      flags.supply ?? false,
      flags.transfer ?? false,
      flags.withdraw ?? false,
      flags.absorb ?? false,
      flags.buy ?? false,
    ]),
  });
  return pauseGuardian;
}

/**
 * Borrows the market's base token until Comet holds only `leave`, as any borrower with enough WETH
 * collateral can. The borrower wraps ether it is given on the fork into WETH.
 */
export async function drainCash(market: WrappedMarket, drainer: string, leave: bigint) {
  await prepareAccount(drainer);
  const [assetInfo] = await read(market.cometAddress, COMET, 'getAssetInfoByAddress', [WETH]);
  const wethPrice = await readBigInt(market.cometAddress, COMET, 'getPrice', [assetInfo.priceFeed]);
  const [baseFeed] = await read(market.cometAddress, COMET, 'baseTokenPriceFeed');
  const basePrice = await readBigInt(market.cometAddress, COMET, 'getPrice', [baseFeed]);
  const cash = await readBigInt(market.baseTokenAddress, ERC20, 'balanceOf', [market.cometAddress]);
  const borrow = cash - leave;
  const collateralFactor = BigInt(assetInfo.borrowCollateralFactor.toString());
  const scale = 10n ** BigInt(market.baseDecimals);
  // Enough WETH for the borrow at the collateral factor, and 5% more.
  const weth = (borrow * basePrice * 10n ** 36n * 105n) / (scale * wethPrice * collateralFactor * 100n);
  await anvil.setBalance(drainer, weth + 10n ** 20n);
  await sendFrom(drainer, { to: WETH, data: FORK_ONLY.encodeFunctionData('deposit'), value: weth });
  await sendFrom(drainer, { to: WETH, data: ERC20.encodeFunctionData('approve', [market.cometAddress, weth]) });
  await sendFrom(drainer, { to: market.cometAddress, data: COMET.encodeFunctionData('supply', [WETH, weth]) });
  await sendFrom(drainer, {
    to: market.cometAddress,
    data: COMET.encodeFunctionData('withdraw', [market.baseTokenAddress, borrow]),
  });
  return {
    borrowed: borrow,
    weth,
    cashLeft: await readBigInt(market.baseTokenAddress, ERC20, 'balanceOf', [market.cometAddress]),
  };
}

const mask = (bits: number) => (1n << BigInt(bits)) - 1n;
/** Comet's second storage slot: totalSupplyBase, totalBorrowBase, lastAccrualTime and pauseFlags, from the low bits up. */
const TOTALS_SLOT = '0x1';
const LAST_ACCRUAL_SHIFT = 208n;

/**
 * Moves Comet's last accrual back in time with a storage write, so that the supply index Comet
 * accrues to when it next runs is at least two whole units (2e15) above the stored index that
 * `totalsBasic()` reports and the wrapper's buffer uses. A real market accrues on every
 * interaction, so its stored index trails by far less. Fork-only: no transaction can do this.
 *
 * Returns undefined, and writes nothing, when the market's supply rate is too low to reach that lag
 * after the epoch: the caller can raise the rate first.
 */
export async function backdateAccrual(market: WrappedMarket) {
  const slot = await anvil.getStorageAt(market.cometAddress, TOTALS_SLOT);
  const [totals] = await read(market.cometAddress, COMET, 'totalsBasic');
  const storedLastAccrual = (slot >> LAST_ACCRUAL_SHIFT) & mask(40);
  if (storedLastAccrual !== BigInt(totals.lastAccrualTime.toString())) {
    throw new Error('Comet storage slot 1 is not laid out as expected.');
  }
  const storedIndex = BigInt(totals.baseSupplyIndex.toString());
  const utilization = await readBigInt(market.cometAddress, COMET, 'getUtilization');
  const supplyRate = await readBigInt(market.cometAddress, COMET, 'getSupplyRate', [utilization]);
  // The accrued index is storedIndex × (1 + supplyRate × elapsed ÷ 1e18). Aim 5% of a unit past
  // two whole units above the stored index's own whole units.
  const targetIndex = ((storedIndex / 10n ** 15n + 2n) * 100n + 5n) * 10n ** 13n;
  const elapsed = ((targetIndex - storedIndex) * 10n ** 18n) / (storedIndex * supplyRate) + 1n;
  const { timestamp } = await anvil.latestBlock();
  const lastAccrual = BigInt(timestamp) - elapsed;
  if (lastAccrual <= 0n) return undefined;
  await anvil.setStorageAt(
    market.cometAddress,
    TOTALS_SLOT,
    (slot & ~(mask(40) << LAST_ACCRUAL_SHIFT)) | (lastAccrual << LAST_ACCRUAL_SHIFT)
  );
  return { storedIndex, supplyRate, elapsedSeconds: elapsed, lastAccrual };
}

/**
 * A third party's supply of base tokens to Comet on the wrapper's behalf, `comet.supplyTo(wrapper,
 * baseToken, amount)`. Comet lets any account credit any other, so this raises what every wrapper
 * share is worth.
 */
export async function donateToWrapper(market: WrappedMarket, donor: string, amount: bigint) {
  await sendFrom(donor, {
    to: market.baseTokenAddress,
    data: ERC20.encodeFunctionData('approve', [market.cometAddress, amount]),
  });
  return sendFrom(donor, {
    to: market.cometAddress,
    data: COMET.encodeFunctionData('supplyTo', [market.wrapperAddress, market.baseTokenAddress, amount]),
  });
}

/**
 * A third party's `comet.transfer(wrapper, 0)`. Comet works out the receiver's principal again
 * from its balance, rounding down, so each such call can take a unit of principal from the wrapper.
 */
export async function zeroTransferTo(market: WrappedMarket, sender: string) {
  return sendFrom(sender, {
    to: market.cometAddress,
    data: COMET.encodeFunctionData('transfer', [market.wrapperAddress, 0]),
  });
}

/** Gives `account` base tokens on the fork and makes it signable. */
export async function fundedAccount(market: WrappedMarket, account: string, amount: bigint) {
  await prepareAccount(account);
  await dealToken(market.baseTokenAddress, account, amount);
  return account;
}

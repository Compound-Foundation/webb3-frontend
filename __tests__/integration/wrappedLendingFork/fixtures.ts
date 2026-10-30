import { Interface } from '@ethersproject/abi';
import { TransactionReceipt } from '@ethersproject/providers';
import { utils } from 'ethers';

import {
  buildWrappedMarketRegistry,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WrappedMarket,
  WrappedMarketRegistry,
} from '@constants/wrappedMarkets';
import CometAbi from '@helpers/abis/Comet';
import ERC20Abi from '@helpers/abis/ERC20';
import WrappedCometAbi from '@helpers/abis/WrappedCometERC4626';

import { anvil, forkProvider } from './fork';

export const COMET = new Interface(CometAbi);
export const ERC20 = new Interface(ERC20Abi);
export const WRAPPER = new Interface(WrappedCometAbi);
/** The wrapper's ERC-4626 events and conversion, ERC-20 transfers and the WETH deposit, which the app's ABIs do not list. */
export const FORK_ONLY = new Interface([
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function deposit() payable',
]);

export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

/**
 * The committed registry with both release controls open. The fork suite needs them open to sign
 * anything. The committed source keeps them closed, and only COM-292 changes that.
 */
export const FORK_REGISTRY: WrappedMarketRegistry = buildWrappedMarketRegistry({
  markets: HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => ({
    ...market,
    isDepositEnabled: true,
    isExitEnabled: true,
  })),
});

export type ForkMarket = { label: string; symbol: 'USDC' | 'USDT'; market: WrappedMarket };

/** The three configured markets, from the committed source and in its order. */
export const FORK_MARKETS: readonly ForkMarket[] = HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((source, index) => {
  const lookup = FORK_REGISTRY.lookup(source.chainId, source.cometAddress);
  if (lookup.status !== 'valid') throw new Error(`The committed mapping ${index} is not valid: ${lookup.status}.`);
  const isUsdt = lookup.market.baseTokenAddress.toLowerCase() === USDT.toLowerCase();
  // The third entry is the institutional USDC market, a separate Comet with the same base token.
  const label = isUsdt ? 'USDT' : index === 2 ? 'institutional USDC' : 'USDC';
  return { label, symbol: isUsdt ? 'USDT' : 'USDC', market: lookup.market };
});

/** The base units of `whole` tokens, at the six decimals of the three base tokens. */
export const units = (whole: number) => BigInt(Math.round(whole * 1e6));

/**
 * A fresh address for one role in one market. It has no code, no balance and no history on
 * mainnet, so the fork suite can impersonate it without touching anyone's real position.
 */
export function forkAccount(role: string, market: ForkMarket): string {
  return utils.getAddress(utils.keccak256(utils.toUtf8Bytes(`com-289 fork ${role} ${market.label}`)).slice(0, 42));
}

const provider = forkProvider();

/**
 * Makes `account` signable on the fork through `eth_sendTransaction`, with ether for gas. A test
 * account must be fresh: no code and no transactions, as `forkAccount` promises. An existing
 * account, such as Comet's pause guardian, is impersonated as it is.
 */
export async function prepareAccount(account: string, { existing = false } = {}): Promise<string> {
  if (!existing) {
    const [code, nonce] = await Promise.all([provider.getCode(account), provider.getTransactionCount(account)]);
    if (code !== '0x' || nonce !== 0) throw new Error(`The test account ${account} is not fresh.`);
  }
  await anvil.impersonate(account);
  await anvil.setBalance(account, 100n * 10n ** 18n);
  return account;
}

export async function read(
  to: string,
  contract: Interface,
  method: string,
  args: readonly unknown[] = [],
  blockTag?: number
) {
  const data = contract.encodeFunctionData(method, args);
  return contract.decodeFunctionResult(method, await provider.call({ to, data }, blockTag ?? 'latest'));
}

export async function readBigInt(
  to: string,
  contract: Interface,
  method: string,
  args: readonly unknown[] = [],
  blockTag?: number
): Promise<bigint> {
  return BigInt((await read(to, contract, method, args, blockTag))[0].toString());
}

const balanceSlots = new Map<string, number>();

/**
 * Sets `holder`'s balance of `token` on the fork, as Foundry's `deal` does. It finds the balance
 * mapping's slot: it writes a candidate slot and reads `balanceOf` back. It restores each slot it
 * tried that was not the balance. Fork-only, so no real holder is touched.
 */
export async function dealToken(token: string, holder: string, amount: bigint): Promise<void> {
  const keyFor = (slot: number) =>
    utils.keccak256(utils.defaultAbiCoder.encode(['address', 'uint256'], [holder, slot]));
  const known = balanceSlots.get(token.toLowerCase());
  const candidates = known === undefined ? Array.from({ length: 30 }, (_, slot) => slot) : [known];
  for (const slot of candidates) {
    const key = keyFor(slot);
    const before = await anvil.getStorageAt(token, key);
    await anvil.setStorageAt(token, key, amount);
    if ((await readBigInt(token, ERC20, 'balanceOf', [holder])) === amount) {
      balanceSlots.set(token.toLowerCase(), slot);
      return;
    }
    await anvil.setStorageAt(token, key, before);
  }
  throw new Error(`No balance slot found for ${token}.`);
}

/** The slot the last `dealToken` found for `token`, for the record. */
export const balanceSlotOf = (token: string) => balanceSlots.get(token.toLowerCase());

export type SentTransaction = { hash: string; receipt: TransactionReceipt };

/** The receipt of `hash`, once anvil has stored it. Fails after a minute. */
async function receiptFor(hash: string): Promise<TransactionReceipt> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt !== null) return receipt;
    if (Date.now() > deadline) throw new Error(`No receipt for ${hash} after a minute.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * The gas limit of a set-up transaction. Anvil's own estimate is the least gas that succeeds at
 * the pending block's timestamp. If the transaction is mined a second later, Comet accrues interest
 * first and needs more gas, and the transaction runs out of gas.
 */
const SET_UP_GAS_LIMIT = 3_000_000;

/**
 * Sends a transaction from an impersonated account outside the app, for set-up and injected
 * changes such as a third party's transfer. Anvil mines it at once. Fails unless it succeeds,
 * when `expectSuccess` is true.
 */
export async function sendFrom(
  from: string,
  request: { to: string; data: string; value?: bigint },
  expectSuccess = true
): Promise<SentTransaction> {
  const hash: string = await provider.send('eth_sendTransaction', [
    {
      from,
      to: request.to,
      data: request.data,
      gas: `0x${SET_UP_GAS_LIMIT.toString(16)}`,
      ...(request.value === undefined ? {} : { value: `0x${request.value.toString(16)}` }),
    },
  ]);
  // Anvil mines at once, but can answer with the hash a moment before the receipt is stored. Ethers'
  // own wait listens for new block numbers. After a fork snapshot is reverted, the next blocks reuse
  // lower numbers, which ethers ignores. So the suite polls for the receipt directly.
  const receipt = await receiptFor(hash);
  if (expectSuccess && receipt.status !== 1)
    throw new Error(`The set-up transaction ${hash} to ${request.to} reverted.`);
  return { hash, receipt };
}

/**
 * The revert data of `request` from `from` at `blockTag`, `0x` for a revert without data, or
 * undefined when the call succeeds. Any other failure, such as a failed fetch from the upstream,
 * is thrown: it says nothing about the contract.
 */
export async function revertDataOf(
  from: string,
  request: { to: string; data: string },
  blockTag: number | 'latest' = 'latest'
): Promise<string | undefined> {
  try {
    await provider.send('eth_call', [
      { from, to: request.to, data: request.data },
      blockTag === 'latest' ? 'latest' : `0x${blockTag.toString(16)}`,
    ]);
    return undefined;
  } catch (error) {
    // Ethers keeps the node's JSON-RPC error in `error`. anvil reports a revert with code 3.
    const nodeError = (error as { error?: { code?: unknown; message?: unknown; data?: unknown } }).error;
    const isRevert = nodeError?.code === 3 || /revert/i.test(String(nodeError?.message));
    if (!isRevert) throw error;
    return typeof nodeError?.data === 'string' ? nodeError.data : '0x';
  }
}

/** What the oracle reads for one account in one market at one block: the chain's own figures. */
export type AccountReading = {
  blockNumber: number;
  wallet: bigint;
  shares: bigint;
  allowance: bigint;
  wrapperTotalSupply: bigint;
  wrapperAssets: bigint;
  cometCash: bigint;
  cometTotalSupply: bigint;
  directBalance: bigint;
  directBorrow: bigint;
};

export async function readAccount(
  market: WrappedMarket,
  account: string,
  blockNumber: number
): Promise<AccountReading> {
  const { baseTokenAddress, wrapperAddress, cometAddress } = market;
  const [
    wallet,
    shares,
    allowance,
    wrapperTotalSupply,
    wrapperAssets,
    cometCash,
    cometTotalSupply,
    directBalance,
    directBorrow,
  ] = await Promise.all([
    readBigInt(baseTokenAddress, ERC20, 'balanceOf', [account], blockNumber),
    readBigInt(wrapperAddress, WRAPPER, 'balanceOf', [account], blockNumber),
    readBigInt(baseTokenAddress, ERC20, 'allowance', [account, wrapperAddress], blockNumber),
    readBigInt(wrapperAddress, WRAPPER, 'totalSupply', [], blockNumber),
    readBigInt(cometAddress, COMET, 'balanceOf', [wrapperAddress], blockNumber),
    readBigInt(baseTokenAddress, ERC20, 'balanceOf', [cometAddress], blockNumber),
    readBigInt(cometAddress, COMET, 'totalSupply', [], blockNumber),
    readBigInt(cometAddress, COMET, 'balanceOf', [account], blockNumber),
    readBigInt(cometAddress, COMET, 'borrowBalanceOf', [account], blockNumber),
  ]);
  return {
    blockNumber,
    wallet,
    shares,
    allowance,
    wrapperTotalSupply,
    wrapperAssets,
    cometCash,
    cometTotalSupply,
    directBalance,
    directBorrow,
  };
}

/**
 * What a mined transaction did to the account, read from the chain:
 * - the account's figures in the parent block and in the transaction's own block
 * - the transaction's gas
 * - the wrapper's and the base token's events in its receipt
 *
 * The block must hold this transaction alone, so that the parent block is the state just before it.
 */
export async function receiptEffects(market: WrappedMarket, account: string, receipt: TransactionReceipt) {
  const block = await provider.getBlock(receipt.blockNumber);
  if (block.transactions.length !== 1) {
    throw new Error(`Block ${receipt.blockNumber} holds ${block.transactions.length} transactions, not one.`);
  }
  const before = await readAccount(market, account, receipt.blockNumber - 1);
  const after = await readAccount(market, account, receipt.blockNumber);
  const events = receipt.logs.flatMap((log) => {
    try {
      return [{ address: log.address.toLowerCase(), event: FORK_ONLY.parseLog(log) }];
    } catch {
      return [];
    }
  });
  const isFrom = (address: string) => (entry: { address: string }) => entry.address === address.toLowerCase();
  const wrapperEvents = events.filter(isFrom(market.wrapperAddress)).map(({ event }) => event);
  const baseTransfers = events
    .filter(isFrom(market.baseTokenAddress))
    .map(({ event }) => event)
    .filter((event) => event.name === 'Transfer');
  const toAccount = (address: unknown) => String(address).toLowerCase() === account.toLowerCase();
  const sent = await provider.getTransaction(receipt.transactionHash);
  return {
    before,
    after,
    /** The gas limit the transaction was sent with, and the gas it used. */
    gasLimit: sent.gasLimit.toBigInt(),
    gasUsed: receipt.gasUsed.toBigInt(),
    cashDelta: after.wallet - before.wallet,
    shareDelta: after.shares - before.shares,
    deposit: wrapperEvents.find((event) => event.name === 'Deposit' && toAccount(event.args.owner)),
    withdraw: wrapperEvents.find((event) => event.name === 'Withdraw' && toAccount(event.args.owner)),
    cashPaidToAccount: baseTransfers
      .filter((event) => toAccount(event.args.to))
      .reduce((sum, event) => sum + BigInt(event.args.value.toString()), 0n),
  };
}

type ExitEffects = Awaited<ReturnType<typeof receiptEffects>>;

/**
 * Checks a mined exit against the quote it is held to. The exit burned exactly `shares` from the
 * account, and its `Withdraw` event names those shares. The account's wallet received exactly
 * `cash`, all of it in base-token transfers to the account.
 */
export function expectExitPaid(effects: ExitEffects, quote: { shares: bigint; cash: bigint }) {
  expect(-effects.shareDelta).toBe(quote.shares);
  expect(BigInt(effects.withdraw?.args.shares.toString() ?? '-1')).toBe(quote.shares);
  expect(effects.cashDelta).toBe(quote.cash);
  expect(effects.cashPaidToAccount).toBe(quote.cash);
}

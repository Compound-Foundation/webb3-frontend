import { defaultAbiCoder, Interface } from '@ethersproject/abi';
import { JsonRpcProvider } from '@ethersproject/providers';
import { useRef } from 'react';

import { WrappedMarket } from '@constants/wrappedMarkets';
import ERC20Abi from '@helpers/abis/ERC20';
import WrappedCometAbi from '@helpers/abis/WrappedCometERC4626';
import { LendingRoute } from '@helpers/lendingRoute';
import { MAX_UINT256 } from '@helpers/numbers';
import { describeWalletError } from '@helpers/walletErrors';
import { WrappedActionIdentity, WrappedBlockReason, WrappedStep, WrappedStepCheck } from '@helpers/wrappedActions';
import { BlockWait, DEFAULT_BLOCK_WAIT, waitForBlock } from '@helpers/wrappedPositions';
import { SettledTransaction } from '@types';

import type { WrappedActionController } from './useWrappedAction';

/** The ids of a wrapped supply's steps, in the order they can come. */
export const WRAPPED_SUPPLY_STEP_IDS = Object.freeze({
  reset: 'reset-allowance',
  approve: 'approve',
  supply: 'supply',
} as const);

const baseTokenInterface = new Interface(ERC20Abi);
const wrapperInterface = new Interface(WrappedCometAbi);

/**
 * Base tokens whose `approve` reverts when it changes one nonzero allowance to another, by chain
 * and lower-case address. An insufficient nonzero allowance of one of these is reset to zero
 * before the approval.
 */
const ZERO_FIRST_APPROVAL_TOKENS: Readonly<Record<number, ReadonlySet<string>>> = Object.freeze({
  // USDT on Ethereum.
  1: new Set(['0xdac17f958d2ee523a2206206994597c13d831ec7']),
});

/** Whether the token's allowance has to be reset to zero before it is changed to another nonzero amount. */
function requiresAllowanceReset(chainId: number, tokenAddress: string): boolean {
  return ZERO_FIRST_APPROVAL_TOKENS[chainId]?.has(tokenAddress.toLowerCase()) ?? false;
}

/**
 * An amount at least this large is shown as unlimited. An allowance this large is an unlimited
 * approval, and no wallet balance comes near it.
 */
const UNLIMITED_AMOUNT = 2n ** 128n;

const AMOUNT_INPUT = /^(\d*)(?:\.(\d*))?$/;

/**
 * The raw base-token amount a typed decimal stands for, in units of `decimals`: "1234.567891" is
 * 1234567891 with 6 decimals. Only ASCII digits and one decimal point are accepted, with no more
 * fraction digits than `decimals`, so the amount is never rounded. Anything else is undefined.
 */
export function parseWrappedSupplyAmount(input: string, decimals: number): bigint | undefined {
  const match = AMOUNT_INPUT.exec(input);
  if (match === null) return undefined;
  const [, whole, fraction = ''] = match;
  if ((whole === '' && fraction === '') || fraction.length > decimals) return undefined;
  const fractionUnits = fraction.padEnd(decimals, '0');
  return (
    BigInt(whole === '' ? '0' : whole) * 10n ** BigInt(decimals) + BigInt(fractionUnits === '' ? '0' : fractionUnits)
  );
}

/** `value` in units of `decimals`, with every decimal shown and the whole part grouped: 1,234.567891. */
export function formatExactUnits(value: bigint, decimals: number): string {
  const magnitude = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = (magnitude / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = decimals > 0 ? `.${(magnitude % scale).toString().padStart(decimals, '0')}` : '';
  return `${value < 0n ? '-' : ''}${whole}${fraction}`;
}

/** Why a wrapped supply could not be reviewed. Its message is shown to the user. */
class WrappedSupplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WrappedSupplyError';
  }
}

/** The account's base-token balance and its allowance to the wrapper, read at one block. */
export type SupplyFunds = { blockNumber: number; walletBalance: bigint; allowance: bigint };

/** The calls a wrapped supply makes to the configured chain's public provider. */
export type SupplyReadProvider = Pick<JsonRpcProvider, 'call' | 'getBlockNumber'>;

/**
 * The newest block in which one of the account's wrapper transactions was mined, as the wallet's
 * node reported its receipt, or undefined when none has settled in this session.
 */
export function newestReceiptBlock(settled: readonly SettledTransaction[]): number | undefined {
  return settled.reduce<number | undefined>((newest, { outcome }) => {
    if (outcome.status === 'replaced' || typeof outcome.receipt.blockNumber !== 'number') return newest;
    return newest === undefined || outcome.receipt.blockNumber > newest ? outcome.receipt.blockNumber : newest;
  }, undefined);
}

/**
 * Reads the account's base-token balance and its allowance to the wrapper, both at one block that
 * is at least `minBlock`, the block of the account's newest settled wrapper transaction. Otherwise
 * a read just after a confirmed approval can miss it, and a fresh review asks for the approval
 * again. A provider that does not reach the block in time fails the read.
 */
async function readSupplyFunds(
  provider: SupplyReadProvider,
  identity: WrappedActionIdentity,
  minBlock: number | undefined,
  wait: BlockWait = DEFAULT_BLOCK_WAIT
): Promise<SupplyFunds> {
  const blockNumber = await waitForBlock(provider, minBlock, wait);
  if (blockNumber === undefined) {
    throw new WrappedSupplyError(
      "This market's network has not shown your last wrapped transaction yet. Try again in a moment."
    );
  }
  const read = (method: 'balanceOf' | 'allowance', args: string[]) =>
    provider
      .call({ to: identity.baseTokenAddress, data: baseTokenInterface.encodeFunctionData(method, args) }, blockNumber)
      .then((result) => BigInt(baseTokenInterface.decodeFunctionResult(method, result)[0].toString()));
  const [walletBalance, allowance] = await Promise.all([
    read('balanceOf', [identity.account]),
    read('allowance', [identity.account, identity.wrapperAddress]),
  ]);
  return { blockNumber, walletBalance, allowance };
}

/** The reads a wrapped supply makes through the configured chain's public provider. */
export type WrappedSupplyReads = {
  /** The balance and allowance at a block no older than the account's last settled wrapper transaction. */
  readFunds: () => Promise<SupplyFunds>;
  /** An `eth_call` at a block. */
  call: (request: { from: string; to: string; data: string }, blockNumber: number) => Promise<string>;
};

const ERROR_STRING_SELECTOR = '0x08c379a0';
const PANIC_SELECTOR = '0x4e487b71';

/** The revert data an error carries. Ethers keeps it in `data`, sometimes on a nested error. */
function revertData(error: unknown): string | undefined {
  const queue: unknown[] = [error];
  for (let visited = 0; queue.length > 0 && visited < 8; visited++) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null) continue;
    const { data, error: inner, cause } = current as { data?: unknown; error?: unknown; cause?: unknown };
    if (typeof data === 'string' && /^0x[0-9a-f]{8}/i.test(data)) return data;
    queue.push(inner, cause);
  }
  return undefined;
}

/** A revert as its reason string, a panic code, one of the wrapper's own errors, or its selector. */
function describeRevertData(data: string): string {
  const selector = data.slice(0, 10).toLowerCase();
  try {
    if (selector === ERROR_STRING_SELECTOR) return String(defaultAbiCoder.decode(['string'], `0x${data.slice(10)}`)[0]);
    if (selector === PANIC_SELECTOR) return `Panic(${defaultAbiCoder.decode(['uint256'], `0x${data.slice(10)}`)[0]})`;
    return wrapperInterface.parseError(data).signature;
  } catch {
    return `revert data ${selector}`;
  }
}

/**
 * Why a call through the provider failed. Ethers reports every `eth_call` that fails without
 * revert data as a revert without a reason string, a timeout or a rate limit included, and keeps
 * the provider's own error in `error`. That error says what happened, so it is described instead.
 */
function describeCallFailure(error: unknown): string {
  const inner = typeof error === 'object' && error !== null ? (error as { error?: unknown }).error : undefined;
  return describeWalletError(inner ?? error);
}

/** Why a simulation failed: the revert it carries, or why the call failed. */
function describeSimulationFailure(error: unknown): string {
  const data = revertData(error);
  return data === undefined ? describeCallFailure(error) : describeRevertData(data);
}

/**
 * Simulates `supplyAndWrap(amount)` from the account with an `eth_call` at `blockNumber`, just
 * before the wallet is asked to sign it. The call must return a positive number of shares. Ethers
 * returns a revert's data as the call's result, so the result is decoded rather than trusted. A
 * failed simulation refuses the step. Nothing else is tried in its place.
 */
async function simulateSupplyAndWrap(
  call: WrappedSupplyReads['call'],
  identity: WrappedActionIdentity,
  amount: bigint,
  blockNumber: number
): Promise<WrappedStepCheck> {
  const refuse = (detail: string): WrappedStepCheck => ({
    ok: false,
    message: `Simulating the supply from your account failed (${detail}), so your wallet was not asked to sign it.`,
  });
  let shares: bigint;
  try {
    const result = await call(
      {
        from: identity.account,
        to: identity.wrapperAddress,
        data: wrapperInterface.encodeFunctionData('supplyAndWrap', [amount]),
      },
      blockNumber
    );
    shares = BigInt(wrapperInterface.decodeFunctionResult('supplyAndWrap', result)[0].toString());
  } catch (error) {
    return refuse(describeSimulationFailure(error));
  }
  return shares > 0n ? { ok: true } : refuse('it mints no shares');
}

function isSameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isMarketOf(market: WrappedMarket, identity: WrappedActionIdentity): boolean {
  return (
    market.chainId === identity.chainId &&
    isSameAddress(market.cometAddress, identity.cometAddress) &&
    isSameAddress(market.wrapperAddress, identity.wrapperAddress) &&
    isSameAddress(market.baseTokenAddress, identity.baseTokenAddress)
  );
}

/** The allowance a step expects before it is signed: exactly one amount, or at least one. */
type AllowanceRule = { exactly: bigint } | { atLeast: bigint };

export type PrepareWrappedSupplyInput = {
  identity: WrappedActionIdentity;
  market: WrappedMarket;
  /** In raw base-token units. */
  amount: bigint;
  symbol: string;
  reads: WrappedSupplyReads;
};

/**
 * Reads the account's wallet balance and allowance to the wrapper again and builds the steps of a
 * wrapped supply of `amount`:
 * - When the allowance covers the amount, the wrapper's `supplyAndWrap(amount)` alone.
 * - Otherwise the base token's `approve(wrapper, amount)` first. For a token such as USDT, whose
 *   `approve` refuses to change one nonzero allowance to another, a nonzero allowance is first
 *   reset with `approve(wrapper, 0)`.
 *
 * The amount must be positive and within the wallet balance just read. The approval is for exactly
 * the amount, never more. Before each signature, its step reads the balance and allowance again.
 * The step stops, and the user reviews again, when the balance is below the amount or the
 * allowance is not the one the plan expects:
 * - before a reset, or an approval with no reset before it, exactly the allowance read at review
 * - before an approval after a reset, zero
 * - before the supply, at least the amount
 *
 * The supply is then simulated from the account, at the block of that read.
 */
export async function prepareWrappedSupply({
  identity,
  market,
  amount,
  symbol,
  reads,
}: PrepareWrappedSupplyInput): Promise<{ amount: bigint; steps: WrappedStep[] }> {
  if (identity.type !== 'supply' || !isMarketOf(market, identity)) {
    throw new WrappedSupplyError('The wrapper for this market changed. Review the supply again.');
  }
  if (amount <= 0n) throw new WrappedSupplyError('Enter an amount greater than 0.');
  if (amount >= MAX_UINT256) throw new WrappedSupplyError('An unlimited amount cannot be supplied or approved.');

  const formatAmount = (value: bigint) =>
    value >= UNLIMITED_AMOUNT
      ? `an unlimited amount of ${symbol}`
      : `${formatExactUnits(value, market.baseDecimals)} ${symbol}`;
  let funds: SupplyFunds;
  try {
    funds = await reads.readFunds();
  } catch (error) {
    if (error instanceof WrappedSupplyError) throw error;
    throw new WrappedSupplyError(
      `Your wallet balance and allowance could not be read (${describeCallFailure(error)}). Try again in a moment.`
    );
  }
  if (amount > funds.walletBalance) {
    throw new WrappedSupplyError(`The amount is more than the ${formatAmount(funds.walletBalance)} in your wallet.`);
  }

  const checkBefore = (rule: AllowanceRule, shouldSimulate: boolean) => async (): Promise<WrappedStepCheck> => {
    let fundsBeforeSigning: SupplyFunds;
    try {
      fundsBeforeSigning = await reads.readFunds();
    } catch (error) {
      return {
        ok: false,
        message: `Your wallet balance and allowance could not be read again (${describeCallFailure(error)}).`,
      };
    }
    if (fundsBeforeSigning.walletBalance < amount) {
      const held = formatAmount(fundsBeforeSigning.walletBalance);
      return { ok: false, message: `Your wallet now holds ${held}, less than this supply. Review the supply again.` };
    }
    const { allowance } = fundsBeforeSigning;
    if ('exactly' in rule ? allowance !== rule.exactly : allowance < rule.atLeast) {
      return {
        ok: false,
        message: `The wrapper's allowance is now ${formatAmount(
          allowance
        )}, not what this review expected. Review the supply again.`,
      };
    }
    return shouldSimulate
      ? simulateSupplyAndWrap(reads.call, identity, amount, fundsBeforeSigning.blockNumber)
      : { ok: true };
  };

  const approval = (id: string, approvedAmount: bigint, description: string, rule: AllowanceRule): WrappedStep => ({
    id,
    kind: 'approve',
    description,
    request: {
      to: identity.baseTokenAddress,
      data: baseTokenInterface.encodeFunctionData('approve', [identity.wrapperAddress, approvedAmount]),
    },
    check: checkBefore(rule, false),
  });

  const steps: WrappedStep[] = [];
  const allowanceAtReview = funds.allowance;
  if (allowanceAtReview < amount) {
    const isResetFirst = allowanceAtReview > 0n && requiresAllowanceReset(identity.chainId, identity.baseTokenAddress);
    if (isResetFirst) {
      steps.push(
        approval(WRAPPED_SUPPLY_STEP_IDS.reset, 0n, `Reset the ${symbol} allowance for the wrapper to 0`, {
          exactly: allowanceAtReview,
        })
      );
    }
    steps.push(
      approval(WRAPPED_SUPPLY_STEP_IDS.approve, amount, `Approve ${formatAmount(amount)} for the wrapper`, {
        exactly: isResetFirst ? 0n : allowanceAtReview,
      })
    );
  }
  steps.push({
    id: WRAPPED_SUPPLY_STEP_IDS.supply,
    kind: 'supply-and-wrap',
    description: `Supply ${formatAmount(amount)} through the wrapper`,
    request: { to: identity.wrapperAddress, data: wrapperInterface.encodeFunctionData('supplyAndWrap', [amount]) },
    check: checkBefore({ atLeast: amount }, true),
  });
  return { amount, steps };
}

export type WriteWrappedState = {
  /**
   * Starts a fresh review of a wrapped supply of `amount`, in raw base-token units. Returns why it
   * was refused, if it was. The review reads the wallet balance and allowance again, and each step
   * is signed only after its own confirmation, through the wrapper action lifecycle.
   */
  supply: (amount: bigint) => WrappedBlockReason | undefined;
};

/** The wrapped writes outside the wrapped route. */
export const IDLE_WRITE_WRAPPED_STATE: WriteWrappedState = Object.freeze<WriteWrappedState>({
  supply: () => 'not-wrapped',
});

export type UseWriteWrappedStateOptions = {
  action: Pick<WrappedActionController, 'start' | 'recovered'>;
  route: LendingRoute;
  /** The configured chain's public provider. The supply's reads and simulation go through it. */
  readProvider: SupplyReadProvider | undefined;
  /** The selected market's base asset symbol, for the steps' descriptions. */
  baseSymbol: string | undefined;
  blockWait?: BlockWait;
};

/**
 * The wrapped route's writes: a wrapped supply through `supplyAndWrap`, straight from the wallet.
 * It never uses the standard queue, the Bulker, Permit2, a permit or a Comet manager permission.
 */
export function useWriteWrappedState({
  action,
  route,
  readProvider,
  baseSymbol,
  blockWait = DEFAULT_BLOCK_WAIT,
}: UseWriteWrappedStateOptions): WriteWrappedState {
  // A form or dialog can keep `supply` from an earlier render, and steps read when they are
  // confirmed, so both read the live values.
  const live = useRef({ action, route, readProvider, baseSymbol, blockWait });
  live.current = { action, route, readProvider, baseSymbol, blockWait };

  const supply = (amount: bigint): WrappedBlockReason | undefined => {
    const current = live.current;
    if (current.route.kind !== 'wrapped' || current.route.market === undefined) return 'not-wrapped';
    const { market } = current.route;
    const provider = current.readProvider;
    const symbol = current.baseSymbol ?? 'base token';
    return current.action.start('supply', async (identity) => {
      if (provider === undefined) {
        throw new WrappedSupplyError("This market's network cannot be read right now. Try again in a moment.");
      }
      return prepareWrappedSupply({
        identity,
        market,
        amount,
        symbol,
        reads: {
          // Each read waits for the provider to show this account's newest settled wrapper
          // transaction, such as the approval a review's previous step just confirmed.
          readFunds: () =>
            readSupplyFunds(
              provider,
              identity,
              newestReceiptBlock(live.current.action.recovered.settled),
              live.current.blockWait
            ),
          call: (request, blockNumber) => provider.call(request, blockNumber),
        },
      });
    });
  };

  return { supply };
}

// Reads of the fork's state for test assertions, straight from anvil in Node: receipts, blocks, USDC and
// Comet. Every Comet read is at an explicit block, so it sees the index of the block that mined the action.
import type { Address, Hash, PublicClient } from 'viem';

import { BLOCK_SECONDS } from './blockTime';
import { COMET_ABI, COMET_USDC, ERC20_ABI, USDC } from './contracts';

export type CometAt = { principal: bigint; balance: bigint; supplyIndex: bigint; lastAccrualTime: bigint };

export const usdcBalance = (fork: PublicClient, account: Address, blockNumber?: bigint) =>
  fork.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [account], blockNumber });

export const usdcAllowance = (fork: PublicClient, account: Address, blockNumber?: bigint) =>
  fork.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account, COMET_USDC],
    blockNumber,
  });

/** The account's Comet principal and balance, and the market's supply index, at `blockNumber`. */
export async function cometAt(fork: PublicClient, account: Address, blockNumber: bigint): Promise<CometAt> {
  const [basic, totals, balance] = await Promise.all([
    fork.readContract({ address: COMET_USDC, abi: COMET_ABI, functionName: 'userBasic', args: [account], blockNumber }),
    fork.readContract({ address: COMET_USDC, abi: COMET_ABI, functionName: 'totalsBasic', blockNumber }),
    fork.readContract({ address: COMET_USDC, abi: COMET_ABI, functionName: 'balanceOf', args: [account], blockNumber }),
  ]);
  return { principal: basic[0], balance, supplyIndex: totals[0], lastAccrualTime: BigInt(totals[6]) };
}

/**
 * The receipt of `hash`, checked on the fork: it succeeded, it is from `from` to `to`, its block is the
 * canonical block at its height on the same node, and that block came exactly `BLOCK_SECONDS` after its
 * parent, as the wallet set it.
 */
export async function minedOnFork(fork: PublicClient, hash: Hash, { from, to }: { from: Address; to: Address }) {
  // anvil mines an automined transaction just after it answers `eth_sendTransaction`.
  const receipt = await fork.waitForTransactionReceipt({ hash, pollingInterval: 100, timeout: 30_000 });
  const transaction = await fork.getTransaction({ hash });
  const block = await fork.getBlock({ blockNumber: receipt.blockNumber });
  const parent = await fork.getBlock({ blockNumber: receipt.blockNumber - 1n });
  const problems = [
    receipt.status !== 'success' && `status ${receipt.status}`,
    receipt.from.toLowerCase() !== from.toLowerCase() && `from ${receipt.from}`,
    receipt.to?.toLowerCase() !== to.toLowerCase() && `to ${receipt.to}`,
    transaction.chainId !== 1 && `chain ${transaction.chainId}`,
    block.hash !== receipt.blockHash && 'a block hash that is not canonical on the fork',
    !block.transactions.includes(hash) && 'a block without the transaction',
    block.timestamp - parent.timestamp !== BigInt(BLOCK_SECONDS) &&
      `a block ${block.timestamp - parent.timestamp} s after its parent`,
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(`transaction ${hash} on the fork: ${problems.join(', ')}`);
  return { receipt, block };
}

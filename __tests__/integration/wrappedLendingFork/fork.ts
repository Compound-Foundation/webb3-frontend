import { JsonRpcProvider } from '@ethersproject/providers';

/**
 * The local fork's URL, which the runner passes in. It must be plain HTTP on the loopback
 * interface. The runner never passes the upstream RPC URL to the suite.
 */
function localForkUrl(): string {
  const value = process.env.WRAPPED_FORK_LOCAL_RPC_URL;
  if (value === undefined || value === '') {
    throw new Error(
      'Run the fork suite with `node scripts/test-wrapped-lending-fork.js`, which starts the local fork.'
    );
  }
  const url = new URL(value);
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'http:' || !isLoopback || url.port === '' || url.pathname !== '/' || url.username !== '') {
    throw new Error('The fork suite runs only against a local fork at http://127.0.0.1:<port>.');
  }
  return `http://${url.hostname}:${url.port}`;
}

export const LOCAL_FORK_URL = localForkUrl();

/** A provider for the local fork. Each caller gets its own, as the app's wallet and public providers are separate. */
export function forkProvider(): JsonRpcProvider {
  const provider = new JsonRpcProvider(LOCAL_FORK_URL, { chainId: 1, name: 'homestead' });
  provider.pollingInterval = 50;
  return provider;
}

/** The fork block and hash the runner forked from, and whether that was the pinned block or a recent one. */
export const FORK_RUN = Object.freeze({
  blockNumber: Number(process.env.WRAPPED_FORK_BLOCK),
  blockHash: String(process.env.WRAPPED_FORK_BLOCK_HASH).toLowerCase(),
  mode: process.env.WRAPPED_FORK_MODE === 'pinned' ? ('pinned' as const) : ('recent' as const),
});

/** Anvil's own methods, which only the local fork answers. Every state change they make stays on the fork. */
const rpc = forkProvider();

export const anvil = {
  send: (method: string, params: unknown[] = []) => rpc.send(method, params),
  snapshot: (): Promise<string> => rpc.send('evm_snapshot', []),
  revert: async (id: string) => {
    if ((await rpc.send('evm_revert', [id])) !== true) throw new Error(`The fork did not revert to snapshot ${id}.`);
  },
  impersonate: (account: string) => rpc.send('anvil_impersonateAccount', [account]),
  setBalance: (account: string, wei: bigint) => rpc.send('anvil_setBalance', [account, `0x${wei.toString(16)}`]),
  setStorageAt: (contract: string, slot: string, value: bigint) =>
    rpc.send('anvil_setStorageAt', [contract, slot, `0x${value.toString(16).padStart(64, '0')}`]),
  getStorageAt: async (contract: string, slot: string): Promise<bigint> =>
    BigInt(await rpc.send('eth_getStorageAt', [contract, slot, 'latest'])),
  /** The next mined block's timestamp. Anvil accepts the previous block's own timestamp. */
  setNextBlockTimestamp: (timestamp: number) => rpc.send('evm_setNextBlockTimestamp', [timestamp]),
  increaseTime: (seconds: number) => rpc.send('evm_increaseTime', [seconds]),
  /** Mines every later block at the latest block's timestamp, so no interest accrues between them. */
  freezeTime: () => rpc.send('anvil_setBlockTimestampInterval', [0]),
  unfreezeTime: () => rpc.send('anvil_removeBlockTimestampInterval', []),
  mine: () => rpc.send('evm_mine', []),
  latestBlock: async () => {
    const block = await rpc.getBlock('latest');
    return { number: block.number, timestamp: block.timestamp, hash: block.hash };
  },
};

type AnvilMetadata = {
  clientVersion: string;
  chainId: number;
  forkedNetwork: { chainId: number; forkBlockNumber: number; forkBlockHash: string } | null;
};

/**
 * Fails unless the suite is talking to the anvil fork that the runner started. That fork is an anvil
 * node on chain 1, forked from the block and hash that the runner recorded. `anvil_metadata` carries
 * no upstream URL, unlike `anvil_nodeInfo`, which the suite never calls.
 */
export async function assertLocalFork(): Promise<void> {
  const metadata = (await rpc.send('anvil_metadata', [])) as AnvilMetadata;
  if (!metadata.clientVersion.startsWith('anvil/')) throw new Error('The target is not an anvil node.');
  if (Number(metadata.chainId) !== 1 || metadata.forkedNetwork === null) {
    throw new Error('The target is not a fork of Ethereum mainnet.');
  }
  const { forkBlockNumber, forkBlockHash } = metadata.forkedNetwork;
  if (Number(forkBlockNumber) !== FORK_RUN.blockNumber || forkBlockHash.toLowerCase() !== FORK_RUN.blockHash) {
    throw new Error(
      `The fork is at block ${forkBlockNumber}, not the block ${FORK_RUN.blockNumber} the runner recorded.`
    );
  }
}

import fs from 'fs';
import net from 'net';
import path from 'path';

import { JsonRpcProvider } from '@ethersproject/providers';
import { utils } from 'ethers';

import { WRAPPER_FACTORY_BY_CHAIN_ID } from '@constants/wrappedMarkets';
import WrappedCometFactoryAbi from '@helpers/abis/WrappedCometERC4626Factory';
import { validateWrappedMarket } from '@hooks/useLendingRoute';

import { COMET, ERC20, FORK_MARKETS, read, WRAPPER } from './fixtures';
import { assertLocalFork, forkProvider, FORK_RUN } from './fork';
import { notExercised, scenario } from './results';

const FACTORY = WRAPPER_FACTORY_BY_CHAIN_ID[1];
const FACTORY_CALLS = new utils.Interface([
  ...WrappedCometFactoryAbi,
  'function PERMIT2() view returns (address)',
  'function owner() view returns (address)',
  'function allWrappersLength() view returns (uint256)',
]);
const WRAPPER_VIEWS = new utils.Interface([
  'function PERMIT2() view returns (address)',
  'function name() view returns (string)',
]);
const CANONICAL_PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/**
 * The `keccak256` of each wrapper's runtime code, as docs/anchorage-wrapper-registry.md records it
 * from block 26244888, in the order of the committed source. The wrappers have no proxy and no
 * self-destruct, so the code is the same at any later block.
 */
const REGISTRY_CODE_HASHES = [
  '0x9728c01fdcd25e6a298d083882b42ac3d62760e14ee777fd55b7f2d3e056ef9f',
  '0x97124cac3cce6528726ac0de859f55b6c6fdae2badedf4fefdad02890360f554',
  '0xa931ec78743e6fc12a6593725fd9528937d4cea2dccaa0a02994eea5e48a3847',
];
const REGISTRY_DOC = fs.readFileSync(path.join(__dirname, '../../../docs/anchorage-wrapper-registry.md'), 'utf8');

const provider = forkProvider();

beforeAll(assertLocalFork);

test('the suite reaches the local fork it was started for, and no other host', async () => {
  expect(FORK_RUN.blockNumber).toBeGreaterThan(26_098_209);
  const upstream = new JsonRpcProvider('https://ethereum-rpc.publicnode.com');
  // Ethers wraps the refusal from forkSetup.ts as the server error of a missing response.
  await expect(upstream.send('eth_blockNumber', [])).rejects.toMatchObject({
    serverError: expect.objectContaining({ message: expect.stringMatching(/only talks to the local fork/) }),
  });
  // A raw TCP connection, which any library would make through `net`, is refused too.
  expect(() => net.connect(443, 'ethereum-rpc.publicnode.com')).toThrow(/only connects to the local fork/);
  expect((await provider.getNetwork()).chainId).toBe(1);
});

describe.each(FORK_MARKETS.map((forkMarket, index) => ({ ...forkMarket, index })))('$label', (forkMarket) => {
  const { market, label, index } = forkMarket;

  scenario('deployment', label, async (measured) => {
    const code = await provider.getCode(market.wrapperAddress);
    measured.codeHash = utils.keccak256(code);
    measured.codeBytes = (code.length - 2) / 2;
    expect(REGISTRY_DOC).toContain(REGISTRY_CODE_HASHES[index]);
    expect(measured.codeHash).toBe(REGISTRY_CODE_HASHES[index]);

    const [canonical] = await read(FACTORY, FACTORY_CALLS, 'getWrapper', [market.cometAddress]);
    expect(String(canonical).toLowerCase()).toBe(market.wrapperAddress.toLowerCase());
    const [asset] = await read(market.wrapperAddress, WRAPPER, 'asset');
    expect(String(asset).toLowerCase()).toBe(market.cometAddress.toLowerCase());
    const [baseToken] = await read(market.cometAddress, COMET, 'baseToken');
    expect(String(baseToken).toLowerCase()).toBe(market.baseTokenAddress.toLowerCase());
    const [shareDecimals] = await read(market.wrapperAddress, WRAPPER, 'decimals');
    const [baseDecimals] = await read(market.baseTokenAddress, ERC20, 'decimals');
    expect([Number(shareDecimals), Number(baseDecimals)]).toEqual([market.shareDecimals, market.baseDecimals]);
    const [permit2] = await read(market.wrapperAddress, WRAPPER_VIEWS, 'PERMIT2');
    expect(permit2).toBe(CANONICAL_PERMIT2);
    measured.name = String((await read(market.wrapperAddress, WRAPPER_VIEWS, 'name'))[0]);

    // The app's own check, through the configured chain's provider, as `useLendingRoute` runs it.
    measured.appValidation = await validateWrappedMarket(forkProvider(), market);
    expect(measured.appValidation).toBe('matched');
  });

  const solcOutputPath = process.env.WRAPPED_FORK_SOLC_OUTPUT;
  if (solcOutputPath === undefined || solcOutputPath === '') {
    notExercised('source-build', label, 'no solc output of the pinned build input was given (--solc-output)');
  } else {
    scenario('source-build', label, async (measured) => {
      const compiled = compiledRuntime(solcOutputPath, 'project/src/WrappedCometERC4626.sol', 'WrappedCometERC4626');
      const onChain = await provider.getCode(market.wrapperAddress);
      const comparison = compareRuntime(onChain, compiled);
      Object.assign(measured, comparison.measured);
      expect(comparison.isEqualOutsideImmutables).toBe(true);
      // The immutables the constructor wrote: the Comet, its decimals, Permit2 and the 10^12 offset.
      expect(comparison.immutables._asset).toBe(utils.hexZeroPad(market.cometAddress, 32).toLowerCase());
      expect(BigInt(comparison.immutables._underlyingDecimals)).toBe(BigInt(market.baseDecimals));
      expect(comparison.immutables.PERMIT2).toBe(utils.hexZeroPad(CANONICAL_PERMIT2, 32).toLowerCase());
      expect(BigInt(comparison.immutables.DECIMALS_OFFSET)).toBe(BigInt(18 - market.baseDecimals));
      expect(BigInt(comparison.immutables.VIRTUAL_SHARES)).toBe(10n ** BigInt(18 - market.baseDecimals));
    });
  }
});

describe('factory', () => {
  const solcOutputPath = process.env.WRAPPED_FORK_SOLC_OUTPUT;
  if (solcOutputPath === undefined || solcOutputPath === '') {
    notExercised('source-build', 'factory', 'no solc output of the pinned build input was given (--solc-output)');
    return;
  }
  scenario('source-build', 'factory', async (measured) => {
    const compiled = compiledRuntime(
      solcOutputPath,
      'project/src/WrappedCometERC4626Factory.sol',
      'WrappedCometERC4626Factory'
    );
    const comparison = compareRuntime(await provider.getCode(FACTORY), compiled);
    Object.assign(measured, comparison.measured);
    expect(comparison.isEqualOutsideImmutables).toBe(true);
    expect(comparison.immutables.PERMIT2).toBe(utils.hexZeroPad(CANONICAL_PERMIT2, 32).toLowerCase());
    measured.allWrappersLength = String((await read(FACTORY, FACTORY_CALLS, 'allWrappersLength'))[0]);
    measured.owner = String((await read(FACTORY, FACTORY_CALLS, 'owner'))[0]);
  });
});

type CompiledRuntime = {
  object: string;
  /** Byte ranges of each immutable, by its name in the source. */
  immutables: Record<string, { start: number; length: number }[]>;
};

/** A contract's runtime code and immutable ranges from a solc standard-JSON output, with names from its AST. */
function compiledRuntime(outputPath: string, sourcePath: string, contractName: string): CompiledRuntime {
  const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  const deployed = output.contracts[sourcePath][contractName].evm.deployedBytecode;
  const names = new Map<number, string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === 'object' && node !== null) {
      const { id, nodeType, name } = node as { id?: number; nodeType?: string; name?: string };
      if (nodeType === 'VariableDeclaration' && typeof id === 'number' && typeof name === 'string') names.set(id, name);
      Object.values(node).forEach(visit);
    }
  };
  Object.values(output.sources as Record<string, { ast: unknown }>).forEach(({ ast }) => visit(ast));
  const immutables = Object.fromEntries(
    Object.entries(deployed.immutableReferences as Record<string, { start: number; length: number }[]>).map(
      ([id, ranges]) => [names.get(Number(id)) ?? `ast-${id}`, ranges]
    )
  );
  return { object: `0x${deployed.object}`, immutables };
}

/**
 * Compares deployed runtime code with the compiled runtime. The compiler leaves each immutable's
 * bytes as zeros for the constructor to fill, so both are compared with those ranges zeroed. Each
 * immutable must hold one value across all of its ranges, which is returned by name.
 */
function compareRuntime(onChain: string, compiled: CompiledRuntime) {
  const deployed = utils.arrayify(onChain);
  const expected = utils.arrayify(compiled.object);
  const masked = Uint8Array.from(deployed);
  const immutables: Record<string, string> = {};
  for (const [name, ranges] of Object.entries(compiled.immutables)) {
    const values = new Set(ranges.map(({ start, length }) => utils.hexlify(deployed.slice(start, start + length))));
    if (values.size !== 1) throw new Error(`The immutable ${name} holds different values in the deployed code.`);
    immutables[name] = [...values][0];
    ranges.forEach(({ start, length }) => masked.fill(0, start, start + length));
  }
  const isEqualOutsideImmutables =
    deployed.length === expected.length && utils.hexlify(masked) === utils.hexlify(expected);
  return {
    isEqualOutsideImmutables,
    immutables,
    measured: {
      deployedBytes: deployed.length,
      compiledBytes: expected.length,
      maskedRanges: Object.values(compiled.immutables).reduce((sum, ranges) => sum + ranges.length, 0),
      isEqualOutsideImmutables,
      ...Object.fromEntries(Object.entries(immutables).map(([name, value]) => [`immutable.${name}`, value])),
    },
  };
}

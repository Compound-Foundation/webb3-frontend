// Read-only subset of WrappedCometERC4626 (Compound-Foundation/comet-erc4626 at 1152de2), which
// inherits both functions from OpenZeppelin's ERC4626. `asset()` returns the Comet market the
// wrapper holds, not the market's base token.
export default [
  {
    inputs: [],
    name: 'asset',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
];

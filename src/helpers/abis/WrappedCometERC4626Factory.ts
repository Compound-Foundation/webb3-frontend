// Read-only subset of WrappedCometERC4626Factory (Compound-Foundation/comet-erc4626 at 1152de2).
// `getWrapper(comet)` is the public getter of the factory's comet-to-wrapper mapping and
// returns the zero address for a market with no wrapper.
export default [
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'getWrapper',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
];

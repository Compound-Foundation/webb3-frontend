// Subset of WrappedCometERC4626 (Compound-Foundation/comet-erc4626 at 1152de2). The views come from
// OpenZeppelin's ERC4626 and ERC20, which it inherits. `asset()` returns the Comet market the
// wrapper holds, not the market's base token. `supplyAndWrap` pulls `amount` of the base token
// from the caller on a plain ERC-20 allowance and mints shares to the caller. The errors are the
// wrapper's own that `supplyAndWrap` can revert with.
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
  {
    inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalSupply',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
    name: 'supplyAndWrap',
    outputs: [{ internalType: 'uint256', name: 'shares', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // `amount` is zero.
  { inputs: [], name: 'ZeroAssetsTransferred', type: 'error' },
  // Comet credited the wrapper nothing for the supply.
  { inputs: [], name: 'ZeroAssetsCredited', type: 'error' },
  // The supply is worth less than one share.
  { inputs: [], name: 'ZeroSharesMinted', type: 'error' },
];

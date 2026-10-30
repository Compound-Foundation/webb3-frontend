// Subset of WrappedCometERC4626 (Compound-Foundation/comet-erc4626 at 1152de2). The views come from
// OpenZeppelin's ERC4626 and ERC20, which it inherits. `asset()` returns the Comet market the
// wrapper holds, not the market's base token. `supplyAndWrap` pulls `amount` of the base token
// from the caller on a plain ERC-20 allowance and mints shares to the caller. `unwrapAndWithdraw`
// burns exactly `shares` from the caller and has Comet pay the base token to the caller. The errors
// are the wrapper's own that those two can revert with, and OpenZeppelin 5.7.0's error for a burn
// above the caller's balance.
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
  {
    inputs: [{ internalType: 'uint256', name: 'shares', type: 'uint256' }],
    name: 'unwrapAndWithdraw',
    outputs: [{ internalType: 'uint256', name: 'amount', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // `supplyAndWrap`: `amount` is zero. `unwrapAndWithdraw`: the shares are worth no more than the
  // buffer, `baseSupplyIndex / 1e15 + 2` base units.
  { inputs: [], name: 'ZeroAssetsTransferred', type: 'error' },
  // Comet credited the wrapper nothing for the supply.
  { inputs: [], name: 'ZeroAssetsCredited', type: 'error' },
  // The supply is worth less than one share.
  { inputs: [], name: 'ZeroSharesMinted', type: 'error' },
  // `unwrapAndWithdraw` was asked to burn no shares.
  { inputs: [], name: 'ZeroSharesBurned', type: 'error' },
  // Comet took more from the wrapper than the burned shares cover at the price before the exit.
  {
    inputs: [
      { internalType: 'uint256', name: 'sharesRequired', type: 'uint256' },
      { internalType: 'uint256', name: 'sharesBurned', type: 'uint256' },
    ],
    name: 'ExcessiveAssetsDebited',
    type: 'error',
  },
  // OpenZeppelin's ERC-20 `_burn`: the caller holds fewer shares than the exit burns.
  {
    inputs: [
      { internalType: 'address', name: 'sender', type: 'address' },
      { internalType: 'uint256', name: 'balance', type: 'uint256' },
      { internalType: 'uint256', name: 'needed', type: 'uint256' },
    ],
    name: 'ERC20InsufficientBalance',
    type: 'error',
  },
];

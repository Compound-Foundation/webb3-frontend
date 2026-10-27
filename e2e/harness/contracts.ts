// The mainnet contracts the USDC flow touches, their ABIs, and the raw-unit oracle for Comet balances.
import { encodeAbiParameters, keccak256, parseAbi, type Address } from 'viem';

export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address;
/** cUSDCv3, the Ethereum USDC Comet: `1_USDC_0xc3d688B66703497DAA19211EEdff47f25384cdc3` in the app. */
export const COMET_USDC = '0xc3d688B66703497DAA19211EEdff47f25384cdc3' as Address;
/** USDC's `balanceAndBlacklistStates` mapping (FiatTokenV2_2). The top bit of a value is the blacklist flag. */
export const USDC_BALANCE_SLOT = 9n;
export const USDC_DECIMALS = 6;
export const MAX_UINT256 = 2n ** 256n - 1n;

/** The canonical wrapper of the Ethereum USDC Comet, which `getWrapper(COMET_USDC)` returns. */
export const WRAPPER_USDC = '0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73' as Address;

export const WRAPPER_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function supplyAndWrap(uint256 amount) returns (uint256 shares)',
  'function unwrapAndWithdraw(uint256 shares) returns (uint256 assets)',
]);

export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export const COMET_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function supply(address asset, uint256 amount)',
  'function withdraw(address asset, uint256 amount)',
  'function baseToken() view returns (address)',
  'function userBasic(address) view returns (int104 principal, uint64 baseTrackingIndex, uint64 baseTrackingAccrued, uint16 assetsIn, uint8 _reserved)',
  'function totalsBasic() view returns (uint64 baseSupplyIndex, uint64 baseBorrowIndex, uint64 trackingSupplyIndex, uint64 trackingBorrowIndex, uint104 totalSupplyBase, uint104 totalBorrowBase, uint40 lastAccrualTime, uint8 pauseFlags)',
]);

/** The storage key of `address`'s entry in USDC's balance mapping. */
export const usdcBalanceKey = (address: Address) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [address, USDC_BALANCE_SLOT]));

/** Comet's `BASE_INDEX_SCALE` (CometCore.sol). */
export const BASE_INDEX_SCALE = 10n ** 15n;

/**
 * Comet's principal for a positive present value at supply index `index`: `principalValueSupply`, which
 * rounds down (CometCore.sol).
 */
export const principalOf = (presentValue: bigint, index: bigint) => (presentValue * BASE_INDEX_SCALE) / index;

/** Comet's present value of a positive principal at supply index `index`: `presentValueSupply`, rounded down. */
export const presentValueOf = (principal: bigint, index: bigint) => (principal * index) / BASE_INDEX_SCALE;

/**
 * The principal Comet stores after `supply(amount)` from an account whose principal is `before`, at the supply
 * index of the block that mined it: `principalValue(presentValue(before) + amount)` (`supplyBase`).
 */
export const principalAfterSupply = (before: bigint, amount: bigint, index: bigint) =>
  principalOf(presentValueOf(before, index) + amount, index);

/**
 * The principal Comet stores after `withdraw(amount)` that leaves a non-negative balance:
 * `principalValue(presentValue(before) - amount)` (`withdrawBase`).
 */
export const principalAfterWithdraw = (before: bigint, amount: bigint, index: bigint) => {
  const balance = presentValueOf(before, index) - amount;
  if (balance < 0n) throw new Error('the oracle covers withdrawals that leave a supply balance only');
  return principalOf(balance, index);
};

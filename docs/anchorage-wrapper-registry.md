# Anchorage wrapper registry: deployment evidence and release checks

`src/constants/wrappedMarkets.ts` maps three Ethereum Comet markets to their ERC-4626 wrappers. This document records where each address comes from and what was read on chain to confirm it. It also lists the checks that must pass before wrapped deposits or exits are switched on. Both release controls, `isDepositEnabled` and `isExitEnabled`, are `false` for every entry until the checks under [Unresolved release checks](#unresolved-release-checks) are closed.

The app also checks each mapping at run time, before it enables a wrapped action. Through the configured chain's public RPC, it reads the factory's `getWrapper(comet)`, the wrapper's `asset()` and `decimals()`, the Comet's `baseToken()` and the base token's `decimals()`, and compares them with the mapping. The factory address and the list of routed markets are kept in code, apart from the replaceable configuration source.

## Sources

| Source | Reference |
| -- | -- |
| Wrapper and factory source | [`Compound-Foundation/comet-erc4626` at `1152de2b3942df189817ff03213177061455fb1d`](https://github.com/Compound-Foundation/comet-erc4626/tree/1152de2b3942df189817ff03213177061455fb1d): `src/WrappedCometERC4626.sol`, `src/WrappedCometERC4626Factory.sol` |
| Factory deployment record | `ignition/deployments/chain-1/deployed_addresses.json` and `journal.jsonl` at the same commit |
| Integration rule | The README's "Creating and resolving wrappers": resolve a market's canonical wrapper with the factory's `getWrapper(comet)`, never by recomputing a CREATE2 address |
| Frontend market configuration | `src/helpers/markets.ts`, which reads the Comet addresses from `comet/deployments/mainnet/{usdc,usdt,institutional_usdc}/roots.json` |
| Base-token configuration | `comet/deployments/mainnet/usdc/configuration.json` and `.../usdt/configuration.json` (`baseTokenAddress`). `institutional_usdc` has no `configuration.json`, so its base token rests on the on-chain read below |

## Factory

| Item | Value |
| -- | -- |
| Address | `0xf77f675a383eB43fa032ea3c6d1dd4dC56B69BF6` |
| Deployment transaction | `0x19fcbe9b64f999df43ef92662ad69889853fff31ffe581f70702ec95e6a2ea18`, block 26097821, 2026-10-01 13:39:35 UTC, from `0x5c6266738D0Ef7C45FacA2699AE23eefD01d3acB` |
| `owner()` at the read block | `0xBcaa2988d7e1A6955A204B280c951fa3Aa5f1c0B` (the Safe that executed both `createWrapper` transactions) |
| `allWrappersLength()` at the read block | 3 |
| `PERMIT2()` at the read block | `0x000000000022D473030F116dDEE9F6B43aC78BA3` (canonical Permit2) |
| Source verification | Blockscout: verified (partial match). The verified `src/WrappedCometERC4626Factory.sol` is byte-identical to the file at `1152de2` |

## On-chain reads

All reads were made with `cast call -b 26244888` against Ethereum mainnet. Block 26244888 has hash `0x440c51a6a6953b880568c1b60e4ad59044f3fa783e340e34d66793e466883839` and timestamp 2026-10-22 01:32:47 UTC.

| Read | Ethereum USDC | Ethereum USDT | Ethereum institutional USDC |
| -- | -- | -- | -- |
| Comet (frontend `MARKETS`) | `0xc3d688B66703497DAA19211EEdff47f25384cdc3` | `0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840` | `0x207158a267CBD2598BB3d611D8CBdEE2709F2F8C` |
| `factory.getWrapper(comet)` | `0x89dd54aB898944BB4cb8a2C403B7D511F88f9E73` | `0xD7c9F42a35C8d13b71D4c0B024AE9eb0e77b9cFf` | `0xc7Eb9aA5B9ae154C1bAb08872E90fC44e522E463` |
| `wrapper.asset()` | the Comet | the Comet | the Comet |
| `wrapper.decimals()` | 18 | 18 | 18 |
| `wrapper.name()` / `symbol()` | Wrapped Compound USDC / wcUSDCv3 | Wrapped Compound USDT / wcUSDTv3 | Wrapped Compound Institutional USDC / wciUSDCv3 |
| `wrapper.PERMIT2()` | canonical Permit2 | canonical Permit2 | canonical Permit2 |
| `comet.baseToken()` | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | USDT `0xdAC17F958D2ee523a2206206994597C13D831ec7` | USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| `comet.decimals()` | 6 | 6 | 6 |
| Base token `decimals()` | 6 | 6 | 6 |
| `keccak256` of runtime code | `0x9728c01fdcd25e6a298d083882b42ac3d62760e14ee777fd55b7f2d3e056ef9f` | `0x97124cac3cce6528726ac0de859f55b6c6fdae2badedf4fefdad02890360f554` | `0xa931ec78743e6fc12a6593725fd9528937d4cea2dccaa0a02994eea5e48a3847` |

The runtime code hashes differ because each wrapper embeds its own constructor values as immutables. All three runtimes are 10,422 bytes.

The base tokens of the USDC and USDT entries also match `baseTokenAddress` in the Comet deployment configuration the frontend is built from. `__tests__/helpers/wrappedMarkets.test.ts` asserts that match.

## Deployment transactions

| Market | Transaction | Block | `WrapperCreated` log |
| -- | -- | -- | -- |
| Ethereum USDC | `0xa30f21a9655f81e09e434e29cb1e0327877d575862d9f651a72260a731b2acbc` (Safe `execTransaction`) | 26098209, 2026-10-01 14:57:35 UTC | log index 252: comet and wrapper as above, `seedBase` 10000000, `seedSharesBurned` 9999999000000000000 |
| Ethereum USDT | same transaction as USDC | 26098209 | log index 260: comet and wrapper as above, `seedBase` 10000000, `seedSharesBurned` 9999999000000000000 |
| Ethereum institutional USDC | `0x84ac012a0a0182845ecb1904f18c572ff4d91acc1e5ea2dccc780680ca3039f4` (Safe `execTransaction`) | 26105183, 2026-10-02 14:17:35 UTC | log index 150: comet and wrapper as above, `seedBase` 10000000, `seedSharesBurned` 9999999000000000000 |

Both transactions succeeded and were sent by `0x5c6266738D0Ef7C45FacA2699AE23eefD01d3acB` to the factory owner Safe. The creation blocks bound the historical log queries that the history work needs.

## Source and audit coverage

- **Verified source.** Blockscout marks all three wrappers as verified with a partial match: the compiled bytecode matches, and the metadata hash does not. Compiler `0.8.28+commit.7893614a`, optimizer on with 200 runs, EVM version `cancun`. The verified `src/WrappedCometERC4626.sol` of each wrapper is byte-identical to the file at `1152de2`. The decoded constructor arguments of each wrapper are its Comet, the name and symbol above, and canonical Permit2.
- **Audit.** Certora reviewed commit `d5324b8` (21 to 24 September 2026) and confirmed its fixes in `e53267d` and `f0dcf4a`. The deployed wrappers' verified source equals `src/WrappedCometERC4626.sol` at `1152de2`, which is 25 commits after `f0dcf4a`. Two of the commits in between change executable code: in `97265b9` and `7f60b8a`, `previewDeposit`, `previewMint` and `previewRedeem` revert in the cases where the action they preview reverts. Two later commits change comments only (`6e2dc85`, `d965d96`). The audit did not cover the preview changes.

## Unresolved release checks

New wrapped deposits and wrapped exits stay disabled until each check below is closed and the closure is recorded here.

1. **Audit coverage of the post-audit changes.** Get Certora's or another reviewer's sign-off on the `f0dcf4a...1152de2` changes to `src/WrappedCometERC4626.sol`, or record a decision to accept them unaudited.
2. **Full source match.** The Blockscout verification is a partial match. Confirm a full match, or reproduce each wrapper's runtime bytecode from the `1152de2` build input with the immutables masked, and record the result.
3. **Factory owner.** Record the owner Safe's signers and threshold, and who controls them. The owner cannot change a deployed wrapper, but it chooses which wrapper `getWrapper` returns for a new market.
4. **Live reads at release.** Repeat the reads above at a fresh block on release day, including the Comets' `isSupplyPaused()`, `isWithdrawPaused()` and `isTransferPaused()`.
5. **Transaction paths.** Mainnet-fork coverage of supply, partial and full exits and the USDT allowance reset (COM-289) and Porto signing acceptance (COM-290).
6. **Rollout decision.** The release (COM-292) decides when `isDepositEnabled` and `isExitEnabled` change, separately, and how exits stay available if deposits are switched off again.

No contract was deployed, funded or called with a transaction for this record.

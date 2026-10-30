import { ChainInformation } from '@types';

// Unwrapped collateral (stETH) is supplied as its wrapped asset (wstETH), and only the wrapped one is in the summary
export function getStatusCollateralAddress(chainInformation: ChainInformation, assetAddress: string): string {
  const wrapped = Object.entries(chainInformation.unwrappedCollateralAssets).find(
    ([, unwrapped]) => unwrapped.address.toLowerCase() === assetAddress.toLowerCase()
  );
  return wrapped ? wrapped[0] : assetAddress;
}

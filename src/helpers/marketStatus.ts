import { ChainInformation, CollateralStatus, LatestMarketSummaryResponse, MarketStatus } from '@types';

export type MarketStatusIndex = Map<string, { status?: MarketStatus; collaterals: Map<string, CollateralStatus> }>;

export function buildMarketStatusIndex(summaries: LatestMarketSummaryResponse[]): MarketStatusIndex {
  return new Map(
    summaries.map((summary) => [
      `${summary.chainId}:${summary.comet.address.toLowerCase()}`,
      {
        status: summary.status,
        collaterals: new Map(
          (summary.collaterals ?? []).map((collateral) => [collateral.address.toLowerCase(), collateral.status])
        ),
      },
    ])
  );
}

export function getMarketStatus(
  index: MarketStatusIndex,
  chainId: number,
  cometAddress: string
): MarketStatus | undefined {
  return index.get(`${chainId}:${cometAddress.toLowerCase()}`)?.status;
}

export function getCollateralStatus(
  index: MarketStatusIndex,
  chainId: number,
  cometAddress: string,
  collateralAddress: string
): CollateralStatus | undefined {
  return index.get(`${chainId}:${cometAddress.toLowerCase()}`)?.collaterals.get(collateralAddress.toLowerCase());
}

// Unwrapped collateral (stETH) is supplied as its wrapped asset (wstETH), and only the wrapped one is in the summary
export function getStatusCollateralAddress(chainInformation: ChainInformation, assetAddress: string): string {
  const wrapped = Object.entries(chainInformation.unwrappedCollateralAssets).find(
    ([, unwrapped]) => unwrapped.address.toLowerCase() === assetAddress.toLowerCase()
  );
  return wrapped ? wrapped[0] : assetAddress;
}

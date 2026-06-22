import { sanitizeMarketSummary } from '@pages/markets/hooks/useMarketsOverviewState';

// Ethereum Mainnet USDC comet (from deployments/mainnet/usdc/roots.json)
const MAINNET_USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';

const makeResponse = (chainId: number, cometAddress: string, collateralAssetSymbols: string[] | null) => ({
  chainId,
  comet: { address: cometAddress },
  borrowApr: '0',
  supplyApr: '0',
  totalBorrowValue: '0',
  totalSupplyValue: '0',
  totalCollateralValue: '0',
  utilization: '0',
  timestamp: 0,
  date: '2026-06-22',
  baseUsdPrice: '1',
  collateralAssetSymbols,
});

describe('sanitizeMarketSummary', () => {
  test('strips legacy collateral for mainnet USDC comet', () => {
    const result = sanitizeMarketSummary(
      makeResponse(1, MAINNET_USDC_COMET, ['WBTC', 'USDe', 'COMP', 'deUSD', 'LINK']) as any
    );
    expect(result.collateralAssetSymbols).toEqual(['WBTC', 'COMP', 'LINK']);
  });

  test('leaves collateral untouched for non-configured comet', () => {
    const result = sanitizeMarketSummary(
      makeResponse(8453, '0x0000000000000000000000000000000000000001', ['WBTC', 'USDe', 'COMP']) as any
    );
    expect(result.collateralAssetSymbols).toEqual(['WBTC', 'USDe', 'COMP']);
  });

  test('returns empty array when collateralAssetSymbols is null', () => {
    const result = sanitizeMarketSummary(makeResponse(1, MAINNET_USDC_COMET, null) as any);
    expect(result.collateralAssetSymbols).toEqual([]);
  });
});

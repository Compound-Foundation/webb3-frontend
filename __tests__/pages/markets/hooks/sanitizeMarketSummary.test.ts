import { sanitizeMarketSummary } from '@pages/markets/hooks/useMarketsOverviewState';
import { LatestMarketSummaryResponse } from '@types';

import { MOCK_MARKETS } from '../../../mocks/mockMarkets';

// Ethereum Mainnet USDC comet
const MAINNET_USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';

const makeResponse = (chainId: number, cometAddress: string) => ({
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
});

describe('sanitizeMarketSummary', () => {
  test('collects the symbols of collaterals in the error status', () => {
    const result = sanitizeMarketSummary(MOCK_MARKETS, {
      ...makeResponse(1, MAINNET_USDC_COMET),
      collaterals: [
        { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', status: 'error' },
        { address: '0xc00e94Cb662C3520282E6f5717214004A7f26888', symbol: 'COMP', status: 'success' },
      ],
    } as LatestMarketSummaryResponse);
    expect(result.errorCollateralSymbols).toEqual(['WBTC']);
  });

  test('drops deprecated collaterals and keeps only visible ones in the top list', () => {
    const result = sanitizeMarketSummary(MOCK_MARKETS, {
      ...makeResponse(1, MAINNET_USDC_COMET),
      collaterals: [
        { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', status: 'success', isVisible: true },
        { address: '0xc00e94Cb662C3520282E6f5717214004A7f26888', symbol: 'COMP', status: 'success', isVisible: false },
        { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', status: 'success', isDeprecated: true },
      ],
    } as LatestMarketSummaryResponse);
    expect(result.collateralAssetSymbols).toEqual(['WBTC', 'COMP']);
    expect(result.topCollateralAssetSymbols).toEqual(['WBTC']);
  });

  test('has no collaterals when the summary has no collaterals field', () => {
    const result = sanitizeMarketSummary(
      MOCK_MARKETS,
      makeResponse(1, MAINNET_USDC_COMET) as LatestMarketSummaryResponse
    );
    expect(result.collateralAssetSymbols).toEqual([]);
    expect(result.topCollateralAssetSymbols).toEqual([]);
    expect(result.errorCollateralSymbols).toEqual([]);
  });

  test('keeps a market in the error status, which comes without numbers', () => {
    const result = sanitizeMarketSummary(MOCK_MARKETS, {
      chainId: 1,
      comet: { address: MAINNET_USDC_COMET },
      status: 'error',
      timestamp: 0,
      date: '2026-06-22',
    } as LatestMarketSummaryResponse);
    expect(result.status).toBe('error');
    expect(result.utilization).toBe(0n);
    expect(result.totalSupplyValue).toBe(0n);
  });
});

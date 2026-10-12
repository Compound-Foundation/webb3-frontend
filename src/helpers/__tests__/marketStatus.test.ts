import {
  buildMarketStatusIndex,
  getCollateralStatus,
  getMarketStatus,
  getStatusCollateralAddress,
} from '@helpers/marketStatus';
import { ChainInformation, LatestMarketSummaryResponse } from '@types';

const COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';

const summary = (overrides: Partial<LatestMarketSummaryResponse>): LatestMarketSummaryResponse => ({
  chainId: 1,
  comet: { address: COMET.toLowerCase() },
  borrowApr: '0',
  supplyApr: '0',
  totalBorrowValue: '0',
  totalSupplyValue: '0',
  totalCollateralValue: '0',
  utilization: '0',
  timestamp: 0,
  date: '2026-10-12',
  baseUsdPrice: '1',
  collateralAssetSymbols: [],
  ...overrides,
});

describe('market status index', () => {
  const index = buildMarketStatusIndex([
    summary({
      status: 'partially',
      collaterals: [{ address: WBTC.toLowerCase(), symbol: 'WBTC', status: 'error' }],
    }),
  ]);

  test('looks up market and collateral statuses regardless of address case', () => {
    expect(getMarketStatus(index, 1, COMET)).toBe('partially');
    expect(getCollateralStatus(index, 1, COMET, WBTC)).toBe('error');
  });

  test('scopes statuses by chain and returns undefined for unknown entries', () => {
    expect(getMarketStatus(index, 8453, COMET)).toBeUndefined();
    expect(getCollateralStatus(index, 1, COMET, WSTETH)).toBeUndefined();
  });

  test('handles a summary without collaterals', () => {
    const noCollaterals = buildMarketStatusIndex([summary({ status: 'success' })]);
    expect(getCollateralStatus(noCollaterals, 1, COMET, WBTC)).toBeUndefined();
  });
});

describe('getStatusCollateralAddress', () => {
  const chainInformation = {
    unwrappedCollateralAssets: { [WSTETH]: { symbol: 'stETH', name: 'Lido Staked ETH', address: STETH } },
  } as unknown as ChainInformation;

  test('maps an unwrapped collateral to the wrapped asset the summary reports', () => {
    expect(getStatusCollateralAddress(chainInformation, '0xAE7AB96520DE3A18E5E111B5EAAB095312D7FE84')).toBe(WSTETH);
  });

  test('returns other addresses unchanged', () => {
    expect(getStatusCollateralAddress(chainInformation, WBTC)).toBe(WBTC);
  });
});


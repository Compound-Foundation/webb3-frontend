import { getStatusCollateralAddress } from '@helpers/marketStatus';
import { ChainInformation } from '@types';

const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';

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

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';

import RewardsStateContext from '@contexts/RewardsStateContext';
import { useMarketsOverviewState } from '@pages/markets/hooks/useMarketsOverviewState';
import { StateType } from '@types';

const Provider = ({ children }: { children: ReactNode }) => {
  const queryClient = new QueryClient();

  return (
    <QueryClientProvider client={queryClient}>
      <RewardsStateContext.Provider value={[StateType.Hydrated, []]}>{children}</RewardsStateContext.Provider>
    </QueryClientProvider>
  );
};

describe('useMarketsOverview', () => {
  test('should return loading state', () => {
    const { result } = renderHook(() => useMarketsOverviewState(), { wrapper: Provider });
    expect(result.current).toEqual([StateType.Loading]);
  });

  test('should return MarketOverviewState after fetch', async () => {
    const { result } = renderHook(() => useMarketsOverviewState(), { wrapper: Provider });

    await waitFor(() =>
      expect(result.current).toStrictEqual([
        StateType.Hydrated,
        {
          historicalMarketSummaries: [
            {
              date: '2023-08-09',
              totalBorrowValue: 46142508757714671n,
              totalCollateralValue: 84092317777681803n,
              totalSupplyValue: 53494701238885504n,
            },
            {
              date: '2023-08-10',
              totalBorrowValue: 45920367476727263n,
              totalCollateralValue: 83636164502250706n,
              totalSupplyValue: 53202488974282635n,
            },
            {
              date: '2023-08-11',
              totalBorrowValue: 46113471433560463n,
              totalCollateralValue: 83473573864058194n,
              totalSupplyValue: 52461218256697361n,
            },
            {
              date: '2023-08-12',
              totalBorrowValue: 46162103916511846n,
              totalCollateralValue: 83607595710406562n,
              totalSupplyValue: 50749805947890450n,
            },
            {
              date: '2023-08-13',
              totalBorrowValue: 45873610815284789n,
              totalCollateralValue: 83265542822881683n,
              totalSupplyValue: 51261712210601081n,
            },
            {
              date: '2023-08-14',
              totalBorrowValue: 45871933048693307n,
              totalCollateralValue: 82426344055107205n,
              totalSupplyValue: 51006647103217275n,
            },
            {
              date: '2023-08-15',
              totalBorrowValue: 45666079138828985n,
              totalCollateralValue: 83138528828840737n,
              totalSupplyValue: 51067949068477673n,
            },
            {
              date: '2023-08-16',
              totalBorrowValue: 45034909039155986n,
              totalCollateralValue: 81287219760746591n,
              totalSupplyValue: 50952978610106278n,
            },
            {
              date: '2023-08-17',
              totalBorrowValue: 44733840541451164n,
              totalCollateralValue: 79503397941103259n,
              totalSupplyValue: 50976748475968467n,
            },
            {
              date: '2023-08-18',
              totalBorrowValue: 40330272379771075n,
              totalCollateralValue: 69580273099377738n,
              totalSupplyValue: 50135016485463444n,
            },
            {
              date: '2023-08-19',
              totalBorrowValue: 35707902139851417n,
              totalCollateralValue: 63827221573409490n,
              totalSupplyValue: 44802186596176337n,
            },
            {
              date: '2023-08-20',
              totalBorrowValue: 31570650996000977n,
              totalCollateralValue: 58319996538988467n,
              totalSupplyValue: 40950021549964688n,
            },
            {
              date: '2023-08-21',
              totalBorrowValue: 31499240632438398n,
              totalCollateralValue: 58519166605902201n,
              totalSupplyValue: 40835644362197963n,
            },
            {
              date: '2023-08-22',
              totalBorrowValue: 32161549800701963n,
              totalCollateralValue: 59460335639007588n,
              totalSupplyValue: 39642234623776561n,
            },
            {
              date: '2023-08-23',
              totalBorrowValue: 31997522141624564n,
              totalCollateralValue: 57891057872768176n,
              totalSupplyValue: 39841625381724954n,
            },
            {
              date: '2023-08-24',
              totalBorrowValue: 32625419406771616n,
              totalCollateralValue: 59855937356225935n,
              totalSupplyValue: 40623276129200356n,
            },
            {
              date: '2023-08-25',
              totalBorrowValue: 32494501139272376n,
              totalCollateralValue: 59395406903192836n,
              totalSupplyValue: 42458162735447066n,
            },
            {
              date: '2023-08-26',
              totalBorrowValue: 32491555818641093n,
              totalCollateralValue: 59322768113141272n,
              totalSupplyValue: 42555799460334425n,
            },
            {
              date: '2023-08-27',
              totalBorrowValue: 32605438388358478n,
              totalCollateralValue: 59345036779299474n,
              totalSupplyValue: 42206466587925824n,
            },
            {
              date: '2023-08-28',
              totalBorrowValue: 32849845856429920n,
              totalCollateralValue: 59712861961275057n,
              totalSupplyValue: 42475131106761561n,
            },
            {
              date: '2023-08-29',
              totalBorrowValue: 32713321627381642n,
              totalCollateralValue: 59300524189251986n,
              totalSupplyValue: 42948834065754636n,
            },
            {
              date: '2023-08-30',
              totalBorrowValue: 33493203444224899n,
              totalCollateralValue: 63914683102743002n,
              totalSupplyValue: 43007884480737552n,
            },
            {
              date: '2023-08-31',
              totalBorrowValue: 33661649688162553n,
              totalCollateralValue: 63112574810376441n,
              totalSupplyValue: 42582702046502656n,
            },
            {
              date: '2023-09-01',
              totalBorrowValue: 34407827000906207n,
              totalCollateralValue: 62573826162736431n,
              totalSupplyValue: 42884528967565919n,
            },
            {
              date: '2023-09-02',
              totalBorrowValue: 34410028277687245n,
              totalCollateralValue: 62066061553309689n,
              totalSupplyValue: 42618428696696511n,
            },
            {
              date: '2023-09-03',
              totalBorrowValue: 34185126439798512n,
              totalCollateralValue: 62483428735364085n,
              totalSupplyValue: 42896741166832209n,
            },
            {
              date: '2023-09-04',
              totalBorrowValue: 33840405984716510n,
              totalCollateralValue: 62738762311274839n,
              totalSupplyValue: 42311069907398361n,
            },
            {
              date: '2023-09-05',
              totalBorrowValue: 34164523202578748n,
              totalCollateralValue: 62660168571889010n,
              totalSupplyValue: 42229577042783155n,
            },
            {
              date: '2023-09-06',
              totalBorrowValue: 34724470384471359n,
              totalCollateralValue: 63235469098047261n,
              totalSupplyValue: 42291276528930118n,
            },
            {
              date: '2023-09-07',
              totalBorrowValue: 35226956731242584n,
              totalCollateralValue: 64027911751051835n,
              totalSupplyValue: 42307299094050226n,
            },
          ],
          latestMarketSummaries: [
            {
              borrowAPR: 40201180873488000n,
              chainId: 1,
              comet: {
                address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
              },
              date: '2023-09-07',
              supplyAPR: 30836040536016000n,
              timestamp: 1694099375,
              totalBorrowValue: 28502368452920876n,
              totalCollateralValue: 53514681927004113n,
              totalSupplyValue: 31426863916176594n,
              utilization: 906942369819992364n,
              collateralAssetSymbols: ['COMP', 'WBTC', 'WETH', 'UNI', 'LINK'],
            },
            {
              borrowAPR: 33898024514016004n,
              chainId: 1,
              comet: {
                address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
              },
              date: '2023-09-07',
              supplyAPR: 18374010062832000n,
              timestamp: 1694099351,
              totalBorrowValue: 3852450502826696n,
              totalCollateralValue: 5071775730806631n,
              totalSupplyValue: 5950870954216523n,
              utilization: 647373375204769162n,
              collateralAssetSymbols: ['cbETH', 'wstETH'],
            },
            {
              borrowAPR: 41637919658256000n,
              chainId: 137,
              comet: {
                address: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
              },
              date: '2023-09-07',
              supplyAPR: 24735211142400000n,
              timestamp: 1694099375,
              totalBorrowValue: 1772672815086393n,
              totalCollateralValue: 3307331296344870n,
              totalSupplyValue: 2329143489247043n,
              utilization: 761083420635047735n,
              collateralAssetSymbols: ['WETH', 'WBTC', 'WMATIC', 'MaticX'],
            },
            {
              borrowAPR: 46244384597376000n,
              chainId: 42161,
              comet: {
                address: '0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA',
              },
              date: '2023-09-07',
              supplyAPR: 31191015428496000n,
              timestamp: 1694099377,
              totalBorrowValue: 328125763640274n,
              totalCollateralValue: 810090339504329n,
              totalSupplyValue: 403609749915354n,
              utilization: 812977538620675375n,
              collateralAssetSymbols: ['ARB', 'GMX', 'WETH', 'WBTC'],
            },
            {
              borrowAPR: 19339728476112000n,
              chainId: 42161,
              comet: {
                address: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
              },
              date: '2023-09-07',
              supplyAPR: 4029747879312000n,
              timestamp: 1694099357,
              totalBorrowValue: 39063581432039n,
              totalCollateralValue: 89935764341405n,
              totalSupplyValue: 315045023059815n,
              utilization: 123992243058846637n,
              collateralAssetSymbols: ['ARB', 'GMX', 'WETH', 'WBTC'],
            },
            {
              borrowAPR: 18165959344512000n,
              chainId: 8453,
              comet: {
                address: '0x46e6b214b524310239732D51387075E0e70970bf',
              },
              date: '2023-09-07',
              supplyAPR: 6306070443552000n,
              timestamp: 1694099345,
              totalBorrowValue: 141514294509716n,
              totalCollateralValue: 174554019184166n,
              totalSupplyValue: 636926202890887n,
              utilization: 222182424985284321n,
              collateralAssetSymbols: ['cbETH'],
            },
            {
              borrowAPR: 31609869295680000n,
              chainId: 8453,
              comet: {
                address: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
              },
              date: '2023-09-07',
              supplyAPR: 15423450057648000n,
              timestamp: 1694099357,
              totalBorrowValue: 590761320826590n,
              totalCollateralValue: 1059542673866321n,
              totalSupplyValue: 1244839758544010n,
              utilization: 474567695122316508n,
              collateralAssetSymbols: ['cbETH', 'WETH'],
            },
          ],
        },
      ])
    );
  });
});

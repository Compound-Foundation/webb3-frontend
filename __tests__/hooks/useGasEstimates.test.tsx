import { act, renderHook } from '@testing-library/react';

import { PreEstimatedAction } from '@helpers/gasEstimator';
import { getMarket } from '@helpers/markets';
import type { QueueSession } from '@hooks/useActionQueue';
import { GasEstimateScope, useGasEstimates } from '@hooks/useGasEstimates';
import { MarketData } from '@types';

import { MOCK_MARKETS } from '../mocks/mockMarkets';

const ACCOUNT = '0x0000000000000000000000000000000000000aa1';
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000bb2';
const SESSION: QueueSession = { account: ACCOUNT, connector: 'connector-uid-1', status: 'connected' };
const MAINNET_USDC = getMarket(MOCK_MARKETS, 1, '0xc3d688B66703497DAA19211EEdff47f25384cdc3') as MarketData;
const MAINNET_ETH = getMarket(MOCK_MARKETS, 1, '0xA17581A9E3356d9A858b789D68B4d866e593aE94') as MarketData;
const POLYGON_USDC = getMarket(MOCK_MARKETS, 137, '0xF25212E676D1F7F89Cd72fFEe66158f541246445') as MarketData;
const SCOPE: GasEstimateScope = { session: SESSION, walletChainId: 1, market: MAINNET_USDC };

const BORROW_KEY = ':borrow-USDC-1000000000';

/** A promise the test settles. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

function renderEstimates(scope: GasEstimateScope) {
  return renderHook(({ scope }: { scope: GasEstimateScope }) => useGasEstimates(scope), {
    initialProps: { scope },
  });
}

describe('useGasEstimates', () => {
  it("records an estimate made in the same scope, over the market chain's defaults", async () => {
    const { result } = renderEstimates(SCOPE);

    await act(async () => result.current.addEstimate(BORROW_KEY, Promise.resolve(123_000)));

    expect(result.current.estimatedGasMap.get(BORROW_KEY)).toBe(123_000);
    expect(result.current.estimatedGasMap.get(PreEstimatedAction.Approve)).toBe(72770);
  });

  it.each<[string, GasEstimateScope]>([
    ['wallet network', { ...SCOPE, walletChainId: 137 }],
    ['account', { ...SCOPE, session: { ...SESSION, account: OTHER_ACCOUNT } }],
    ['connector', { ...SCOPE, session: { ...SESSION, connector: 'connector-uid-2' } }],
    ['connection status (a reconnect)', { ...SCOPE, session: { ...SESSION, status: 'reconnecting' } }],
    ['market', { ...SCOPE, market: MAINNET_ETH }],
  ])(
    'drops an estimate in flight across a change of %s, and starts again from the defaults',
    async (_change, changed) => {
      const { result, rerender } = renderEstimates(SCOPE);
      await act(async () => result.current.addEstimate(':supply-COMP-1', Promise.resolve(90_000)));
      const estimate = deferred<number>();
      act(() => result.current.addEstimate(BORROW_KEY, estimate.promise));

      rerender({ scope: changed });
      expect(result.current.estimatedGasMap.has(':supply-COMP-1')).toBe(false);
      await act(async () => estimate.resolve(123_000));

      expect(result.current.estimatedGasMap.has(BORROW_KEY)).toBe(false);
      expect(result.current.estimatedGasMap.get(PreEstimatedAction.Approve)).toBe(72770);
    }
  );

  it('brings back nothing from an earlier visit to the same scope', async () => {
    const { result, rerender } = renderEstimates(SCOPE);
    await act(async () => result.current.addEstimate(':supply-COMP-1', Promise.resolve(90_000)));
    const estimate = deferred<number>();
    act(() => result.current.addEstimate(BORROW_KEY, estimate.promise));

    rerender({ scope: { ...SCOPE, walletChainId: 137 } });
    rerender({ scope: SCOPE });
    await act(async () => estimate.resolve(123_000));

    expect(result.current.estimatedGasMap.has(':supply-COMP-1')).toBe(false);
    expect(result.current.estimatedGasMap.has(BORROW_KEY)).toBe(false);
  });

  it("starts from the new market chain's defaults", () => {
    const { result, rerender } = renderEstimates(SCOPE);

    rerender({ scope: { ...SCOPE, walletChainId: 137, market: POLYGON_USDC } });

    expect(result.current.estimatedGasMap.get(PreEstimatedAction.Approve)).toBe(78950);
  });
});

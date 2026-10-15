import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';

import { latestMarketSummaryQueryOptions } from '@helpers/latestMarketSummary';
import { getLatestMarketSummaryEndpoint } from '@helpers/urls';
import { fetchMarketList, useMarketList } from '@hooks/useMarketList';

import { rest, server } from '../../handlers/server';
import { LEGACY_ADDRESSES } from '../mocks/legacyMarketAddresses';
import mockLatestMarketSummaryResponse from '../mocks/mockLatestMarketSummaryResponse.json';

const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });

const renderMarketList = (queryClient: QueryClient) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useMarketList(), { wrapper });
};

describe('fetchMarketList', () => {
  test('keeps only the identity and static fields of each market, as plain JSON', async () => {
    const list = await fetchMarketList(newQueryClient());
    expect(Object.keys(list[0]).sort()).toEqual(
      ['baseAssetName', 'chainId', 'comet', 'deploymentKey', 'displayName', 'isDefault', 'isInstitutional', 'slug'].sort()
    );
    expect(list.some((entry) => 'borrowApr' in entry || 'status' in entry)).toBe(false);
    expect(() => JSON.stringify(list)).not.toThrow();
  });

  test('rejects a summary without the market list fields', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    server.use(
      rest.get(getLatestMarketSummaryEndpoint(), (_req, res, ctx) =>
        res(ctx.json([{ chain_id: 1, comet: { address: LEGACY_ADDRESSES.mainnetUSDC.comet }, status: 'success' }]))
      )
    );
    await expect(fetchMarketList(newQueryClient())).rejects.toThrow();
    warn.mockRestore();
  });
});

describe('useMarketList', () => {
  test('builds the list from the loaded summary without requesting it again', async () => {
    let requests = 0;
    server.use(
      rest.get(getLatestMarketSummaryEndpoint(), (_req, res, ctx) => {
        requests += 1;
        return res(ctx.json(mockLatestMarketSummaryResponse));
      })
    );
    const queryClient = newQueryClient();
    await queryClient.fetchQuery(latestMarketSummaryQueryOptions);

    const { result } = renderMarketList(queryClient);

    await waitFor(() => expect(result.current.marketList).toBeDefined());
    expect(requests).toBe(1);
  });

  test('reports a failed load when the summary keeps failing and nothing is cached', async () => {
    server.use(rest.get(getLatestMarketSummaryEndpoint(), (_req, res, ctx) => res(ctx.status(500))));
    const queryClient = newQueryClient();
    const { result } = renderMarketList(queryClient);

    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    expect(result.current.marketList).toBeUndefined();
    // Stop the hook's endless retries so they don't outlive the test
    await queryClient.cancelQueries();
  });
});

// The fork suite's back-dated accrual, run without a fork. The root `yarn test` skips the fork suite's
// own directory, which needs anvil, so this test lives beside it and replaces the fork with mocks.
// Jest hoists the `jest.mock` calls above the imports.
import { WrappedMarket } from '@constants/wrappedMarkets';

import { read, readBigInt } from './wrappedLendingFork/fixtures';
import { anvil } from './wrappedLendingFork/fork';
import { backdateAccrual } from './wrappedLendingFork/injections';

jest.mock('./wrappedLendingFork/fork', () => ({
  forkProvider: () => ({}),
  anvil: { getStorageAt: jest.fn(), latestBlock: jest.fn(), setStorageAt: jest.fn() },
}));
jest.mock('./wrappedLendingFork/fixtures', () => ({
  read: jest.fn(),
  readBigInt: jest.fn(),
}));

const market = { cometAddress: '0x000000000000000000000000000000000000c0e7' } as WrappedMarket;
const LAST_ACCRUAL = 1_700_000_000n;
const OTHER_FIELDS = 123n;
const SLOT = (LAST_ACCRUAL << 208n) | OTHER_FIELDS;

function forkReads(supplyRate: bigint) {
  jest.mocked(anvil.getStorageAt).mockResolvedValue(SLOT);
  jest.mocked(anvil.latestBlock).mockResolvedValue({ timestamp: 1_800_000_000 } as never);
  jest.mocked(read).mockResolvedValue([{ lastAccrualTime: LAST_ACCRUAL, baseSupplyIndex: 10n ** 15n }] as never);
  jest
    .mocked(readBigInt)
    .mockImplementation(async (_address, _abi, method) => (method === 'getSupplyRate' ? supplyRate : 10n ** 17n));
}

beforeEach(() => jest.clearAllMocks());

test('writes nothing and returns undefined when the supply rate is zero', async () => {
  forkReads(0n);
  await expect(backdateAccrual(market)).resolves.toBeUndefined();
  expect(anvil.setStorageAt).not.toHaveBeenCalled();
});

test('moves the last accrual back far enough for the index to rise two units and 5% of one', async () => {
  forkReads(10n ** 10n);
  // (3.05e15 - 1e15) × 1e18 ÷ (1e15 × 1e10) + 1 seconds before the latest block.
  const elapsed = 205_000_001n;
  await expect(backdateAccrual(market)).resolves.toEqual({
    storedIndex: 10n ** 15n,
    supplyRate: 10n ** 10n,
    elapsedSeconds: elapsed,
    lastAccrual: 1_800_000_000n - elapsed,
  });
  expect(anvil.setStorageAt).toHaveBeenCalledWith(
    market.cometAddress,
    '0x1',
    ((1_800_000_000n - elapsed) << 208n) | OTHER_FIELDS
  );
});

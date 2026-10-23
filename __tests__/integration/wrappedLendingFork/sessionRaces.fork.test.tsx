import { act } from '@testing-library/react';

import { buildWrappedMarketRegistry, HARDCODED_WRAPPED_LENDING_SOURCE } from '@constants/wrappedMarkets';
import { WrappedBlockReason } from '@helpers/wrappedActions';

import { forkAccount, FORK_MARKETS, units } from './fixtures';
import { anvil, assertLocalFork } from './fork';
import { fundedAccount, nonceOf, onSnapshot, supplyDirectly } from './injections';
import { scenario } from './results';
import { renderWrappedApp, SessionSetup, WrappedApp } from './wrappedApp';

/** The committed registry, with both release controls closed. */
const COMMITTED_REGISTRY = buildWrappedMarketRegistry(HARDCODED_WRAPPED_LENDING_SOURCE);

describe.each(FORK_MARKETS)('$label', (forkMarket) => {
  const { market, symbol, label } = forkMarket;
  const account = forkAccount('session', forkMarket);
  const otherMarket = FORK_MARKETS.find((candidate) => candidate !== forkMarket);
  if (otherMarket === undefined) throw new Error('The fork suite needs a second market.');

  beforeAll(assertLocalFork);

  const render = (setup: Partial<SessionSetup> = {}) =>
    renderWrappedApp({ market, symbol, account, cometAddress: market.cometAddress, ...setup });

  /**
   * Expects that nothing was sent since `nonce` and `blockNumber`: no request to the app's wallet,
   * no transaction and no block. It waits first, so that a late continuation of a kept
   * confirmation has time to reach the wallet.
   */
  async function expectNothingSent(app: WrappedApp | undefined, nonce: number, blockNumber: number) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 3_000)));
    if (app !== undefined) expect(app.walletSends()).toBe(0);
    expect(await nonceOf(account)).toBe(nonce);
    expect((await anvil.latestBlock()).number).toBe(blockNumber);
  }

  scenario('session-races', label, (measured) =>
    onSnapshot(async () => {
      await fundedAccount(market, account, units(10_000));
      await supplyDirectly(market, account, units(1_000));
      const otherAccount = await fundedAccount(market, forkAccount('other session', forkMarket), units(1_000));
      const changes: [string, Partial<SessionSetup>][] = [
        ['account', { account: otherAccount }],
        ['chain', { chainId: 5 }],
        ['market', { cometAddress: otherMarket.market.cometAddress }],
        ['screening', { screeningStatus: 'blocked' }],
        ['connector', { connectorId: 'io.metamask' }],
        ['release controls', { registry: COMMITTED_REGISTRY }],
      ];
      for (const [name, change] of changes) {
        for (const type of ['supply', 'withdraw'] as const) {
          const app: WrappedApp = await render();
          try {
            const refusal =
              type === 'supply'
                ? await app.startSupply(units(100))
                : await app.startWithdraw({ kind: 'partial', cash: units(100) });
            expect(refusal).toBeUndefined();
            expect(app.state().phase).toBe('review');
            // A confirmation handler a dialog kept from the render that showed the review.
            const keptConfirm = app.result.current.action.confirm;
            const nonce = await nonceOf(account);
            const { number } = await anvil.latestBlock();

            await app.changeSession(change);
            const changed = app.state();
            measured[`${type} after ${name} change`] =
              changed.phase === 'discarded' ? `discarded (${changed.reason})` : changed.phase;
            expect(changed).toMatchObject({ phase: 'discarded', reason: 'identity-changed' });
            act(() => keptConfirm());

            // A return to the reviewed session does not bring the draft back.
            await app.changeSession({});
            expect(app.state().phase).toBe('discarded');
            act(() => keptConfirm());
            await expectNothingSent(app, nonce, number);
          } finally {
            app.unmount();
          }
        }
      }
    })
  );

  scenario('other-connectors-and-watch-only', label, (measured) =>
    onSnapshot(async () => {
      await fundedAccount(market, account, units(10_000));
      await supplyDirectly(market, account, units(1_000));
      const nonce = await nonceOf(account);
      const { number } = await anvil.latestBlock();
      const sessions: [string, Partial<SessionSetup>][] = [
        ['MetaMask', { connectorId: 'io.metamask' }],
        ['WalletConnect', { connectorId: 'walletConnect' }],
        ['Coinbase', { connectorId: 'coinbaseWalletSDK' }],
        ['generic injected', { connectorId: 'injected' }],
        ['watch-only', { isWatchOnly: true }],
      ];
      for (const [name, setup] of sessions) {
        const app = await render(setup);
        try {
          expect(app.result.current.session.route.kind).toBe('standard');
          let supplyRefusal: WrappedBlockReason | undefined;
          let withdrawRefusal: WrappedBlockReason | undefined;
          act(() => {
            supplyRefusal = app.result.current.write.supply(units(100));
            withdrawRefusal = app.result.current.write.withdraw({ kind: 'full' });
          });
          measured[
            name
          ] = `${app.result.current.session.route.kind} route, supply ${supplyRefusal}, withdraw ${withdrawRefusal}, position ${app.result.current.position.state.status}`;
          expect([supplyRefusal, withdrawRefusal]).toEqual(['not-wrapped', 'not-wrapped']);
          expect(app.result.current.position.state.status).toBe('not-applicable');
        } finally {
          app.unmount();
        }
      }

      // Anchorage on a wrapped market while screening has not allowed the account: no review starts.
      for (const screeningStatus of ['checking', 'blocked'] as const) {
        const app = await render({ screeningStatus });
        try {
          let refusal: WrappedBlockReason | undefined;
          act(() => {
            refusal = app.result.current.write.supply(units(100));
          });
          measured[`Anchorage, screening ${screeningStatus}`] = String(refusal);
          expect(refusal).toBe('screening');
        } finally {
          app.unmount();
        }
      }
      await expectNothingSent(undefined, nonce, number);
    })
  );
});

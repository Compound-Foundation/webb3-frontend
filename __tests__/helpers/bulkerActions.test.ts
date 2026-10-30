import { defaultAbiCoder, Interface } from '@ethersproject/abi';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ethers } from 'ethers';

import {
  ANCHORAGE_CONNECTOR_ID,
  HARDCODED_WRAPPED_LENDING_SOURCE,
  WRAPPED_MARKET_REGISTRY,
} from '@constants/wrappedMarkets';
import { lendsBaseDirectly } from '@helpers/actions';
import { getBulkerTrxData } from '@helpers/bulkerActions';
import { resolveLendingRoute, wrappedRouteKey, LendingSession } from '@helpers/lendingRoute';
import { getMarket } from '@helpers/markets';
import { MAX_UINT256 } from '@helpers/numbers';
import { WRAPPED_ACTION, WrappedActionDraft, wrappedActionIdentity } from '@helpers/wrappedActions';
import { Action, ActionType, BaseAssetWithAccountState, MarketDataLoaded, TokenWithAccountState } from '@types';

import { mockBaseAsset } from '../mocks/mockBaseAsset';
import { mockCompCollateralAsset, mockEthCollateralAsset } from '../mocks/mockCollateralAssets';

const SENDER = '0x0000000000000000000000000000000000000aa1';
const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const MARKET = getMarket(1, USDC_COMET) as unknown as MarketDataLoaded;
const WRAPPER_ADDRESSES = HARDCODED_WRAPPED_LENDING_SOURCE.markets.map((market) => market.wrapperAddress);

const BASE_ASSET = mockBaseAsset({ address: USDC, balance: -5_000_000n, walletBalance: 10_000_000n });
const COMP = mockCompCollateralAsset({ walletBalance: 10n ** 20n });
const ETH = mockEthCollateralAsset({ symbol: 'ETH', walletBalance: 10n ** 20n });

/** A base asset any read of which fails the test: optimization reads it, the boundary must not. */
const UNREADABLE_BASE_ASSET = new Proxy({} as BaseAssetWithAccountState, {
  get: (_target, property) => {
    throw new Error(`optimization read the base asset's ${String(property)}`);
  },
});

function wrappedDraft(): WrappedActionDraft {
  const session: LendingSession = {
    connector: { id: ANCHORAGE_CONNECTOR_ID, uid: 'uid-1' },
    status: 'connected',
    account: SENDER,
    chainId: 1,
    isWatchOnly: false,
    isSignerReady: true,
    screeningStatus: 'allowed',
  };
  const lookup = WRAPPED_MARKET_REGISTRY.lookup(1, USDC_COMET);
  if (lookup.status !== 'valid') throw new Error('the mapping must be valid');
  const route = resolveLendingRoute({
    market: { chainId: 1, cometAddress: USDC_COMET },
    session,
    conflictedRdns: new Set(),
    validation: { key: wrappedRouteKey(lookup.market, session), status: 'matched' },
  });
  const identity = wrappedActionIdentity('supply', {
    route,
    account: SENDER,
    chainId: 1,
    screeningStatus: 'allowed',
    provider: {},
  });
  if (identity === undefined) throw new Error('the identity must exist');
  const data = new Interface(['function supplyAndWrap(uint256)']).encodeFunctionData('supplyAndWrap', [1_000_000n]);
  return {
    kind: WRAPPED_ACTION,
    id: 'draft-1',
    identity,
    amount: 1_000_000n,
    steps: [
      {
        id: 'supply',
        kind: 'supply-and-wrap',
        description: 'Supply',
        request: { to: lookup.market.wrapperAddress, data },
      },
    ],
  };
}

/** An action whose asset is a wrapper's shares, which no queue may hold. */
function wrapperShareAction(type: ActionType, wrapperAddress: string): Action {
  const shares = { ...mockCompCollateralAsset(), address: wrapperAddress, symbol: 'wcUSDCv3', decimals: 18 };
  return [type, shares, 10n ** 18n] as unknown as Action;
}

const BORROW: Action = [ActionType.Borrow, BASE_ASSET, 1_000_000n];

const WRAPPER_ACTIONS: [string, unknown[]][] = [
  ['a wrapper draft', [wrappedDraft()]],
  ['a wrapper draft after a direct borrow', [BORROW, wrappedDraft()]],
  ['a wrapper draft before a direct borrow', [wrappedDraft(), BORROW]],
  ...WRAPPER_ADDRESSES.flatMap((wrapper): [string, unknown[]][] => [
    [`a supply of ${wrapper}'s shares`, [wrapperShareAction(ActionType.Supply, wrapper)]],
    [`a collateral supply of ${wrapper}'s shares`, [BORROW, wrapperShareAction(ActionType.SupplyCollateral, wrapper)]],
    [`a withdrawal of ${wrapper}'s shares`, [wrapperShareAction(ActionType.WithdrawCollateral, wrapper.toLowerCase())]],
  ]),
];

function walletProvider() {
  const provider = new JsonRpcProvider('http://127.0.0.1:8545', 1);
  jest.spyOn(provider, 'getSigner');
  return provider;
}

function decodeCallData(callData: string) {
  return defaultAbiCoder.decode(['address', 'address', 'address', 'uint'], callData).map(String);
}

describe('bulkerActions', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(WRAPPER_ACTIONS)('rejects every wrapper action before optimization or encoding: %s', (_name, actions) => {
    const provider = walletProvider();
    const encode = jest.spyOn(defaultAbiCoder, 'encode');
    const formatBytes32String = jest.spyOn(ethers.utils, 'formatBytes32String');

    expect(() => getBulkerTrxData(SENDER, provider, MARKET, UNREADABLE_BASE_ASSET, [], actions as Action[])).toThrow(
      expect.objectContaining({ name: 'WrappedExecutionError' })
    );
    expect(provider.getSigner).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
    expect(formatBytes32String).not.toHaveBeenCalled();
  });

  describe('with direct actions only', () => {
    it('encodes a collateral supply and a borrow', () => {
      const actions: Action[] = [
        [ActionType.SupplyCollateral, COMP, 10n ** 18n],
        [ActionType.Borrow, BASE_ASSET, 1_000_000n],
      ];

      const { bulker, bulkerActions, bulkerCallData, bulkerCallValue } = getBulkerTrxData(
        SENDER,
        walletProvider(),
        MARKET,
        BASE_ASSET,
        [COMP],
        actions
      );

      expect(bulker.address).toBe(MARKET.bulkerAddress);
      expect(bulkerActions.map((action) => ethers.utils.parseBytes32String(action))).toEqual([
        'ACTION_SUPPLY_ASSET',
        'ACTION_WITHDRAW_ASSET',
      ]);
      expect(bulkerCallData.map(decodeCallData)).toEqual([
        [USDC_COMET, SENDER, COMP.address, String(10n ** 18n)].map((value) =>
          expect.stringMatching(new RegExp(value, 'i'))
        ),
        [USDC_COMET, SENDER, USDC, '1000000'].map((value) => expect.stringMatching(new RegExp(value, 'i'))),
      ]);
      expect(bulkerCallValue).toBe(0n);
    });

    it('sends the native token as value for a native collateral supply', () => {
      const actions: Action[] = [[ActionType.SupplyCollateral, ETH as TokenWithAccountState, 2n * 10n ** 18n]];

      const { bulkerActions, bulkerCallValue } = getBulkerTrxData(
        SENDER,
        walletProvider(),
        MARKET,
        BASE_ASSET,
        [ETH],
        actions
      );

      expect(ethers.utils.parseBytes32String(bulkerActions[0])).toBe('ACTION_SUPPLY_NATIVE_TOKEN');
      expect(bulkerCallValue).toBe(2n * 10n ** 18n);
    });
  });

  describe('with a queue the wrapped route accepts', () => {
    // On the wrapped route a base supply goes to the wrapper, never the Bulker, so no supply follows the
    // repay to fold it into.
    it.each([
      ['a full repay', 'MAX_UINT256', MAX_UINT256],
      ['a typed repay equal to the debt', 'that fixed amount', -BASE_ASSET.balance],
    ])('encodes %s before a collateral withdrawal as a supply of %s', (_name, _encoded, amount) => {
      const actions: Action[] = [
        [ActionType.Repay, BASE_ASSET, amount],
        [ActionType.WithdrawCollateral, COMP, 10n ** 18n],
      ];
      expect(lendsBaseDirectly(BASE_ASSET, [COMP], actions)).toBe(false);

      const { bulkerActions, bulkerCallData } = getBulkerTrxData(
        SENDER,
        walletProvider(),
        MARKET,
        BASE_ASSET,
        [COMP],
        actions
      );

      // Comet repays the borrow balance at execution for MAX_UINT256, so a full repay leaves no
      // excess. A typed amount stays fixed even when it equals the debt.
      expect(bulkerActions.map((action) => ethers.utils.parseBytes32String(action))).toEqual([
        'ACTION_SUPPLY_ASSET',
        'ACTION_WITHDRAW_ASSET',
      ]);
      expect(bulkerCallData.map((callData) => decodeCallData(callData).map((value) => value.toLowerCase()))).toEqual([
        [MARKET.marketAddress, SENDER, BASE_ASSET.address, amount.toString()].map((value) => value.toLowerCase()),
        [MARKET.marketAddress, SENDER, COMP.address, String(10n ** 18n)].map((value) => value.toLowerCase()),
      ]);
    });
  });
});

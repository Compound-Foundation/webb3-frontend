import IconTextPair, { IconTextPairSize } from '@components/IconTextPair';
import PanelWithHeader from '@components/PanelWithHeader';
import { formatTokenBalance, getTokenValue, PRICE_PRECISION } from '@helpers/numbers';
import { StateType, BaseAssetWithState, Currency } from '@types';

type MarketStatsPanelLoading = [StateType.Loading];

type MarketStatsPanelHydrated = [
  StateType.Hydrated,
  {
    baseAsset: BaseAssetWithState;
    reserves: bigint;
    totalBorrow: bigint;
    totalSupply: bigint;
    currency: Currency;
  }
];

export type MarketStatsPanelState = MarketStatsPanelLoading | MarketStatsPanelHydrated;

type MarketStatsPanelContent = {
  baseAssetPrice: string;
  reserves: string;
  totalSupply: string;
  availableLiquidity: string;
  collateralization: string;
  baseAssetSymbol: string;
  currency?: Currency;
};

const defaultPanelContent = {
  baseAssetPrice: '',
  reserves: '',
  totalSupply: '',
  availableLiquidity: '',
  collateralization: '',
  baseAssetSymbol: '',
};

function getMarketStatsPanelContent(state: MarketStatsPanelState): MarketStatsPanelContent {
  const [panelState] = state;
  if (panelState === StateType.Loading) {
    return {
      ...defaultPanelContent,
    };
  } else {
    const { baseAsset, reserves, totalBorrow, totalSupply, currency } = state[1];

    const { price, symbol: baseAssetSymbol, baseAssetPriceInDollars } = baseAsset;
    const currencyToUse = currency;

    const reservesValue = getTokenValue(reserves, currency, baseAssetPriceInDollars, baseAssetSymbol);

    const totalSupplyValue = getTokenValue(totalSupply, currency, baseAssetPriceInDollars, baseAssetSymbol);

    const availableLiquidityValue = getTokenValue(
      totalSupply + reserves - totalBorrow,
      currency,
      baseAssetPriceInDollars,
      baseAssetSymbol
    );

    return {
      baseAssetPrice: formatTokenBalance(PRICE_PRECISION, baseAssetPriceInDollars, false, Currency.USD),
      reserves: formatTokenBalance(baseAsset.decimals, reservesValue, true, currencyToUse),
      totalSupply: formatTokenBalance(baseAsset.decimals, totalSupplyValue, true, currencyToUse),
      collateralization: ((Number(totalSupply * price) * 100) / Number(totalBorrow * price)).toFixed(2) + '%',
      availableLiquidity: formatTokenBalance(baseAsset.decimals, availableLiquidityValue, true, currencyToUse),
      currency,
      baseAssetSymbol,
    };
  }
}

type MarketStatsPanelItemProps = {
  label: string;
  value: string;
  asset?: string;
  currency?: Currency;
};

const MarketStatsPanelItem = ({ asset, label, value, currency }: MarketStatsPanelItemProps) => {
  return (
    <div className="market-overview__stats__item">
      <label className="label text-color--2">{label}</label>
      {value === '' ? (
        <h3 className="L3 placeholder-content" style={{ width: '5rem' }}></h3>
      ) : (
        <IconTextPair value={value} assetSymbol={asset} currency={currency} size={IconTextPairSize.Medium} />
      )}
    </div>
  );
};

type MarketStatsPanelProps = {
  state: MarketStatsPanelState;
};

const MarketStatsPanel = ({ state }: MarketStatsPanelProps) => {
  const { totalSupply, availableLiquidity, reserves, collateralization, baseAssetPrice, currency, baseAssetSymbol } =
    getMarketStatsPanelContent(state);
  const header = 'Market Stats';

  return (
    <PanelWithHeader header={header} className="grid-column--12">
      <div className="market-stats L2">
        <div className="market-stats__stats">
          <MarketStatsPanelItem
            asset={baseAssetSymbol}
            label={'Total Earning'}
            value={totalSupply}
            currency={currency}
          />
          <MarketStatsPanelItem
            asset={baseAssetSymbol}
            label={'Available Liquidity'}
            value={availableLiquidity}
            currency={currency}
          />
          <MarketStatsPanelItem asset={baseAssetSymbol} label={'Total Reserves'} value={reserves} currency={currency} />
          <MarketStatsPanelItem label={'Collateralization'} value={collateralization} currency={currency} />
        </div>
        <div className="market-stats__oracle-price">
          <MarketStatsPanelItem label={'Oracle Price'} value={baseAssetPrice} currency={currency} />
        </div>
      </div>
    </PanelWithHeader>
  );
};

export default MarketStatsPanel;

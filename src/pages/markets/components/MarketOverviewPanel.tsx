import { useCurrencyContext } from '@contexts/CurrencyContext';
import { assetIconForAssetSymbol } from '@helpers/assets';
import { formatTokenBalance, formatRateFactor, PRICE_PRECISION, getRiskLevelAndPercentage } from '@helpers/numbers';
import { Token, StateType, BaseAssetWithState, Currency } from '@types';

import InterestRateModel, { InterestRateModelState } from './InterestRateModel';

type MarketOverviewPanelLoading = [StateType.Loading, undefined | { baseAsset: Token }];

type MarketOverviewPanelHydrated = [
  StateType.Hydrated,
  {
    baseAsset: BaseAssetWithState;
    borrowCap: string;
    borrowAPR: bigint;
    borrowRates: [bigint, number][];
    borrowRewardsAPR?: bigint;
    collateralFactor: bigint;
    earnAPR: bigint;
    earnRewardsAPR?: bigint;
    reserveFactor: bigint;
    reserves: bigint;
    rewardsAsset?: Token;
    supplyRates: [bigint, number][];
    targetReserves: bigint;
    totalBorrow: bigint;
    totalSupply: bigint;
    utilization: bigint;
  }
];

export type MarketOverviewPanelState = MarketOverviewPanelLoading | MarketOverviewPanelHydrated;

type PanelContent = {
  baseAsset: Pick<Token, 'name' | 'symbol'>;
  baseAssetPrice: string;
  borrowAPR: string;
  borrowCap: string;
  borrowRewardsAPR: string;
  collateralFactor: string;
  earnAPR: string;
  earnRewardsAPR: string;
  interestRateModel: InterestRateModelState;
  reserveFactor: string;
  reserves: string;
  reservesPercentage?: string;
  rewardsAsset?: string;
  totalBorrow: string;
  totalSupply: string;
  withHeader?: boolean;
};

const defaultPanelContent = {
  baseAssetPrice: '',
  borrowAPR: '',
  borrowCap: '',
  borrowRewardsAPR: '',
  collateralFactor: '',
  earnAPR: '',
  earnRewardsAPR: '',
  reserves: '',
  reserveFactor: '',
  reservesPercentage: '0',
  totalBorrow: '',
  totalSupply: '',
};

function getGraphConfig() {
  return {
    height: 178,
    width: 400,
    graphMinX: 6,
    graphMaxX: 394,
    graphMinY: 60,
    graphMaxY: 172,
    isV2Graph: true,
  };
}

function getMarketOverviewPanelContent(state: MarketOverviewPanelState): PanelContent {
  const [panelState, panelProps] = state;
  if (panelState === StateType.Loading) {
    const baseAsset =
      panelProps === undefined ? { address: '', decimals: 0, name: '', symbol: '' } : panelProps.baseAsset;

    return {
      ...defaultPanelContent,
      baseAsset,
      interestRateModel: [
        StateType.Loading,
        {
          graphConfig: getGraphConfig(),
        },
      ],
    };
  } else {
    const {
      baseAsset,
      borrowAPR,
      borrowCap,
      borrowRewardsAPR,
      collateralFactor,
      earnAPR,
      earnRewardsAPR,
      reserveFactor,
      reserves,
      rewardsAsset,
      targetReserves,
      totalBorrow,
      totalSupply,
      utilization,
      borrowRates,
      supplyRates,
    } = state[1];
    const [, , reservesPercentage] = getRiskLevelAndPercentage(reserves, targetReserves);
    const { price, baseAssetPriceInDollars } = baseAsset;
    const { currency } = useCurrencyContext();
    // we dont toggle currency in market page for now
    return {
      baseAsset,
      // oracle price always use $
      baseAssetPrice: formatTokenBalance(PRICE_PRECISION, baseAssetPriceInDollars, false, Currency.USD),
      borrowAPR: formatRateFactor(borrowAPR),
      borrowCap: borrowCap,
      borrowRewardsAPR: formatRateFactor(borrowRewardsAPR ?? 0n),
      collateralFactor: formatRateFactor(collateralFactor ?? 0n),
      earnAPR: formatRateFactor(earnAPR),
      earnRewardsAPR: formatRateFactor(earnRewardsAPR ?? 0n),
      interestRateModel: [
        StateType.Hydrated,
        {
          borrowRates,
          supplyRates,
          borrowAPR,
          supplyAPR: earnAPR,
          utilization,
          graphConfig: getGraphConfig(),
        },
      ],
      reserves: formatTokenBalance(PRICE_PRECISION + baseAsset.decimals, reserves * price, true, currency),
      reserveFactor: formatRateFactor(reserveFactor ?? 0n),
      reservesPercentage,
      rewardsAsset: rewardsAsset === undefined ? undefined : rewardsAsset.symbol,
      totalBorrow: formatTokenBalance(PRICE_PRECISION + baseAsset.decimals, totalBorrow * price, true, currency),
      totalSupply: formatTokenBalance(PRICE_PRECISION + baseAsset.decimals, totalSupply * price, true, currency),
    };
  }
}

type MarketOverviewPanelProps = {
  state: MarketOverviewPanelState;
};

type MarketOverviewPanelItemProps = {
  asset?: string;
  label: string;
  value: string;
};

const MarketOverviewPanelItem = ({ asset, label, value }: MarketOverviewPanelItemProps) => {
  return (
    <div className="market-overview__stats__item">
      <label className="label text-color--2">{label}</label>
      {value === '' ? (
        <h4 className="placeholder-content" style={{ width: '5rem' }}></h4>
      ) : (
        <>
          {asset !== undefined ? (
            <div style={{ alignItems: 'center', display: 'flex' }}>
              <div className={`asset asset--${assetIconForAssetSymbol(asset)}`}></div>
              <h4 className="heading heading--emphasized L4">{value}</h4>
            </div>
          ) : (
            <h4 className="heading heading--emphasized L4">{value}</h4>
          )}
        </>
      )}
    </div>
  );
};

const MarketOverviewPanel = ({ state }: MarketOverviewPanelProps) => {
  const panelContent = getMarketOverviewPanelContent(state);

  return <MarketOverviewPanelView {...panelContent} />;
};

export const MarketOverviewPanelView = ({
  baseAsset,
  baseAssetPrice,
  borrowAPR,
  borrowCap,
  borrowRewardsAPR,
  collateralFactor,
  earnAPR,
  earnRewardsAPR,
  interestRateModel,
  reserveFactor,
  reserves,
  rewardsAsset,
  totalBorrow,
  totalSupply,
  withHeader = false,
}: PanelContent) => {
  const zeroIsNotALimit = borrowCap == '$0.00' ? 'No Limit' : borrowCap;
  const stats = (
    <div className="market-overview__stats">
      <MarketOverviewPanelItem label={'Total Earning'} value={totalSupply} />
      <MarketOverviewPanelItem asset={baseAsset.symbol} label={'Earn APR'} value={earnAPR} />
      <MarketOverviewPanelItem asset={rewardsAsset} label={'Earn Distribution'} value={earnRewardsAPR} />
      <MarketOverviewPanelItem label={'Reserves'} value={reserves} />
      <MarketOverviewPanelItem label={'Total Borrowing'} value={totalBorrow} />
      <MarketOverviewPanelItem asset={baseAsset.symbol} label={'Borrow APR'} value={borrowAPR} />
      <MarketOverviewPanelItem asset={rewardsAsset} label={'Borrow Distribution'} value={borrowRewardsAPR} />
      <MarketOverviewPanelItem label={'Borrow Cap'} value={zeroIsNotALimit} />
      <MarketOverviewPanelItem label={'Collateral Factor'} value={collateralFactor} />
      <MarketOverviewPanelItem label={'Reserve Factor'} value={reserveFactor} />
      <MarketOverviewPanelItem label={'Oracle Price'} value={baseAssetPrice} />
    </div>
  );

  return (
    <div className="panel panel--markets-overview L2 grid-column--12">
      {withHeader && (
        <div className="panel__header-row">
          <div className={`asset asset--${assetIconForAssetSymbol(baseAsset.symbol)}`}></div>
          <h3 className="heading heading--emphasized L3"> {baseAsset.name}</h3>
        </div>
      )}
      <div className="market-overview">
        {stats}
        <div className="market-overview__chart">
          <InterestRateModel state={interestRateModel} />
        </div>
      </div>
    </div>
  );
};

export default MarketOverviewPanel;

import { formatUnits } from '@helpers/numbers';
import { getV2MarketsUrl } from '@helpers/urls';
import { CToken, StateType, MarketState, CTokenWithMarketState, Currency } from '@types';

const CDAI_ADDRESS = '0x5d3a536e4d6dbd6114cc1ead35777bab948e3643';
const CSAI_ADDRESS = '0xf5dce57282a584d2746faf1593d3121fcac444dc';
const DAI_ADDRESS = '0x6b175474e89094c44da98b954eedeac495271d0f';
const SAI_ADDRESS = '0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359';

type InterestRateFormula = {
  rateBase: number;
  rateSlopeHigh?: number;
  rateSlopeKink?: number;
  rateSlopeLow: number;
  reserveFactor: number;
};

export const getV2State = async (): Promise<MarketState> => {
  const V2_API = getV2MarketsUrl();
  const response = await fetch(V2_API);
  const data = await response.json();

  const maybeUSDC: CToken[] = data.cToken.filter((token: CToken) => token.underlying_symbol === 'USDC');

  if (maybeUSDC.length > 0) {
    const cTokens: CTokenWithMarketState[] = data.cToken.map((cToken: CToken): CTokenWithMarketState => {
      const {
        borrow_rate,
        borrow_cap,
        collateral_factor,
        comp_borrow_apy,
        comp_supply_apy,
        exchange_rate,
        reserve_factor,
        reserves,
        supply_rate,
        total_borrows,
        total_supply,
        underlying_price,
      } = cToken;

      const [name, symbol] = nameAndSymbolForCToken(cToken);
      const borrowAPR = getDisplayRate(getAPRFromAPY(Number(borrow_rate)));
      const borrowRewardsAPR = getDisplayRate(getAPRFromAPY(Number(comp_borrow_apy) / 100));
      const collateralFactor = getDisplayRate(Number(collateral_factor));
      const reserveFactor = getDisplayRate(Number(reserve_factor));
      const supplyAPR = getDisplayRate(getAPRFromAPY(Number(supply_rate)));
      const supplyRewardsAPR = getDisplayRate(getAPRFromAPY(Number(comp_supply_apy) / 100));
      const unformatted_price = Number(underlying_price);
      const price = formatUnits(unformatted_price, Currency.USD);

      const formattedReserves = formatUnits(Number(reserves) * unformatted_price, Currency.USD);
      const unformattedBorrowCap = Number(borrow_cap) * unformatted_price;
      const unformattedTotalBorrow = Number(total_borrows) * unformatted_price;
      const unformattedTotalSupply = Number(total_supply) * Number(exchange_rate) * unformatted_price;
      const borrowCap = formatUnits(unformattedBorrowCap, Currency.USD);
      const totalBorrow = formatUnits(unformattedTotalBorrow, Currency.USD);
      const totalSupply = formatUnits(unformattedTotalSupply, Currency.USD);

      const interestRateModel = getFormula(cToken.symbol === 'cWBTC2' ? 'WBTC2' : symbol);

      const utilizationIntervals = [...Array(101).keys()].map((n) => n / 100);

      const rates: [bigint, number, number][] = utilizationIntervals.map((u) => {
        const [borrowAPY, supplyAPY] = getRatesForUtilization(interestRateModel, u);
        return [BigInt(Math.round(u * 1e18)), borrowAPY, supplyAPY];
      });

      const borrowRates: [bigint, number][] = rates.map(([utilization, borrowAPY]) => [utilization, borrowAPY]);
      const supplyRates: [bigint, number][] = rates.map(([utilization, , supplyAPY]) => [utilization, supplyAPY]);
      const utilization = BigInt(Math.round((unformattedTotalBorrow / unformattedTotalSupply) * 1e18));

      return {
        borrowAPR,
        borrowCap,
        borrowRewardsAPR,
        borrowRates,
        collateralFactor,
        name,
        price,
        reserveFactor,
        supplyAPR,
        supplyRewardsAPR,
        supplyRates,
        symbol,
        totalBorrow,
        totalSupply,
        unformattedTotalBorrow,
        unformattedTotalSupply,
        utilization,
        reserves: formattedReserves,
      };
    });

    const totalBorrow = cTokens.reduce((accum: number, cToken: CTokenWithMarketState) => {
      return accum + cToken.unformattedTotalBorrow;
    }, 0);
    const totalSupply = cTokens.reduce((accum: number, cToken: CTokenWithMarketState) => {
      return accum + cToken.unformattedTotalSupply;
    }, 0);

    return [
      StateType.Hydrated,
      {
        cTokens,
        totalBorrow: formatUnits(totalBorrow, Currency.USD),
        totalSupply: formatUnits(totalSupply, Currency.USD),
        marketHistory: [],
        type: 'V2ProtocolState',
      },
    ];
  }

  return [StateType.Loading];
};

function nameAndSymbolForCToken(cToken: CToken): [string, string] {
  if (cToken.token_address === CDAI_ADDRESS && cToken.underlying_address === DAI_ADDRESS) {
    return ['Dai', cToken.underlying_symbol];
  } else if (cToken.token_address === CSAI_ADDRESS && cToken.underlying_address === SAI_ADDRESS) {
    return ['Sai (Deprecated)', 'SAI'];
  } else if (cToken.underlying_symbol === 'USDT' && cToken.underlying_name === 'USDT') {
    return ['Tether', cToken.underlying_symbol];
  } else if (cToken.underlying_symbol === 'REP' && cToken.underlying_name === 'Augur') {
    return ['Augur v1 (Deprecated)', cToken.underlying_symbol];
  } else if (cToken.symbol === 'cFEI') {
    return ['Fei USD (Deprecated)', cToken.underlying_symbol];
  } else if (cToken.symbol === 'cWBTC') {
    return ['Wrapped BTC (Deprecated)', cToken.underlying_symbol];
  }

  return [cToken.underlying_name, cToken.underlying_symbol];
}

function getFormula(symbol: string): InterestRateFormula {
  switch (symbol) {
    case 'USDC':
      return {
        rateBase: 0.0,
        rateSlopeLow: 0.062499999997836,
        rateSlopeHigh: 1.362499999998552,
        rateSlopeKink: 0.8,
        reserveFactor: 0.075,
      };
    case 'DAI':
      return {
        rateBase: 0.0,
        rateSlopeLow: 0.062499999997836,
        rateSlopeHigh: 1.362499999998552,
        rateSlopeKink: 0.8,
        reserveFactor: 0.15,
      };
    case 'USDT':
      return {
        rateBase: 0.0,
        rateSlopeLow: 0.062499999997836,
        rateSlopeHigh: 1.362499999998552,
        rateSlopeKink: 0.8,
        reserveFactor: 0.075,
      };
    case 'BAT':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.3,
        reserveFactor: 0.25,
      };
    case 'ETH':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.224999999999568,
        // eslint-disable-next-line @typescript-eslint/no-loss-of-precision
        rateSlopeHigh: 48.999999999998484,
        rateSlopeKink: 0.8,
        reserveFactor: 0.2,
      };
    case 'SAI':
      return {
        rateBase: 0.05,
        rateSlopeLow: 0.12,
        reserveFactor: 1.0,
      };
    case 'REP':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.3,
        reserveFactor: 1.0,
      };
    case 'ZRX':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.3,
        reserveFactor: 0.25,
      };
    case 'WBTC':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.3,
        reserveFactor: 1.0,
      };
    case 'WBTC2':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.28124999999946,
        rateSlopeHigh: 1.249999999998768,
        rateSlopeKink: 0.8,
        reserveFactor: 0.075,
      };
    case 'UNI':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.28124999999946,
        rateSlopeHigh: 4.9999999999977,
        rateSlopeKink: 0.8,
        reserveFactor: 0.25,
      };
    case 'COMP':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.437499999997992,
        rateSlopeHigh: 7.499999999997864,
        rateSlopeKink: 0.8,
        reserveFactor: 0.25,
      };
    case 'TUSD':
      return {
        rateBase: 0.0,
        rateSlopeLow: 0.062499999997836,
        rateSlopeHigh: 1.362499999998552,
        rateSlopeKink: 0.8,
        reserveFactor: 0.075,
      };
    case 'LINK':
      return {
        rateBase: 0.0,
        rateSlopeLow: 0.28124999999946,
        rateSlopeHigh: 4.9999999999977,
        rateSlopeKink: 0.8,
        reserveFactor: 0.25,
      };
    case 'MKR':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.28124999999946,
        rateSlopeHigh: 4.9999999999977,
        rateSlopeKink: 0.8,
        reserveFactor: 0.25,
      };
    case 'AAVE':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.28124999999946,
        rateSlopeHigh: 4.9999999999977,
        rateSlopeKink: 0.8,
        reserveFactor: 0.25,
      };
    case 'SUSHI':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.28124999999946,
        rateSlopeHigh: 4.9999999999977,
        rateSlopeKink: 0.8,
        reserveFactor: 0.25,
      };
    case 'YFI':
      return {
        rateBase: 0.02,
        rateSlopeLow: 0.28124999999946,
        rateSlopeHigh: 4.9999999999977,
        rateSlopeKink: 0.8,
        reserveFactor: 0.25,
      };
    case 'USDP':
      return {
        rateBase: 0.0,
        rateSlopeLow: 0.062499999997836,
        rateSlopeHigh: 1.362499999998552,
        rateSlopeKink: 0.8,
        reserveFactor: 0.25,
      };
    case 'FEI':
      return {
        rateBase: 0.0,
        rateSlopeLow: 0.062499999997836,
        rateSlopeHigh: 1.362499999998552,
        rateSlopeKink: 0.8,
        reserveFactor: 0.25,
      };
    default:
      return {
        rateBase: 0.0,
        rateSlopeLow: 0.0,
        reserveFactor: 0.0,
      };
  }
}

// Returns a tuple of [borrowAPR, supplyAPR]
function getRatesForUtilization(rateModel: InterestRateFormula, utilization: number): [number, number] {
  let borrowAPR: number;
  let supplyAPR: number;

  if (rateModel.rateSlopeHigh !== undefined && rateModel.rateSlopeKink !== undefined) {
    // JumpRateModel
    if (utilization < rateModel.rateSlopeKink) {
      borrowAPR = rateModel.rateBase + rateModel.rateSlopeLow * utilization;
      const rateToPool = borrowAPR * (1 - rateModel.reserveFactor);
      supplyAPR = utilization * rateToPool;
    } else {
      const normalRate = rateModel.rateSlopeKink * rateModel.rateSlopeLow + rateModel.rateBase;
      const excessUtil = utilization - rateModel.rateSlopeKink;
      borrowAPR = excessUtil * rateModel.rateSlopeHigh + normalRate;
      const rateToPool = borrowAPR * (1 - rateModel.reserveFactor);
      supplyAPR = utilization * rateToPool;
    }
  } else {
    // RegularRateModel
    borrowAPR = rateModel.rateBase + rateModel.rateSlopeLow * utilization;
    const rateToPool = borrowAPR * (1 - rateModel.reserveFactor);
    supplyAPR = utilization * rateToPool;
  }

  return [borrowAPR * 100, supplyAPR * 100];
}

function getDisplayRate(rate: number): string {
  return `${(rate * 100).toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}%`;
}

function getAPRFromAPY(rate: number): number {
  const BLOCKS_PER_DAY = 7200; //12(s)
  const BLOCKS_PER_YEAR = BLOCKS_PER_DAY * 365;
  const blockRate = (rate + 1) ** (1 / BLOCKS_PER_YEAR) - 1;

  return blockRate * BLOCKS_PER_YEAR;
}

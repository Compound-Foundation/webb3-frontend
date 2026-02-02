import { Context, createContext, Dispatch, ReactNode, SetStateAction, useContext, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { MARKET_LOCAL_STORAGE_KEY, PREFERRED_CURRENCY_KEY } from '@helpers/constants';
import { getMarkets, DEFAULT_MARKET } from '@helpers/markets';
import { parseMarketKeyOrDefault } from '@hooks/useSelectedMarket';
import { Currency, MarketData } from '@types';

type CurrencyManagerContext = {
  currency: Currency;
  pressDownAnimate: boolean;
  setPressDownAnimate: Dispatch<SetStateAction<boolean>>;
  pressUpAnimate: boolean;
  setPressUpAnimate: Dispatch<SetStateAction<boolean>>;
  toggleCurrency: (currency: Currency) => void;
  counterCurrency: Currency;
  updateShowCurrencyToggle: (showCurrencyToggle: boolean) => void;
  showCurrencyToggle: boolean;
};

const initialCurrencyManagerContext = {
  currency: Currency.USD,
  pressDownAnimate: false,
  setPressDownAnimate: () => undefined,
  pressUpAnimate: false,
  setPressUpAnimate: () => undefined,
  toggleCurrency: () => undefined,
  counterCurrency: Currency.USDC,
  baseAssetPriceInDollar: 0n,
  updateShowCurrencyToggle: () => undefined,
  showCurrencyToggle: false,
};

let CurrencyContext: Context<Currency>;

export function initializeContext(selectedCurrency: Currency) {
  if (CurrencyContext === undefined) {
    CurrencyContext = createContext<Currency>(selectedCurrency);
  }
}

export const CurrencyManagerContext = createContext<CurrencyManagerContext>(initialCurrencyManagerContext);

export const useCurrencyContext = () => useContext(CurrencyManagerContext);

const loadPreferredCurrency = (market: MarketData): Currency | undefined => {
  const savedCurrencyString = window.localStorage.getItem(PREFERRED_CURRENCY_KEY);

  let foundSavedCurrency = undefined;
  switch (savedCurrencyString) {
    case Currency.ETH:
      // If user last saved ETH as pref currency but loads a USDC market
      // then we need to try updating the currency to the base (USDC)
      if (market.baseAsset.symbol !== savedCurrencyString) {
        foundSavedCurrency = market.baseAsset.symbol as Currency;
        window.localStorage.setItem(PREFERRED_CURRENCY_KEY, market.baseAsset.symbol);
      } else {
        foundSavedCurrency = Currency.ETH;
      }
      break;
    case Currency.USD:
      foundSavedCurrency = Currency.USD;
      break;
    case Currency.USDC:
      // If user last saved USDC as pref currency but loads a ETH market
      // then we need to try updating the currency to the base (ETH)
      if (market.baseAsset.symbol !== savedCurrencyString) {
        foundSavedCurrency = market.baseAsset.symbol as Currency;
        window.localStorage.setItem(PREFERRED_CURRENCY_KEY, market.baseAsset.symbol);
      } else {
        foundSavedCurrency = Currency.USDC;
      }
      break;
  }

  return foundSavedCurrency ? foundSavedCurrency : (market.baseAsset.symbol as Currency);
};

const getCounterCurrency = (currency: Currency, baseAssetSymbol: string) => {
  if (currency === baseAssetSymbol) {
    return Currency.USD;
  } else {
    return baseAssetSymbol as Currency;
  }
};

export const CurrencyContextProvider = ({ children }: { children: ReactNode | ReactNode[] }) => {
  const [searchParams] = useSearchParams();
  const [pressDownAnimate, setPressDownAnimate] = useState(false);
  const [pressUpAnimate, setPressUpAnimate] = useState(false);
  const [showCurrencyToggle, updateShowCurrencyToggle] = useState(false);
  const getPreferredCurrency = () => {
    const market = getMarketData();
    return loadPreferredCurrency(market);
  };

  const getMarketData = () => {
    const marketKey = searchParams.get('market') ?? window.localStorage.getItem(MARKET_LOCAL_STORAGE_KEY);
    return parseMarketKeyOrDefault(getMarkets(true), DEFAULT_MARKET, marketKey);
  };

  const baseAssetSymbol = getMarketData().baseAsset.symbol;
  const preferredCurrency = getPreferredCurrency() as Currency;

  const [currency, setCurrency] = useState<Currency>(preferredCurrency);
  if (currency != preferredCurrency) {
    //TODO: We really really need to refactor all this logic to only have 2 currencies, Fiat and Crypto
    //      Trying to support these 3 is SUPER awkard and this case is handling the react state
    //      being updated to some value (ETH) and then switching a market and us loading the correct
    //      preferredCurrency (USDC), but the last value set in useState was ETH, so this handles that weird
    //      mismatch...
    setCurrency(preferredCurrency);
  }

  const [counterCurrency, setCounterCurrency] = useState<Currency>(getCounterCurrency(currency, baseAssetSymbol));

  // toggle between baseAsset and $, within the same market
  const toggleCurrency = (currency: Currency): void => {
    // toggle between base asset  and usd
    if (currency === baseAssetSymbol) {
      setCurrency(Currency.USD);
      setCounterCurrency(baseAssetSymbol);
      window.localStorage.setItem(PREFERRED_CURRENCY_KEY, Currency.USD);
    } else {
      setCurrency(baseAssetSymbol as Currency);
      setCounterCurrency(Currency.USD);
      window.localStorage.setItem(PREFERRED_CURRENCY_KEY, baseAssetSymbol as Currency);
    }
  };

  return (
    <CurrencyManagerContext.Provider
      value={{
        currency,
        toggleCurrency,
        counterCurrency,
        pressDownAnimate,
        setPressDownAnimate,
        pressUpAnimate,
        setPressUpAnimate,
        updateShowCurrencyToggle,
        showCurrencyToggle,
      }}
    >
      {children}
    </CurrencyManagerContext.Provider>
  );
};

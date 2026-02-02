import { Context, createContext } from 'react';

import { SelectedMarketData } from '@types';

let MarketContext: Context<SelectedMarketData>;

export function initializeContext(selectedMarketData: SelectedMarketData) {
  if (MarketContext === undefined) {
    MarketContext = createContext<SelectedMarketData>(selectedMarketData);
  }
}

export function getSelectedMarketContext(): Context<SelectedMarketData> {
  if (MarketContext === undefined) {
    throw 'Must initialize context!';
  }

  return MarketContext;
}

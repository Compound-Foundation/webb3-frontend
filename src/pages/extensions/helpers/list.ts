import { marketKey } from '@helpers/markets';
import { MarketData, MarketDataLoaded } from '@types';

import { AllMarkets, Extension, extensions } from './core';

function extraExtensions(): Extension[] {
  if (import.meta.env.VITE_EXTRA_EXTENSIONS) {
    return import.meta.env.VITE_EXTRA_EXTENSIONS.split(',').map((ext: string) => {
      return {
        id: ext,
        description: 'blank',
        developer: 'blank',
        name: ext,
        links: {
          github: 'www.example.com',
          website: 'www.example.com',
        },
        permissions: {
          sudo: true,
        },
        source: {
          url: 'about:blank',
        },
        supportedMarkets: {
          '1_USDC_0xc3d688B66703497DAA19211EEdff47f25384cdc3': null,
        },
      } as Extension;
    });
  } else {
    return [];
  }
}
export const allExtensions: Extension[] = extensions.concat(extraExtensions());

export function getOperator(extension: Extension, marketData: MarketData | MarketDataLoaded): string | null {
  if (import.meta.env.VITE_OPERATOR) {
    return import.meta.env.VITE_OPERATOR;
  }

  if (extension.supportedMarkets === AllMarkets) {
    return null;
  }

  return extension.supportedMarkets[marketKey(marketData)] || null;
}

export function getSrc(extension: Extension): string | null {
  const viteKey = `VITE_${extension.id.toUpperCase()}_SOURCE`;
  if (import.meta.env.VITE_ALL_EXTENSIONS) {
    return import.meta.env.VITE_ALL_EXTENSIONS;
  } else if (import.meta.env[viteKey]) {
    return import.meta.env[viteKey];
  } else if ('url' in extension.source) {
    return extension.source.url;
  } else if ('ipfs' in extension.source) {
    const domain = extension.source.domain ?? 'ipfs.infura.io';
    const path = extension.source.path ?? '/';

    return `https://${domain}/ipfs/${extension.source.ipfs}${path}`;
  } else {
    throw new Error('Extension source missing');
  }
}

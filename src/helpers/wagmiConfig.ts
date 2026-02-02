import { createConfig, http } from 'wagmi';
import { type Chain } from 'wagmi/chains';
import { injected, walletConnect, coinbaseWallet } from 'wagmi/connectors';

import { CHAINS } from '@constants/chains';
import { ledgerConnector } from '@helpers/Ledger';

import { WALLECT_CONNECT_PROJECT_ID } from '../../envVars';

const supportedChains = Object.values(CHAINS).map(
  (chainInfo) =>
    ({
      id: chainInfo.chainId,
      name: chainInfo.name,
      nativeCurrency: chainInfo.nativeToken,
      rpcUrls: {
        default: { http: [chainInfo.url] },
      },
      blockExplorers: {
        default: { name: 'Explorer', url: chainInfo.blockExplorerUrls[0] },
      },
    } as const satisfies Chain)
) as unknown as readonly [Chain, ...Chain[]];

const transports = Object.fromEntries(supportedChains.map((chain) => [chain.id, http()]));

export const config = createConfig({
  chains: supportedChains,
  connectors: [
    injected(),
    walletConnect({ projectId: WALLECT_CONNECT_PROJECT_ID }),
    coinbaseWallet({
      appName: 'Compound III',
    }),
    ledgerConnector(),
  ],
  transports,
});

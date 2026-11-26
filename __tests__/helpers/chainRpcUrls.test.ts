import {
  arbitrum,
  avalanche,
  avalancheFuji,
  base,
  linea,
  mainnet,
  mantle,
  optimism,
  polygon,
  ronin,
  scroll,
  sepolia,
  unichain,
} from 'viem/chains';

const networks = [
  ['MAINNET_URL', mainnet],
  ['SEPOLIA_URL', sepolia],
  ['POLYGON_URL', polygon],
  ['ARBITRUM_URL', arbitrum],
  ['SCROLL_URL', scroll],
  ['OPTIMISM_URL', optimism],
  ['AVALANCHE_URL', avalanche],
  ['FUJI_URL', avalancheFuji],
  ['BASE_MAINNET_URL', base],
  ['MANTLE_URL', mantle],
  ['LINEA_URL', linea],
  ['UNICHAIN_URL', unichain],
  ['RONIN_URL', ronin],
] as const;

afterEach(() => jest.dontMock('../../envVars'));

test.each([undefined, '', 'not-a-url', '/ethereum-mainnet', 'https://', 'ftp://rpc.example', 'wss://rpc.example'])(
  'uses chain defaults when RPC overrides are %p',
  (value) => {
    jest.doMock('../../envVars', () => Object.fromEntries(networks.map(([name]) => [name, value])));

    jest.isolateModules(() => {
      const { CHAINS } = jest.requireActual<typeof import('../../src/constants/chains')>('../../src/constants/chains');
      for (const [, chain] of networks) {
        expect(CHAINS[chain.id].url).toBe(chain.rpcUrls.default.http[0]);
      }
    });
  }
);

test.each(['http://localhost:8545', 'https://rpc.example/v2/key?network=mainnet'])(
  'applies each RPC override from %s only to its chain',
  (endpoint) => {
    for (const [name, overriddenChain] of networks) {
      const url = `${endpoint}#${overriddenChain.id}`;
      jest.doMock('../../envVars', () => ({ [name]: url }));

      jest.isolateModules(() => {
        const { CHAINS } = jest.requireActual<typeof import('../../src/constants/chains')>('../../src/constants/chains');
        for (const [, chain] of networks) {
          expect(CHAINS[chain.id].url).toBe(chain.id === overriddenChain.id ? url : chain.rpcUrls.default.http[0]);
        }
      });
    }
  }
);

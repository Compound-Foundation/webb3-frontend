export enum GovernanceNetworksEnum {
  Mainnet = 'mainnet',
  Testnet = 'testnet',
}

type ContractAddreses = {
  testnet: string;
  mainnet: string;
};

// NOTE(alex) this could be more elegant if we want to expand to deployments on other chains
const GovernanceContracts: {
  [name: string]: ContractAddreses;
} = {
  GovernorBravo: {
    testnet: '0xa3FbaE9180a3c835C1F8688383989bB5558245d3',
    mainnet: '0xc0Da02939E1441F497fd74F78cE7Decb17B66529',
  },
  Comp: {
    testnet: '0x3587b2F7E0E2D6166d6C14230e7Fe160252B0ba4',
    mainnet: '0xc00e94Cb662C3520282E6f5717214004A7f26888',
  },
  Timelock: {
    testnet: '0x8Fa336EB4bF58Cfc508dEA1B0aeC7336f55B1399',
    mainnet: '0x6d903f6003cca6255D85CcA4D3B5E5146dC33925',
  },
};

export const getGovernanceContractAddress = (network: GovernanceNetworksEnum) => {
  return Object.keys(GovernanceContracts).map((name) => GovernanceContracts[name][network]);
};

import { Eip1193Bridge } from '@ethersproject/experimental';
import Eth from '@ledgerhq/hw-app-eth';
import Transport from '@ledgerhq/hw-transport';
import TransportWebUSB from '@ledgerhq/hw-transport-webusb';
import { Connector, createConnector } from '@wagmi/core';
import { ethers } from 'ethers';
import { numberToHex, getAddress, Chain } from 'viem';

const OLD_LEDGER_PATHS = ["44'/60'/0'/0", "44'/60'/0'/1", "44'/60'/0'/2"];
const LEDGER_LIVE_PATHS = ["44'/60'/0'/0/0", "44'/60'/1'/0/0", "44'/60'/2'/0/0"];
const GAS_BUFFER = 1.3;
const DEFAULT_GAS_LIMIT = 300000;

interface TrxParams {
  from: string;
  to: string;
  data: string;
  value: string;
}

function getChainOrThrow(config: { chains: readonly Chain[] }, chainId?: number) {
  const effectiveChainId = chainId ?? config.chains[0].id;
  const chain = config.chains.find((x) => x.id === effectiveChainId);
  if (!chain) {
    throw new Error(
      `Chain with id ${effectiveChainId} not found in config.chains. Available: ${config.chains
        .map((c) => c.id)
        .join(', ')}`
    );
  }
  return chain;
}

// helper for connect() and setup()
// find chain; create new ethers provider; crearte new LedgerEip1193Bridge; set up transport
async function setupProviderForChain(
  config: { chains: readonly Chain[] },
  chainId: number,
  pathString: string,
  transport: Transport | undefined
) {
  const chain = getChainOrThrow(config, chainId);
  const rpcUrl = chain.rpcUrls.default.http[0];
  const ethersProvider = new ethers.providers.JsonRpcProvider(rpcUrl);

  if (transport) {
    await transport.close();
  }
  const newTransport = await TransportWebUSB.create();

  const provider = new LedgerEip1193Bridge(
    ethersProvider.getSigner(),
    ethersProvider,
    newTransport,
    pathString,
    chainId
  );

  return { provider, transport: newTransport, chain };
}

function parseTrxParams(params?: unknown[]): TrxParams {
  if (!params || params[0] === null || typeof params[0] !== 'object') {
    throw new Error('Failed to parse trx params, none given. ' + params);
  }

  const { from, to, data, value } = params[0] as { [key: string]: string };
  if (typeof from !== 'string' || typeof to !== 'string' || typeof data !== 'string' || typeof value !== 'string') {
    throw new Error('Failed to parse trx params, invalid parameters. ' + params[0]);
  }
  return { from, to, data, value };
}

class LedgerUserRejectedError extends Error {
  public code: number;
  constructor() {
    super('Ledger RPC Error');
    this.code = 4001;
  }
}

export interface LedgerConnector extends Connector {
  setLedgerParams: (params: { pathString: string; address: string }) => void;
}

export function isLedgerConnector(connector: Connector): connector is LedgerConnector {
  return 'setLedgerParams' in connector;
}

export class LedgerEip1193Bridge extends Eip1193Bridge {
  _pathString: string;
  _provider: ethers.providers.Provider;
  _transport: Transport;
  _eth: Eth;
  _networkId: number;

  constructor(
    signer: ethers.Signer,
    provider: ethers.providers.Provider,
    transport: Transport,
    pathString: string,
    networkId: number
  ) {
    super(signer, provider);
    this._provider = provider;
    this._transport = transport;
    this._eth = new Eth(transport);
    this._pathString = pathString;
    this._networkId = networkId;
  }

  // The interface this extends has these already defined in this way
  // so let's silence the linter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async request(request: { method: string; params?: Array<any> }): Promise<any> {
    console.log('Ledger handling request: ', request);

    switch (request.method) {
      case 'eth_chainId':
        return await (async () => {
          return numberToHex(this._networkId);
        })();
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return await (async () => {
          const result = await this._eth.getAddress(this._pathString, false);
          return [result.address];
        })();
      case 'eth_sendTransaction':
        return await (async () => {
          console.log('attempting send transaction: ', request);

          //TODO: GEOFFF OR JARED CONFIRM
          //      http://man.hubwiz.com/docset/Ethereum.docset/Contents/Resources/Documents/eth_sendTransaction.html
          //      value is optional so in this case should we populate just 0x0? is that the correct thing to do?
          const sendTrxParams = request.params;
          if (sendTrxParams !== undefined && !('value' in sendTrxParams[0])) {
            sendTrxParams[0]['value'] = '0x0';
          }

          let trxParams;
          try {
            trxParams = parseTrxParams(sendTrxParams);
          } catch (e) {
            console.error(e);
            throw e;
          }

          const trxCount = await this._provider.getTransactionCount(trxParams.from, 'latest');
          console.log('trxCount: ', trxCount);

          const gasPriceWei = (await this._provider.getGasPrice()).toNumber();
          console.log('gas price: ', gasPriceWei);

          const baseTx = {
            to: trxParams.to,
            data: trxParams.data,
            value: trxParams.value,
            chainId: this._networkId,
          };

          let gasLimit;

          try {
            const gasEst = await this._provider.estimateGas(baseTx);
            gasLimit = Math.ceil(gasEst.toNumber() * GAS_BUFFER);

            console.log(`Gas Est: ${gasEst}, Gas Limit: ${gasLimit}`);
          } catch (e) {
            gasLimit = DEFAULT_GAS_LIMIT;
            console.log(`Error estimating gas, using fallback limit ${gasLimit}`);
            console.error(e);
          }

          const unsignedTx = {
            ...baseTx,
            gasPrice: ethers.utils.hexlify(gasPriceWei),
            gasLimit: ethers.utils.hexlify(gasLimit),
            nonce: trxCount,
          };

          console.log('unsignedTx: ', unsignedTx);
          const serializedTx = ethers.utils.serializeTransaction(unsignedTx).slice(2);

          console.log('serializedTx: ', serializedTx);

          // TODO: this is missing an arg that is printing a warning. Something to do with
          //      resolutions? Have zero clue how it's used but would be cool if it was
          //      used to better display the many paramters we show to users since Bulker
          //      is pretty verbose...
          let r: string;
          let s: string;
          let v: string;

          try {
            ({ r, s, v } = await this._eth.signTransaction(this._pathString, serializedTx));
          } catch (e) {
            console.log('error signing transaction: ', e);
            throw new LedgerUserRejectedError();
          }

          console.log('ledger signature: ', { r, s, v });

          const signature = {
            r: `0x${r}`,
            s: `0x${s}`,
            v: parseInt(v, 16),
            from: trxParams.from,
          };

          console.log('Parsed signature: ', signature);

          const signedTx = ethers.utils.serializeTransaction(unsignedTx, signature);
          console.log('signedTx: ', signedTx);

          const sendTxResult = await this._provider.sendTransaction(signedTx);
          console.log('sendTxResult: ', sendTxResult);

          return sendTxResult.hash;
        })();
      default:
        return super.request(request);
    }
  }
}

export interface LedgerParameters {
  pathString: string;
  address: string;
}

// @dev the main functions we need to implement a custom connector are:
// setup(), connect(), disconnect(), getAccounts(), getChainId(), getProvider(), isAuthorized(), switchChain(),
// onAccountsChanged(), onChainChanged(), onDisconnect()
export function ledgerConnector() {
  let pathString: string;
  let selectedAddress: string;
  let provider: LedgerEip1193Bridge | undefined;
  let transport: Transport | undefined;

  return createConnector<LedgerEip1193Bridge>((config) => ({
    id: 'ledger',
    name: 'Ledger',
    type: 'ledger',

    async setup() {
      // empty as we handle initialization in connect below
    },

    async connect({ chainId } = {}) {
      const chain = getChainOrThrow(config, chainId);
      const chainId_ = chain.id;

      if (!pathString || !selectedAddress) {
        throw new Error('Ledger path and address must be set before connecting');
      }

      const { provider: newProvider, transport: newTransport } = await setupProviderForChain(
        config,
        chainId_,
        pathString,
        transport
      );
      provider = newProvider;
      transport = newTransport;

      try {
        const accounts = await provider.request({
          method: 'eth_requestAccounts',
        });

        return {
          accounts: accounts.map((x: string) => getAddress(x)),
          chainId: chainId_,
        };
      } catch (error) {
        if (transport) {
          await transport.close();
          transport = undefined;
        }
        throw error;
      }
    },

    async disconnect() {
      if (transport) {
        await transport.close();
        transport = undefined;
      }
      provider = undefined;
      pathString = '';
      selectedAddress = '';
    },

    async getAccounts() {
      if (!provider) return [];
      const accounts = await provider.request({ method: 'eth_accounts' });
      return accounts.map((x: string) => getAddress(x));
    },

    async getChainId() {
      if (!provider) throw new Error('Provider not connected');
      const chainId = await provider.request({ method: 'eth_chainId' });
      return Number(chainId);
    },

    async getProvider({ chainId } = {}) {
      getChainOrThrow(config, chainId); // make sure chain configured

      if (!provider) {
        throw new Error('Provider not initialized');
      }
      return provider;
    },

    async isAuthorized() {
      try {
        if (!provider || !pathString || !selectedAddress) return false;
        const accounts = await this.getAccounts();
        return accounts.length > 0;
      } catch {
        return false;
      }
    },

    async switchChain({ chainId }) {
      const {
        provider: newProvider,
        transport: newTransport,
        chain,
      } = await setupProviderForChain(config, chainId, pathString, transport);
      provider = newProvider;
      transport = newTransport;
      config.emitter.emit('change', { chainId });
      return chain;
    },

    onAccountsChanged(accounts) {
      if (accounts.length === 0) this.onDisconnect();
      else config.emitter.emit('change', { accounts: accounts.map(getAddress) });
    },

    onChainChanged(chain) {
      const chainId = Number(chain);
      config.emitter.emit('change', { chainId });
    },

    onDisconnect() {
      config.emitter.emit('disconnect');
      if (transport) {
        transport.close();
        transport = undefined;
      }
      provider = undefined;
    },

    // custom ledger-specific methods
    setLedgerParams(params: LedgerParameters) {
      pathString = params.pathString;
      selectedAddress = params.address;
    },

    getLedgerParams() {
      return { pathString, address: selectedAddress };
    },
  }));
}

export async function getLedgerAddresses() {
  const transport = await TransportWebUSB.create();

  const eth = new Eth(transport);
  const oldLedgerAddresses: [string, string][] = [];
  for (const pathString of OLD_LEDGER_PATHS) {
    const { address } = await eth.getAddress(pathString, false);
    oldLedgerAddresses.push([pathString, address]);
  }

  const newLedgerAddresses: [string, string][] = [];
  for (const pathString of LEDGER_LIVE_PATHS) {
    const { address } = await eth.getAddress(pathString, false);
    newLedgerAddresses.push([pathString, address]);
  }

  await transport.close();

  return {
    legacyAddresses: oldLedgerAddresses,
    liveAddresses: newLedgerAddresses,
  };
}

import { InMessage, OutMessage, Permissions, checkPermission } from '@compound-finance/comet-extension';
import { BigNumber } from 'ethers';

import type { Web3 } from '@contexts/Web3Context';
import type { AddTransaction } from '@hooks/useTransactionManager';
import { MarketData, MarketDataLoaded } from '@types';

/**
 * Extensions - Handler
 *
 * These functions handle incoming messages from an extension
 * in the app interface. For instance, if an extension wants
 * to kick off a transaction, it would send a message to the
 * v3 interface (via `window.top.postMessage()`) and ultimately,
 * that message would be handled here. We first check that the
 * permissions allow such an action, and if so, execute it,
 * sending back a corresponding response message.
 */

let trxKey = 0;

export interface Context {
  web3: Web3;
  addTransaction: AddTransaction;
  selectedMarketData: MarketData | MarketDataLoaded;
}

export function isWriteful(method: string): boolean {
  return ['eth_chainId', 'eth_sendTransaction', 'eth_signTypedData_v4', 'eth_accounts'].includes(method);
}

// Like in useTransactionManager, it's really difficult to type any SC params
// since they can take lots of different forms depending on what the contract
// itself takes, so ignore any here as well.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleSendWeb3(context: Context, method: string, params: any[]): Promise<any> {
  if (context.web3.write.provider === undefined) {
    throw new Error('Context web3 write is missing provider.');
  }

  const web3Provider = context.web3.write.provider;
  if (isWriteful(method)) {
    const [sendOpts] = params;
    if (method === 'eth_sendTransaction') {
      const response = await context.addTransaction(
        `ext-${trxKey++}`,
        '',
        async (opts) => {
          const allOpts = { ...opts, ...sendOpts };
          // If the extension passes a gas param, assume it's probably using ether's estimateGas by default, which doesn't buffer by some safety margin.
          // Do this on behalf of the extension, to reduce the frequency of transaction failures.
          allOpts.gasLimit = `0x${Math.round(parseInt(allOpts.gas, 16) * 1.2).toString(16)}` || allOpts.gasLimit;
          delete allOpts.gas;
          try {
            return await web3Provider.getSigner().sendTransaction(allOpts);
          } catch (e) {
            console.error('Error running extension transaction', e);
            throw e;
          }
        },
        400000,
        // TODO(kevin): Need to clean this up, but it works for now since gas is overridden
        // in the extension transaction fn above.
        async () => BigNumber.from(400000),
        []
      );

      if (response) {
        return response.hash;
      } else {
        throw new Error(`Invalid response from trx, undefined`);
      }
    } else if (method === 'eth_accounts' && context.web3.write.account !== undefined) {
      return Promise.resolve([context.web3.write.account]);
    } else {
      return await web3Provider.send(method, params);
    }
  } else {
    return await web3Provider.send(method, params);
  }
}

async function handleMessageInner(context: Context, message: InMessage): Promise<OutMessage<InMessage>> {
  switch (message.type) {
    case 'sendWeb3':
      return { type: 'sendWeb3', data: await handleSendWeb3(context, message.method, message.params) };
    case 'getSelectedMarket':
      return {
        type: 'setSelectedMarket',
        selectedMarket: {
          chainId: context.selectedMarketData.chainInformation.chainId,
          baseAssetSymbol: context.selectedMarketData.baseAsset.symbol,
          marketAddress: context.selectedMarketData.marketAddress,
        },
      };
    case 'storage:read':
      throw new Error('not implemented');
    case 'storage:write':
      throw new Error('not implemented');
    case 'getTheme':
      throw new Error('not implemented');
    case 'getCometState':
      throw new Error('not implemented');
  }
}

export async function handleMessage(
  context: Context,
  permissions: Permissions,
  msgId: number,
  message: InMessage,
  operator: string | null
): Promise<{ msgId: number; result: OutMessage<InMessage> } | { msgId: number; error: unknown }> {
  const err = checkPermission(message, permissions, operator);
  if (err !== null) {
    throw new Error(`AccessDenied: ${err}`);
  }

  try {
    const outMessage: OutMessage<InMessage> = await handleMessageInner(context, message);
    return { msgId, result: outMessage };
  } catch (e) {
    return { msgId, error: e };
  }
}

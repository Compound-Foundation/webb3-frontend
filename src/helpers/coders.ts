import { Buffer } from 'buffer';

import { Interface, Result } from '@ethersproject/abi';
import sha3 from 'js-sha3';

// from our friends at compound-devops :)

type ReadableEventSignature = `event ${string}(${string})`;

export type RawLog = {
  data: string; // hex-encoded log arguments
  address: string; // hex of address
  removed: boolean; // whether the event was removed in a chain reorg
  logIndex: number; // hex of index
  blockHash: string; // 32 byte hash (keccak)
  blockNumber: number; // hex of block number
  transactionIndex: number; // hex of index
  transactionHash: string; // 32 byte hash (keccak)
  topics:
    | [string] // hash of signature
    | [string, string] // ... and up to three
    | [string, string, string] // ... indexable
    | [string, string, string, string]; // ... event arguments.
};

const ProposalCreated: ReadableEventSignature = `event ProposalCreated(
    uint      id,
    address   proposer,
    address[] targets,
    uint[]    values_,
    string[]  signatures,
    bytes[]   calldatas,
    uint      startBlock,
    uint      endBlock,
    string    description
  )`;

const ProposalCanceled: ReadableEventSignature = `event ProposalCanceled(uint id)`;
const ProposalExecuted: ReadableEventSignature = `event ProposalExecuted(uint id)`;
const ProposalQueued: ReadableEventSignature = `event ProposalQueued(uint id, uint eta)`;

export const proposalEvents = {
  ProposalCreated,
  ProposalCanceled,
  ProposalExecuted,
  ProposalQueued,
};

const encoder = new TextEncoder();

function keccak256(source: string): string {
  const utf8Bytes = encoder.encode(source);
  const digestBytes = sha3.keccak256.arrayBuffer(utf8Bytes);
  return Buffer.from(digestBytes).toString('hex');
}

export function getEventLogCoders(signatures: ReadableEventSignature[]) {
  const iface = new Interface(signatures);
  return {
    signatures,
    topics: Object.fromEntries(
      iface.fragments.map((f) => {
        const hash = keccak256(f.format());
        return [f.name, () => `0x${hash}`];
      })
    ) as { [k: string]: () => string },
    decode: ({ topics, data, blockNumber }: RawLog) => {
      const { name, args, topic } = iface.parseLog({ topics, data });
      return {
        name,
        topic,
        blockNumber,
        body: args,
      } as { name: string; topic: string; blockNumber: number; body: Result };
    },
  };
}

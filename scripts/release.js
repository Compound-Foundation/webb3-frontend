import { ethers } from 'ethers';
import fetch from 'node-fetch';
import * as fs from 'fs/promises';

const releaseFile = '.release';
const ethereumNode = process.env['ETHEREUM_NODE'] || 'http://localhost:8585';
const workerHost = process.env['WORKER_HOST'] || 'https://v3-app.compound.xyz';
const url = `${workerHost}/release`;

async function release(payload, url, signature) {
  const body = JSON.stringify(payload);
  console.log(`Release payload=${body}, url=${url}`);

  const res = await fetch(url, {
    body,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': signature,
    },
  });

  let json;
  try {
    json = await res.json();
  } catch (error) {
    throw new Error(`Response was not valid JSON: ${error}`);
  }

  if (json && json.cid) {
    console.log(`Successfully released: ${json.cid}`);
  } else {
    throw new Error(`Invalid response: ${JSON.stringify(json)}`);
  }
}

// The signed message is the JSON-stringified payload. The worker recovers the
// signer from this exact body and checks it matches `deployer` and `timestamp`,
// so the object signed here must be byte-identical to the one sent in `release`.
function buildPayload(cid, timestamp, deployer) {
  return { cid, timestamp, deployer };
}

async function run(cid, signature, timestamp, deployer) {
  if (!cid) {
    cid = (await fs.readFile(releaseFile, 'utf-8')).trim();
  }

  // Release timestamp (epoch ms) provides replay protection: the worker
  // requires it to strictly increase between releases.
  if (timestamp === undefined) {
    timestamp = Date.now();
  }

  // Resolve the deployer address from the Ethereum node (e.g. Seacrest) and
  // sign the payload there whenever either is missing.
  if (deployer === undefined || !signature) {
    const provider = new ethers.providers.JsonRpcProvider(ethereumNode);
    const signer = provider.getSigner();

    if (deployer === undefined) {
      deployer = await signer.getAddress();
    }

    if (!signature) {
      // If no signature, sign the payload via the node, e.g. Seacrest
      signature = await signer.signMessage(JSON.stringify(buildPayload(cid, timestamp, deployer)));
    }
  }

  return await release(buildPayload(cid, timestamp, deployer), url, signature);
}

let [_node, _app, cidArg, signatureArg, timestampArg, deployerArg, ...rest] = process.argv;
const cid = cidArg || process.env['CID'];
const signature = signatureArg || process.env['SIGNATURE'];
const timestampRaw = timestampArg || process.env['TIMESTAMP'];
const timestamp = timestampRaw ? Number(timestampRaw) : undefined;
const deployer = deployerArg || process.env['DEPLOYER'] || undefined;

run(cid, signature, timestamp, deployer);

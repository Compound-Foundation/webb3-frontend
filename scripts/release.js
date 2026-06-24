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
// signer from this exact body and checks it matches `deployer` and `nonce`, so
// the object signed here must be byte-identical to the one sent in `release`.
function buildPayload(cid, nonce, deployer) {
  return { cid, nonce, deployer };
}

async function run(cid, signature, nonce, deployer) {
  if (!cid) {
    cid = (await fs.readFile(releaseFile, 'utf-8')).trim();
  }

  // Resolve the deployer address and on-chain nonce from the Ethereum node
  // (e.g. Seacrest) whenever any of them is missing.
  if (deployer === undefined || nonce === undefined || !signature) {
    const provider = new ethers.providers.JsonRpcProvider(ethereumNode);
    const signer = provider.getSigner();

    if (deployer === undefined) {
      deployer = await signer.getAddress();
    }
    if (nonce === undefined) {
      nonce = await provider.getTransactionCount(deployer);
    }

    if (!signature) {
      // If no signature, sign the payload via the node, e.g. Seacrest
      signature = await signer.signMessage(JSON.stringify(buildPayload(cid, nonce, deployer)));
    }
  }

  return await release(buildPayload(cid, nonce, deployer), url, signature);
}

let [_node, _app, cidArg, signatureArg, nonceArg, deployerArg, ...rest] = process.argv;
const cid = cidArg || process.env['CID'];
const signature = signatureArg || process.env['SIGNATURE'];
const nonceRaw = nonceArg || process.env['NONCE'];
const nonce = nonceRaw ? Number(nonceRaw) : undefined;
const deployer = deployerArg || process.env['DEPLOYER'] || undefined;

run(cid, signature, nonce, deployer);

import { ethers } from 'ethers';
import fetch from 'node-fetch';
import * as fs from 'fs/promises';

const releaseFile = '.release';
const ethereumNode = process.env['ETHEREUM_NODE'] || 'http://localhost:8585';
const workerHost = process.env['WORKER_HOST'] || 'https://v3-app.compound.xyz';
const url = `${workerHost}/release`;
// The worker accepts only a release signed for its own app host, so a release
// signed for one app is rejected by the other. Releasing through an alias host
// such as app.compound.xyz needs APP_HOST set to the primary host.
const appHost = process.env['APP_HOST'] || new URL(workerHost).host;

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
// signer from this exact body and checks it matches `deployer`, so the object
// signed here must be byte-identical to the one sent in `release`.
function buildPayload(cid, timestamp, deployer) {
  return { cid, timestamp, deployer, app_host: appHost };
}

async function run(cid, signature, timestamp, deployer) {
  if (!cid) {
    cid = (await fs.readFile(releaseFile, 'utf-8')).trim();
  }

  // Release timestamp (epoch ms) provides replay protection: the worker
  // requires it to increase with every release and to be within the window set
  // by RELEASE_MAX_AGE_MS and RELEASE_MAX_FUTURE_MS in frontend-devops
  // (cloudflare/pinata-ipfs-worker/src/ipfs/release.ts).
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

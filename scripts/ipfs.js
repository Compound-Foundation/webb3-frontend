import { PinataSDK } from 'pinata';
import { globby } from 'globby';
import { readFileSync } from 'fs';
import { appendFile, writeFile } from 'fs/promises';

const pinataJwt = process.env['PINATA_JWT'] || '';
const gatewayUrl = process.env['PINATA_GATEWAY_URL'];

if (!gatewayUrl) {
  console.error('Must set PINATA_GATEWAY_URL');
  process.exit(1);
}

function buildPinataClient() {
  return new PinataSDK({
    pinataJwt: pinataJwt,
    pinataGateway: gatewayUrl,
  });
}

(async function () {
  const allDeployableFiles = await globby(['dist/**/*']);
  const expectedFileCount = allDeployableFiles.length;

  let ipfs = buildPinataClient();

  let allFilesToUpload = [];
  for (const fileName of allDeployableFiles) {
    console.log('Reading file: ', fileName);
    const adjustedFileName = fileName.replace('dist/', '');
    try {
      const blob = new Blob([readFileSync(fileName)]);
      const file = new File([blob], adjustedFileName, { type: 'text/plain' });
      allFilesToUpload.push(file);
    } catch (error) {
      console.log(error);
    }
  }

  let uploaded;
  try {
    uploaded = await ipfs.upload.public.fileArray(allFilesToUpload);
  } catch (error) {
    console.log(error);
  }

  if (!uploaded || !uploaded.cid) {
    throw new Error('Upload to Pinata failed: no CID returned.');
  }

  console.log(`Uploaded ${uploaded.number_of_files} total files.`);

  // Verify the number of files uploaded matches the number
  // of files we counted in the deploy directory.
  if (uploaded.number_of_files < expectedFileCount) {
    console.log(`Expected number of files to upload: ${expectedFileCount}`);
    console.log(`Uploaded total number of files: ${uploaded.number_of_files}`);

    throw new Error('Failed to upload enough files.');
  }

  const ipfsUrl = `https://ipfs.io/ipfs/${uploaded.cid}`;
  const pinataUrl = `https://${gatewayUrl}/ipfs/${uploaded.cid}`;

  const urls = [
    ['IPFS Url', ipfsUrl],
    ['Pinata Url', pinataUrl],
  ];
  const urlText = urls.map(([name, url]) => `  * ${name}: ${url}`).join('\n');

  console.log('\n\n');
  console.log('🗺  App successfully deployed to ipfs:\n');
  console.log(urlText);
  console.log('\n');

  await writeFile('.release', `${uploaded.cid}`, 'utf8');

  // Expose the result to later workflow steps (deployment status, PR comment).
  // RELEASE_URL is what build.yaml has always read for the deployment URL; it
  // was never set before this, so the deployment "View deployment" link was blank.
  const outputs = {
    RELEASE_URL: pinataUrl,
    PINATA_URL: pinataUrl,
    IPFS_URL: ipfsUrl,
    IPFS_CID: uploaded.cid,
  };
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  for (const target of ['GITHUB_ENV', 'GITHUB_OUTPUT']) {
    const path = process.env[target];
    if (path) {
      await appendFile(path, lines, 'utf8');
    }
  }
})();

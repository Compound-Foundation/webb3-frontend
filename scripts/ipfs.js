import { PinataSDK } from 'pinata';
import { globby } from 'globby';
import { readFileSync } from 'fs';
import { writeFile } from 'fs/promises';

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

  let uploaded = '';
  try {
    uploaded = await ipfs.upload.public.fileArray(allFilesToUpload);
  } catch (error) {
    console.log(error);
  }

  console.log(`Uploaded ${uploaded.number_of_files} total files.`);

  // Verify the number of files uploaded matches the number
  // of files we counted in the deploy directory.
  if (uploaded.number_of_files < expectedFileCount) {
    console.log(`Expected number of files to upload: ${expectedFileCount}`);
    console.log(`Uploaded total number of files: ${uploaded.number_of_files}`);

    throw new Error('Failed to upload enough files.');
  }

  const urls = [
    ['IPFS Url', `https://ipfs.io/ipfs/${uploaded.cid}`],
    ['Pinata Url', `https://${gatewayUrl}/ipfs/${uploaded.cid}`],
  ];
  const urlText = urls.map(([name, url]) => `  * ${name}: ${url}`).join('\n');

  console.log('\n\n');
  console.log('🗺  App successfully deployed to ipfs:\n');
  console.log(urlText);
  console.log('\n');

  writeFile('.release', `${uploaded.cid}`, 'utf8');
})();

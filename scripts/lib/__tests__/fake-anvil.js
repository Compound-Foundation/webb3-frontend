// A stand-in for anvil in the runner's own tests. The tests start it through a shell script that
// passes the behaviour to fake as the first argument, because the runner gives anvil no other
// environment than PATH and HOME. It answers `--version` as anvil does. Run as the fork, it fakes
// one of these behaviours:
// - `genesis`: reads one genesis account through the runner's proxy, as anvil 1.2.3 does at
//   start-up. When the read fails, it prints anvil's own error, with the upstream's answer in it,
//   and exits.
// - `address-in-use`: fails at start-up as anvil does when its port is taken, without a read.
// - `wrong-fork`: starts, and reports a fork block hash other than the one the runner chose.
import http from 'node:http';

/** anvil's third dev account, whose genesis read failed in a recorded run. */
const GENESIS_ACCOUNT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const WRONG_HASH = `0x${'ab'.repeat(32)}`;

const [behaviour, ...args] = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('anvil Version: 1.2.3-fake');
  process.exit(0);
}
const option = (name) => args[args.indexOf(name) + 1];
const forkUrl = option('--fork-url');
const forkBlock = Number(option('--fork-block-number'));

/**
 * anvil's error for a failed genesis read, as anvil 1.2.3 words it. alloy adds a JSON-RPC error's
 * data after its message.
 */
function genesisError(status, body) {
  let answer;
  try {
    answer = JSON.parse(body);
  } catch {
    answer = undefined;
  }
  const cause =
    status !== 200
      ? `Max retries exceeded HTTP error ${status} with ${body === '' ? 'empty body' : `body: ${body}`}`
      : answer?.error !== undefined
      ? `server returned an error response: error code ${answer.error.code}: ${answer.error.message}${
          answer.error.data === undefined ? '' : `, data: ${JSON.stringify(answer.error.data)}`
        }`
      : `deserialization error: invalid value, text: ${body}`;
  return `Error: failed to create genesis\n\nContext:\n- failed to get account for ${GENESIS_ACCOUNT}: ${cause}\n`;
}

if (behaviour === 'genesis') {
  const response = await fetch(forkUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 8,
      method: 'eth_getBalance',
      params: [GENESIS_ACCOUNT, `0x${forkBlock.toString(16)}`],
    }),
  });
  const body = await response.text();
  process.stderr.write(genesisError(response.status, body));
  process.exit(1);
}

if (behaviour === 'address-in-use') {
  process.stderr.write('Error: Address already in use (os error 48)\n');
  process.exit(1);
}

if (behaviour === 'wrong-fork') {
  const results = {
    eth_chainId: '0x1',
    web3_clientVersion: 'anvil/v1.2.3',
    anvil_metadata: { forkedNetwork: { forkBlockNumber: forkBlock, forkBlockHash: WRONG_HASH } },
    eth_getBlockByNumber: { number: `0x${forkBlock.toString(16)}`, hash: WRONG_HASH },
  };
  const server = http.createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      const { id, method } = JSON.parse(text);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result: results[method] ?? null }));
    });
  });
  server.listen(0, '127.0.0.1', () => console.log(`Listening on 127.0.0.1:${server.address().port}`));
  process.on('SIGTERM', () => process.exit(0));
}

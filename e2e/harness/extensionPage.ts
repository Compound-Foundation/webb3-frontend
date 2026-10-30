// The harness's test extension: a page the app loads in its extension frame at `/extensions/cfharness`.
// It speaks the `@compound-finance/comet-extension` message protocol that `src/pages/extensions/Extension.tsx`
// handles: it posts `{ msgId, message: { type: 'sendWeb3', method, params } }` to the app, which forwards
// `personal_sign` and `eth_signTypedData_v4` to the connected wallet (`helpers/handler.ts`). Each button asks
// for one signature and writes the answer into the page, for the test to read.
//
// The typed data uses a harness domain on chain 1 with the zero address as its contract. It is not a permit
// and authorizes nothing.

export const EXTENSION_MESSAGE = 'Compound browser harness: extension personal_sign';

export const HARNESS_TYPED_DATA = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
    HarnessCheck: [
      { name: 'purpose', type: 'string' },
      { name: 'nonce', type: 'uint256' },
    ],
  },
  primaryType: 'HarnessCheck',
  domain: {
    name: 'Compound browser harness',
    version: '1',
    chainId: 1,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  },
  message: { purpose: 'browser harness signature check; authorizes nothing', nonce: 1 },
} as const;

export const EXTENSION_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Compound browser harness extension</title></head>
<body>
<h1>Compound browser harness extension</h1>
<button id="sign-personal">Sign message</button>
<button id="sign-typed">Sign typed data</button>
<pre id="account"></pre>
<pre id="result-personal"></pre>
<pre id="result-typed"></pre>
<pre id="error"></pre>
<script>
(() => {
  let nextId = 1000;
  const waiting = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data.msgId !== 'number' || !waiting.has(data.msgId)) return;
    const { resolve, reject } = waiting.get(data.msgId);
    waiting.delete(data.msgId);
    if ('error' in data) reject(data.error); else resolve(data.result && data.result.data);
  });
  const sendWeb3 = (method, params) => new Promise((resolve, reject) => {
    const msgId = nextId++;
    waiting.set(msgId, { resolve, reject });
    window.parent.postMessage({ msgId, message: { type: 'sendWeb3', method, params } }, '*');
  });
  const show = (id, text) => { document.getElementById(id).textContent = text; };
  const run = async (id, sign) => {
    show('error', '');
    try {
      const [account] = await sendWeb3('eth_accounts', []);
      show('account', account);
      show(id, await sign(account));
    } catch (error) {
      show('error', String((error && (error.message || error.code)) || error));
    }
  };
  const message = ${JSON.stringify(EXTENSION_MESSAGE)};
  const hexMessage = '0x' + Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, '0')).join('');
  const typedData = ${JSON.stringify(HARNESS_TYPED_DATA)};
  document.getElementById('sign-personal').addEventListener('click', () =>
    run('result-personal', (account) => sendWeb3('personal_sign', [hexMessage, account])));
  document.getElementById('sign-typed').addEventListener('click', () =>
    run('result-typed', (account) => sendWeb3('eth_signTypedData_v4', [account, JSON.stringify(typedData)])));
})();
</script>
</body>
</html>
`;

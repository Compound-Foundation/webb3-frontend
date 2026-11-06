/**
 * @jest-environment node
 */
// The scan of a run's outputs for its secrets, ZIP members (Playwright traces) included.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { createRedactor, secretPatternsOf } from '../fork';
import { findSecrets, outputsUnder, registerSecret, registerSecretPattern, zipMembers } from '../secrets';

const TOKEN = 'c'.repeat(64);
const KEY = `0x${'d'.repeat(64)}`;
/** A cache root's account salt, the length of the control token. */
const SALT = 'e'.repeat(64);

/** A ZIP of `members`, deflated, as Playwright writes a trace. */
function zip(members: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(members)) {
    const data = deflateRawSync(Buffer.from(text));
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(members).length, 8);
  end.writeUInt16LE(Object.keys(members).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let directory: string;
beforeAll(() => {
  registerSecret(TOKEN, 'the control token');
  registerSecret(KEY);
  registerSecret(SALT, 'the account salt');
  registerSecretPattern(secretPatternsOf('https://rpc.example.com/v2/PrivateKey0123456789abcdef')[0]);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-scan-'));
});
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

test('reads every member of a deflated ZIP', () => {
  expect(
    zipMembers(zip({ 'trace.trace': 'one', 'resources/a.json': 'two' })).map((member) => [
      member.name,
      member.content.toString(),
    ])
  ).toEqual([
    ['trace.trace', 'one'],
    ['resources/a.json', 'two'],
  ]);
});

test('finds the token inside a compressed trace member, which a scan of the raw ZIP would miss', () => {
  const trace = zip({ 'trace.network': `{"headers":[{"name":"authorization","value":"Bearer ${TOKEN}"}]}` });
  fs.writeFileSync(path.join(directory, 'trace.zip'), trace);
  expect(findSecrets([{ file: 'raw', content: trace }])).toEqual([]);
  expect(findSecrets(outputsUnder([directory]))).toEqual([
    { file: `${path.join(directory, 'trace.zip')}#trace.network`, secret: 'the control token' },
  ]);
});

test("finds the token inside the ZIP that Playwright's HTML report embeds in index.html", () => {
  const report = path.join(directory, 'html');
  fs.mkdirSync(report);
  const embedded = zip({ 'report.json': `{"stdout":["Bearer ${TOKEN}"]}` }).toString('base64');
  fs.writeFileSync(
    path.join(report, 'index.html'),
    `<template id="playwrightReportBase64">data:application/zip;base64,${embedded}</template>`
  );
  expect(findSecrets(outputsUnder([report]))).toEqual([
    { file: `${path.join(report, 'index.html')}#embedded/report.json`, secret: 'the control token' },
  ]);
});

test('finds a key with or without 0x, JSON-escaped or base64, and the private URL, naming each by kind only', () => {
  const leaks = findSecrets([
    { file: 'a', content: `key ${KEY.slice(2)}` },
    { file: 'b', content: Buffer.from(KEY).toString('base64') },
    { file: 'c', content: 'https://rpc.example.com/v2/PrivateKey0123456789abcdef' },
    { file: 'd', content: 'nothing here' },
  ]);
  expect(leaks).toEqual([
    { file: 'a', secret: 'a key the wallet made' },
    { file: 'b', secret: 'a key the wallet made' },
    { file: 'c', secret: 'the private upstream URL' },
  ]);
  expect(JSON.stringify(leaks)).not.toContain(KEY.slice(2));
  // The salt has the token's length, and is named by the kind it was registered with.
  expect(findSecrets([{ file: 'e', content: `salt ${SALT}` }])).toEqual([{ file: 'e', secret: 'the account salt' }]);
  expect(createRedactor([], [TOKEN]).redact(TOKEN)).toBe('<redacted>');
});

/** A secret whose JSON-escaped form differs from the text as written. */
const ESCAPED = 'quote"back\\slash';

test('finds each form, in either letter case, and reports leaks in text order, then registration order', () => {
  registerSecret(ESCAPED, 'a secret with escapes');
  const json = JSON.stringify(ESCAPED).slice(1, -1);
  const texts = [
    { file: 'with 0x, upper case', content: `key ${KEY.toUpperCase()}` },
    { file: 'without 0x', content: Buffer.from(`key ${KEY.slice(2)}`) },
    { file: 'JSON-escaped only', content: `{"value":"${json}"}` },
    { file: 'base64', content: `data:text/plain;base64,${Buffer.from(KEY).toString('base64')}` },
    { file: 'URL, upper case', content: 'HTTPS://RPC.EXAMPLE.COM/V2/PRIVATEKEY0123456789ABCDEF' },
    { file: 'clean', content: 'nothing here' },
    {
      file: 'every kind',
      content: `${SALT} ${ESCAPED} ${KEY} ${TOKEN} https://rpc.example.com/v2/PrivateKey0123456789abcdef`,
    },
  ];
  // The JSON-escaped text holds no other form of the secret.
  expect(texts[2].content).not.toContain(ESCAPED);
  const leaks = findSecrets(texts);
  expect(leaks).toEqual([
    { file: 'with 0x, upper case', secret: 'a key the wallet made' },
    { file: 'without 0x', secret: 'a key the wallet made' },
    { file: 'JSON-escaped only', secret: 'a secret with escapes' },
    { file: 'base64', secret: 'a key the wallet made' },
    { file: 'URL, upper case', secret: 'the private upstream URL' },
    { file: 'every kind', secret: 'the control token' },
    { file: 'every kind', secret: 'a key the wallet made' },
    { file: 'every kind', secret: 'the account salt' },
    { file: 'every kind', secret: 'a secret with escapes' },
    { file: 'every kind', secret: 'the private upstream URL' },
  ]);
  for (const secret of [TOKEN, KEY.slice(2), SALT, ESCAPED, json]) expect(JSON.stringify(leaks)).not.toContain(secret);
});

test('attributes each leak to the raw file, trace member or embedded report member that holds it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-harness-containers-'));
  try {
    fs.writeFileSync(path.join(root, 'a-raw.log'), `Bearer ${TOKEN}`);
    fs.writeFileSync(
      path.join(root, 'b-trace.zip'),
      zip({ 'clean.trace': 'nothing here', 'trace.network': `{"key":"${KEY}"}`, 'trace.stacks': `salt ${SALT}` })
    );
    const embedded = zip({ 'report.json': `{"stdout":["${Buffer.from(TOKEN).toString('base64')}"]}` });
    fs.writeFileSync(
      path.join(root, 'c-index.html'),
      `<template>data:application/zip;base64,${embedded.toString('base64')}</template>`
    );
    const outputs = outputsUnder([root]);
    expect(outputs.map((output) => path.relative(root, output.file))).toEqual([
      'a-raw.log',
      'b-trace.zip',
      'b-trace.zip#clean.trace',
      'b-trace.zip#trace.network',
      'b-trace.zip#trace.stacks',
      'c-index.html',
      'c-index.html#embedded/report.json',
    ]);
    expect(findSecrets(outputs).map((leak) => [path.relative(root, leak.file), leak.secret])).toEqual([
      ['a-raw.log', 'the control token'],
      ['b-trace.zip#trace.network', 'a key the wallet made'],
      ['b-trace.zip#trace.stacks', 'the account salt'],
      ['c-index.html#embedded/report.json', 'the control token'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

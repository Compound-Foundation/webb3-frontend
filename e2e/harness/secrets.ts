// The run's secrets, and the scan of every output the run wrote for them.
//
// The registry lives on `globalThis` in the Playwright runner, where the global setup, the wallet server and
// the reporters run, so the summary reporter can scan the outputs after every other reporter has finished.
// It holds the control token, every key the wallet made, the fork cache's account salt and the private
// upstream URL's patterns. Each literal is held with its kind, which names it in a report.
//
// The scan reads each file whole, each member of a ZIP file (a Playwright trace) after inflating it, and
// the ZIP that Playwright's HTML report embeds in its index.html, in
// text, in its JSON-escaped form and in the base64 an attachment can take. Gzip attachments are inflated too.
// A secret found after the run proves a leak. The scan does not prevent it: the token never enters the page by design.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const REGISTRY = Symbol.for('cf-browser-harness.secrets');
type Registry = { literals: Map<string, string>; patterns: Set<string> };

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  holder[REGISTRY] ??= { literals: new Map(), patterns: new Set() };
  return holder[REGISTRY] as Registry;
}

/** Registers `secret`, which a report names as `kind`. */
export const registerSecret = (secret: string, kind = 'a key the wallet made') =>
  void registry().literals.set(secret, kind);
export const registerSecretPattern = (pattern: string) => void registry().patterns.add(pattern);
export const registeredSecretCount = () => registry().literals.size + registry().patterns.size;

/**
 * The ZIP members of `buffer`, inflated: name and content. It reads the central directory, as a trace's
 * members are listed there with their real sizes.
 */
export function zipMembers(buffer: Buffer): { name: string; content: Buffer }[] {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1) return [];
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const members: { name: string; content: Buffer }[] = [];
  for (let index = 0; index < count && buffer.readUInt32LE(offset) === 0x02014b50; index++) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    members.push({ name, content: method === 8 ? inflateRawSync(data) : data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

/** The forms of `secret` a scan looks for: as written, without `0x`, JSON-escaped and in base64. */
const forms = (secret: string) => [
  secret,
  secret.replace(/^0x/, ''),
  JSON.stringify(secret).slice(1, -1),
  Buffer.from(secret).toString('base64').replace(/=+$/, ''),
];

export type Leak = { file: string; secret: string };

/** Each place in `texts` that holds a registered secret. A secret is named by kind only, never shown. */
export function findSecrets(texts: { file: string; content: Buffer | string }[]): Leak[] {
  const { literals, patterns } = registry();
  // The needles and expressions do not depend on the text, so they are made once per scan, not per text.
  const needles = [...literals].map(([secret, kind]) => ({
    kind,
    forms: [...new Set(forms(secret).map((form) => form.toLowerCase()))],
  }));
  const expressions = [...patterns].map((pattern) => new RegExp(pattern, 'i'));
  const leaks: Leak[] = [];
  for (const { file, content } of texts) {
    const text = typeof content === 'string' ? content : content.toString('latin1');
    const lowerText = text.toLowerCase();
    for (const { kind, forms: needleForms } of needles) {
      if (needleForms.some((form) => lowerText.includes(form))) leaks.push({ file, secret: kind });
    }
    for (const expression of expressions)
      if (expression.test(text)) leaks.push({ file, secret: 'the private upstream URL' });
  }
  return leaks;
}

/** Files under `roots`, their ZIP members, and gzip contents in either. */
export function outputsUnder(roots: string[]): { file: string; content: Buffer }[] {
  const outputs: { file: string; content: Buffer }[] = [];
  const add = (file: string, content: Buffer) => {
    outputs.push({ file, content });
    // Trace and report attachments can have hashed names without the original .gz suffix.
    if (content[0] === 0x1f && content[1] === 0x8b && content[2] === 0x08) {
      outputs.push({ file: `${file}#gunzip`, content: gunzipSync(content) });
    }
  };
  const visit = (entry: string) => {
    if (!fs.existsSync(entry)) return;
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
      return;
    }
    const content = fs.readFileSync(entry);
    add(entry, content);
    if (entry.endsWith('.zip')) {
      for (const member of zipMembers(content)) {
        add(`${entry}#${member.name}`, member.content);
      }
    }
    // Playwright's HTML report embeds its data, every test's errors, output and attachments, as a
    // base64 ZIP inside index.html.
    if (entry.endsWith('.html')) {
      for (const match of content.toString('latin1').matchAll(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/g)) {
        for (const member of zipMembers(Buffer.from(match[1], 'base64'))) {
          add(`${entry}#embedded/${member.name}`, member.content);
        }
      }
    }
  };
  roots.forEach(visit);
  return outputs;
}

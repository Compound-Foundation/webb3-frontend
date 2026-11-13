/**
 * @jest-environment node
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { OutputBundle, OutputOptions } from 'rolldown';

import { devMinificationOf, minifyDev } from '../devMinification';

test('minifies only with an explicit bundled-dev opt-in', () => {
  for (const value of [undefined, '', '0']) expect(devMinificationOf({ BROWSER_TEST_MINIFY_DEV: value })).toBe(false);
  for (const value of ['yes', 'true', '2']) {
    expect(() => devMinificationOf({ BROWSER_TEST_MINIFY_DEV: value })).toThrow('must be 0 or 1');
  }
  expect(() => devMinificationOf({ BROWSER_TEST_MINIFY_DEV: '1' })).toThrow('requires BROWSER_TEST_BUNDLED_DEV=1');
  expect(devMinificationOf({ BROWSER_TEST_MINIFY_DEV: '1', BROWSER_TEST_BUNDLED_DEV: '1' })).toBe(true);
});

test('preserves code, names, source contents and execution order', () => {
  const plugin = minifyDev('/unused');
  const configure = plugin.outputOptions as (options: OutputOptions) => OutputOptions;
  const options = configure({ minify: false, strictExecutionOrder: true });
  expect(plugin.apply).toBe('serve');
  expect(options).toEqual({
    strictExecutionOrder: true,
    keepNames: true,
    minify: {
      compress: false,
      mangle: { keepNames: true },
      codegen: { removeWhitespace: true, legalComments: 'inline' },
    },
    sourcemap: true,
    sourcemapExcludeSources: false,
  });
});

test('archives earlier and later chunk maps before serving each output, without dropping original sources', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-minify-maps-'));
  const archive = path.join(directory, 'maps.json.gz');
  const plugin = minifyDev(archive);
  const generate = (plugin.generateBundle as { handler: unknown }).handler as (
    options: OutputOptions,
    bundle: OutputBundle,
    isWrite: boolean
  ) => Promise<void>;
  const bundle = (code: string, source: string) =>
    ({
      'app.js': {
        type: 'chunk',
        fileName: 'app.js',
        moduleIds: ['src/main.ts'],
        code,
        map: { version: 3, sources: ['src/main.ts'], sourcesContent: [source], names: [], mappings: 'AAAA' },
      },
    } as unknown as OutputBundle);
  try {
    await generate({}, bundle('let a=1;', 'let originalName = 1;'), false);
    const firstSnapshot = fs.readFileSync(archive);
    await generate({}, bundle('let a=2;', 'let originalName = 2;'), false);
    const records = JSON.parse(gunzipSync(fs.readFileSync(archive)).toString());
    expect(
      records.map((record: { generatedCodeSha256: string; map: { sourcesContent: string[] } }) => [
        record.generatedCodeSha256,
        record.map.sourcesContent,
      ])
    ).toEqual([
      [crypto.createHash('sha256').update('let a=1;').digest('hex'), ['let originalName = 1;']],
      [crypto.createHash('sha256').update('let a=2;').digest('hex'), ['let originalName = 2;']],
    ]);
    expect(JSON.parse(gunzipSync(firstSnapshot).toString())).toHaveLength(1);
    expect(fs.statSync(archive).mode & 0o777).toBe(0o600);
    await generate({}, bundle('let a=2;', 'let originalName = 2;'), false);
    expect(JSON.parse(gunzipSync(fs.readFileSync(archive)).toString())).toHaveLength(2);
    await Promise.all([
      generate({}, bundle('let a=3;', 'let originalName = 3;'), false),
      generate({}, bundle('let a=4;', 'let originalName = 4;'), false),
    ]);
    expect(JSON.parse(gunzipSync(fs.readFileSync(archive)).toString())).toHaveLength(4);
    const incomplete = bundle('let a=5;', '');
    (incomplete['app.js'] as { map: unknown }).map = null;
    await expect(generate({}, incomplete, false)).rejects.toThrow('no complete original sources');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

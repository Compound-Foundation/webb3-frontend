// Development minification changes local names and whitespace, while retaining code and original sources.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import type { Plugin } from 'vite';

const compressArchive = promisify(gzip);

/** The minifier requires both development flags to equal 1. */
export function devMinificationOf(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.BROWSER_TEST_MINIFY_DEV;
  if (value === undefined || value === '' || value === '0') return false;
  if (value !== '1') throw new Error('BROWSER_TEST_MINIFY_DEV must be 0 or 1.');
  if (env.BROWSER_TEST_BUNDLED_DEV !== '1') {
    throw new Error('BROWSER_TEST_MINIFY_DEV=1 requires BROWSER_TEST_BUNDLED_DEV=1.');
  }
  return true;
}

/**
 * Vite disables bundled-dev minification before this public hook runs. The plugin changes neither branches
 * nor property names. Each archive snapshot retains earlier chunk versions and their original sources.
 */
export function minifyDev(sourceMapsFile: string): Plugin {
  const versions = new Map<string, string>();
  const generatedSources = new Map<string, string>();
  let archiveWrite = Promise.resolve();
  return {
    name: 'cf-harness-minify-dev',
    apply: 'serve',
    outputOptions(options) {
      return {
        ...options,
        keepNames: true,
        minify: {
          compress: false,
          mangle: { keepNames: true },
          codegen: { removeWhitespace: true, legalComments: 'inline' },
        },
        sourcemap: true,
        sourcemapExcludeSources: false,
      };
    },
    renderChunk(code, chunk) {
      if (chunk.moduleIds.length === 1 && chunk.moduleIds[0] === '\0rolldown/runtime.js') {
        generatedSources.set(chunk.moduleIds[0], code);
      }
      return null;
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        archiveWrite = archiveWrite.then(async () => {
          for (const chunk of Object.values(bundle)) {
            if (chunk.type !== 'chunk') continue;
            const map = chunk.map;
            const generatedSource = chunk.moduleIds.length === 1 ? generatedSources.get(chunk.moduleIds[0]) : undefined;
            if (
              generatedSource === undefined &&
              (map === null ||
                map.sourcesContent?.length !== map.sources.length ||
                map.sourcesContent.some((source) => typeof source !== 'string'))
            ) {
              throw new Error(`Development chunk ${chunk.fileName} has no complete original sources.`);
            }
            const generatedCodeSha256 = crypto.createHash('sha256').update(chunk.code).digest('hex');
            const record = JSON.stringify({
              fileName: chunk.fileName,
              generatedCodeSha256,
              generatedCodeBytes: Buffer.byteLength(chunk.code),
              map,
              ...(generatedSource === undefined ? {} : { generatedSource }),
            });
            const version = crypto.createHash('sha256').update(record).digest('hex');
            versions.set(version, record);
          }
          // A failed test copies one complete snapshot. Later chunks leave earlier maps in the snapshot.
          const snapshot = await compressArchive(`[${[...versions.values()].join(',')}]`);
          const temporaryFile = `${sourceMapsFile}.next`;
          await fs.promises.writeFile(temporaryFile, snapshot, { mode: 0o600 });
          await fs.promises.rename(temporaryFile, sourceMapsFile);
        });
        return archiveWrite;
      },
    },
  };
}

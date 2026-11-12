// Tests for the production React check: the marker evidence against the installed React and ReactDOM,
// the scanner on matching and clean input, and the command's exit status and diagnostics.
//
//   yarn test:production-react-check
//
// `yarn test` runs them too, through `__tests__/scripts/productionReactCheck.test.ts`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkProductionReact,
  DEVELOPMENT_REACT_MARKERS,
  findDevelopmentReactMarkers,
  scanForDevelopmentReact,
} from '../development-react.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const COMMAND = path.join(ROOT, 'scripts/check-production-react.js');

const MARKERS = DEVELOPMENT_REACT_MARKERS.map(({ marker }) => marker);
const CLEAN_CODE = 'function App(){return jsx("ul",{children:items.map(i=>jsx("li",{children:i},i.id))})}';

// Every file of a build flavour that React and ReactDOM ship, as paths below node_modules.
function reactBuildFiles(flavour) {
  return ['react/cjs', 'react-dom/cjs'].flatMap((directory) =>
    fs
      .readdirSync(path.join(NODE_MODULES, directory))
      .filter((name) => name.endsWith(`.${flavour}.js`))
      .map((name) => path.join(directory, name)),
  );
}

const temporaryDirectories = [];

function buildDirectory(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'production-react-check-'));
  temporaryDirectories.push(directory);
  for (const [file, code] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), code);
  }
  return directory;
}

function runCommand(directory) {
  return spawnSync(process.execPath, [COMMAND, directory], { cwd: ROOT, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('marker evidence', () => {
  test('React and ReactDOM ship both build flavours', () => {
    assert.ok(reactBuildFiles('production').includes('react/cjs/react.production.js'));
    assert.ok(reactBuildFiles('production').includes('react-dom/cjs/react-dom-client.production.js'));
  });

  for (const { marker, source } of DEVELOPMENT_REACT_MARKERS) {
    test(`"${marker}" is in ${source}`, () => {
      assert.ok(fs.readFileSync(path.join(NODE_MODULES, source), 'utf8').includes(marker));
    });

    test(`"${marker}" is in no production build of React or ReactDOM`, () => {
      const productionFilesWithMarker = reactBuildFiles('production').filter((file) =>
        fs.readFileSync(path.join(NODE_MODULES, file), 'utf8').includes(marker),
      );
      assert.deepEqual(productionFilesWithMarker, []);
    });
  }

  test('the development React and ReactDOM entry points that browsers load contain a marker', () => {
    for (const source of ['react/cjs/react.development.js', 'react-dom/cjs/react-dom-client.development.js']) {
      const code = fs.readFileSync(path.join(NODE_MODULES, source), 'utf8');
      assert.notDeepEqual(findDevelopmentReactMarkers(code), [], source);
    }
  });
});

describe('findDevelopmentReactMarkers', () => {
  test('finds no marker in clean code', () => {
    assert.deepEqual(findDevelopmentReactMarkers(CLEAN_CODE), []);
  });

  test('finds every marker in the code, in marker order', () => {
    const code = MARKERS.map((marker) => `console.error("${marker} %s")`)
      .reverse()
      .join(';');
    assert.deepEqual(findDevelopmentReactMarkers(code), MARKERS);
  });
});

describe('scanForDevelopmentReact', () => {
  test('reports each file and marker found below the directory', () => {
    const directory = buildDirectory({
      'assets/main.js': `${CLEAN_CODE};"${MARKERS[0]}";"${MARKERS[1]}"`,
      'assets/nested/chunk.mjs': `"${MARKERS[2]}"`,
      'assets/vendor.js': CLEAN_CODE,
    });
    assert.deepEqual(scanForDevelopmentReact(directory), {
      fileCount: 3,
      matches: [
        { file: path.join('assets', 'main.js'), marker: MARKERS[0] },
        { file: path.join('assets', 'main.js'), marker: MARKERS[1] },
        { file: path.join('assets', 'nested', 'chunk.mjs'), marker: MARKERS[2] },
      ],
    });
  });

  test('scans JavaScript files only', () => {
    const directory = buildDirectory({ 'index.html': `"${MARKERS[0]}"`, 'assets/main.js': CLEAN_CODE });
    assert.deepEqual(scanForDevelopmentReact(directory), { fileCount: 1, matches: [] });
  });
});

describe('checkProductionReact', () => {
  function check(directory) {
    const output = { log: [], error: [] };
    const status = checkProductionReact(directory, {
      log: (line) => output.log.push(line),
      error: (line) => output.error.push(line),
    });
    return { status, ...output };
  }

  test('passes a clean build', () => {
    const directory = buildDirectory({ 'assets/main.js': CLEAN_CODE });
    const result = check(directory);
    assert.equal(result.status, 0);
    assert.deepEqual(result.error, []);
    assert.match(result.log.join('\n'), /passed: 1 JavaScript files/);
  });

  test('fails a build that contains development React and names each file and marker', () => {
    const directory = buildDirectory({ 'assets/main.js': `"${MARKERS[1]}"`, 'assets/other.js': `"${MARKERS[2]}"` });
    const result = check(directory);
    assert.equal(result.status, 1);
    assert.deepEqual(result.log, []);
    const errors = result.error.join('\n');
    assert.ok(errors.includes(`${path.join(directory, 'assets', 'main.js')}: "${MARKERS[1]}"`), errors);
    assert.ok(errors.includes(`${path.join(directory, 'assets', 'other.js')}: "${MARKERS[2]}"`), errors);
  });

  test('fails when the directory is missing', () => {
    const directory = path.join(buildDirectory({}), 'dist');
    const result = check(directory);
    assert.equal(result.status, 1);
    assert.match(result.error.join('\n'), /is not a directory/);
  });

  test('fails when the directory holds no JavaScript', () => {
    const result = check(buildDirectory({ 'index.html': '<html></html>' }));
    assert.equal(result.status, 1);
    assert.match(result.error.join('\n'), /contains no JavaScript files/);
  });
});

describe('check-production-react command', () => {
  test('exits 0 on a clean build', () => {
    const run = runCommand(buildDirectory({ 'assets/main.js': CLEAN_CODE }));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Production React check passed/);
  });

  test('exits 1 on a build with a marker and names the file and marker on stderr', () => {
    const directory = buildDirectory({ 'assets/main-abc123.js': `${CLEAN_CODE};"${MARKERS[0]} %s"` });
    const run = runCommand(directory);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.ok(run.stderr.includes(`${path.join(directory, 'assets', 'main-abc123.js')}: "${MARKERS[0]}"`), run.stderr);
  });

  test('exits 1 when the build directory is missing', () => {
    const run = runCommand(path.join(buildDirectory({}), 'dist'));
    assert.equal(run.status, 1);
  });
});

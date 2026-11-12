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
  findStaleMarkers,
  installedPackageDirectory,
  PRODUCTION_REACT_MARKER,
  scanForDevelopmentReact,
} from '../development-react.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const COMMAND = path.join(ROOT, 'scripts/check-production-react.js');

const MARKERS = DEVELOPMENT_REACT_MARKERS.map(({ marker }) => marker);
// Application code with production ReactDOM's error reporting and no development React.
const CLEAN_CODE =
  'function App(){return jsx("ul",{children:items.map(i=>jsx("li",{children:i},i.id))})}' +
  `function formatProdErrorMessage(c){return"${PRODUCTION_REACT_MARKER.marker} #"+c}`;
const APPLICATION_CODE = 'function App(){return jsx("div",{})}';

// Every file of the given build flavours that React and ReactDOM ship, as paths below node_modules.
function reactBuildFiles(...flavours) {
  return ['react/cjs', 'react-dom/cjs'].flatMap((directory) =>
    fs
      .readdirSync(path.join(NODE_MODULES, directory))
      .filter((name) => flavours.some((flavour) => name.endsWith(`.${flavour}.js`)))
      .map((name) => path.join(directory, name))
  );
}

function filesContaining(files, marker) {
  return files.filter((file) => fs.readFileSync(path.join(NODE_MODULES, file), 'utf8').includes(marker));
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

// A stand-in for the installed packages: each marker's file holds that marker, except the markers left out.
function packagesWithout(...leftOut) {
  const files = {};
  for (const { marker, packageName, file } of [...DEVELOPMENT_REACT_MARKERS, PRODUCTION_REACT_MARKER]) {
    const source = path.join(packageName, file);
    files[source] = `${files[source] ?? ''}${leftOut.includes(marker) ? '' : `"${marker}";`}`;
  }
  const directory = buildDirectory(files);
  return (packageName) => path.join(directory, packageName);
}

function check(directory, options = {}) {
  const output = { log: [], error: [] };
  const status = checkProductionReact(directory, {
    ...options,
    log: (line) => output.log.push(line),
    error: (line) => output.error.push(line),
  });
  return { status, log: output.log, errors: output.error.join('\n') };
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
  test('React and ReactDOM ship development and production builds, which the check reads', () => {
    assert.ok(reactBuildFiles('production').includes('react/cjs/react.production.js'));
    assert.ok(reactBuildFiles('production').includes('react-dom/cjs/react-dom-client.production.js'));
    assert.ok(reactBuildFiles('development').includes('react-dom/cjs/react-dom-client.development.js'));
    assert.equal(installedPackageDirectory('react'), path.join(NODE_MODULES, 'react'));
    assert.equal(installedPackageDirectory('react-dom'), path.join(NODE_MODULES, 'react-dom'));
  });

  for (const { marker, packageName, file } of DEVELOPMENT_REACT_MARKERS) {
    test(`"${marker}" is in ${packageName}/${file}`, () => {
      assert.ok(fs.readFileSync(path.join(NODE_MODULES, packageName, file), 'utf8').includes(marker));
    });

    test(`"${marker}" is in no production or profiling build of React or ReactDOM`, () => {
      assert.deepEqual(filesContaining(reactBuildFiles('production', 'profiling'), marker), []);
    });
  }

  test(`"${PRODUCTION_REACT_MARKER.marker}" is in production ReactDOM and in no development build`, () => {
    const { marker, packageName, file } = PRODUCTION_REACT_MARKER;
    assert.ok(fs.readFileSync(path.join(NODE_MODULES, packageName, file), 'utf8').includes(marker));
    assert.deepEqual(filesContaining(reactBuildFiles('development'), marker), []);
  });

  test('the development React and ReactDOM entry points that browsers load contain a marker', () => {
    for (const source of ['react/cjs/react.development.js', 'react-dom/cjs/react-dom-client.development.js']) {
      const code = fs.readFileSync(path.join(NODE_MODULES, source), 'utf8');
      assert.notDeepEqual(findDevelopmentReactMarkers(code), [], source);
    }
  });
});

describe('findStaleMarkers', () => {
  test('finds no stale marker in the installed React and ReactDOM', () => {
    assert.deepEqual(findStaleMarkers(), []);
  });

  test('finds each marker that its file no longer holds', () => {
    const packageDirectory = packagesWithout(MARKERS[1], PRODUCTION_REACT_MARKER.marker);
    assert.deepEqual(findStaleMarkers(packageDirectory), [DEVELOPMENT_REACT_MARKERS[1], PRODUCTION_REACT_MARKER]);
  });

  test('finds each marker whose file is missing', () => {
    const directory = buildDirectory({});
    assert.deepEqual(
      findStaleMarkers((packageName) => path.join(directory, packageName)),
      [...DEVELOPMENT_REACT_MARKERS, PRODUCTION_REACT_MARKER]
    );
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
      'assets/main.js': `${APPLICATION_CODE};"${MARKERS[0]}";"${MARKERS[1]}"`,
      'assets/nested/chunk.mjs': `"${MARKERS[2]}"`,
      'assets/vendor.cjs': APPLICATION_CODE,
    });
    assert.deepEqual(scanForDevelopmentReact(directory), {
      fileCount: 3,
      matches: [
        { file: path.join('assets', 'main.js'), marker: MARKERS[0] },
        { file: path.join('assets', 'main.js'), marker: MARKERS[1] },
        { file: path.join('assets', 'nested', 'chunk.mjs'), marker: MARKERS[2] },
      ],
      hasProductionReact: false,
      symbolicLinks: [],
    });
  });

  test('finds production ReactDOM in any JavaScript file', () => {
    const directory = buildDirectory({ 'assets/main.js': APPLICATION_CODE, 'assets/react.js': CLEAN_CODE });
    assert.deepEqual(scanForDevelopmentReact(directory), {
      fileCount: 2,
      matches: [],
      hasProductionReact: true,
      symbolicLinks: [],
    });
  });

  test('scans JavaScript files only', () => {
    const directory = buildDirectory({ 'index.html': `"${MARKERS[0]}"`, 'assets/main.js': CLEAN_CODE });
    assert.deepEqual(scanForDevelopmentReact(directory), {
      fileCount: 1,
      matches: [],
      hasProductionReact: true,
      symbolicLinks: [],
    });
  });

  test('lists symbolic links without following them', () => {
    const outside = buildDirectory({ 'react.js': `"${MARKERS[0]}"` });
    const directory = buildDirectory({ 'assets/main.js': CLEAN_CODE });
    fs.symlinkSync(outside, path.join(directory, 'assets', 'linked'));
    fs.symlinkSync(path.join(outside, 'react.js'), path.join(directory, 'react.js'));
    fs.symlinkSync('..', path.join(directory, 'assets', 'loop'));
    assert.deepEqual(scanForDevelopmentReact(directory), {
      fileCount: 1,
      matches: [],
      hasProductionReact: true,
      symbolicLinks: [path.join('assets', 'linked'), path.join('assets', 'loop'), 'react.js'],
    });
  });
});

describe('checkProductionReact', () => {
  test('passes a build with production React and no development React', () => {
    const result = check(buildDirectory({ 'assets/main.js': CLEAN_CODE }));
    assert.equal(result.status, 0);
    assert.equal(result.errors, '');
    assert.match(result.log.join('\n'), /passed: 1 JavaScript files/);
  });

  test('fails a build that contains development React and names each file and marker', () => {
    const directory = buildDirectory({
      'assets/main.js': `${CLEAN_CODE};"${MARKERS[1]}"`,
      'assets/other.js': `"${MARKERS[2]}"`,
    });
    const result = check(directory);
    assert.equal(result.status, 1);
    assert.deepEqual(result.log, []);
    assert.ok(result.errors.includes(`${path.join(directory, 'assets', 'main.js')}: "${MARKERS[1]}"`), result.errors);
    assert.ok(result.errors.includes(`${path.join(directory, 'assets', 'other.js')}: "${MARKERS[2]}"`), result.errors);
  });

  test('fails a build without production ReactDOM', () => {
    const result = check(buildDirectory({ 'assets/main.js': APPLICATION_CODE }));
    assert.equal(result.status, 1);
    assert.deepEqual(result.log, []);
    assert.ok(
      result.errors.includes(`contains production ReactDOM's "${PRODUCTION_REACT_MARKER.marker}"`),
      result.errors
    );
  });

  test('fails before scanning when a marker is stale, and names the marker and file', () => {
    const [stale] = DEVELOPMENT_REACT_MARKERS;
    const result = check(buildDirectory({ 'assets/main.js': CLEAN_CODE }), {
      packageDirectory: packagesWithout(stale.marker),
    });
    assert.equal(result.status, 1);
    assert.deepEqual(result.log, []);
    assert.ok(result.errors.includes(`"${stale.marker}" is not in ${stale.packageName}/${stale.file}`), result.errors);
    assert.equal(result.errors.match(/ is not in /g).length, 1, result.errors);
  });

  test('fails a build that contains a symbolic link and names it', () => {
    const directory = buildDirectory({ 'assets/main.js': CLEAN_CODE });
    fs.symlinkSync(buildDirectory({}), path.join(directory, 'assets', 'linked'));
    const result = check(directory);
    assert.equal(result.status, 1);
    assert.deepEqual(result.log, []);
    assert.ok(result.errors.includes(path.join(directory, 'assets', 'linked')), result.errors);
  });

  test('fails when the directory is missing', () => {
    const result = check(path.join(buildDirectory({}), 'dist'));
    assert.equal(result.status, 1);
    assert.match(result.errors, /is not a directory/);
  });

  test('fails when the directory holds no JavaScript', () => {
    const result = check(buildDirectory({ 'index.html': '<html></html>' }));
    assert.equal(result.status, 1);
    assert.match(result.errors, /contains no JavaScript files/);
  });
});

describe('check-production-react command', () => {
  test('exits 0 on a build with production React and no development React', () => {
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
    assert.match(run.stderr, /is not a directory/);
  });
});

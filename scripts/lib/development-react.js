// Finds React's development build in built JavaScript.
//
// Each marker is a message that React or ReactDOM logs only from its development build. The production
// builds drop these messages, so a bundle that contains one of them ships development React. The source
// names the development file in React 19.2 that holds the marker. The tests check each marker against the
// installed React and ReactDOM: present in that development file, absent from every production file.

import fs from 'fs';
import path from 'path';

export const DEVELOPMENT_REACT_MARKERS = [
  {
    marker: 'Each child in a list should have a unique',
    source: 'react-dom/cjs/react-dom-client.development.js',
  },
  {
    marker: 'Referentially unequal but deeply equal',
    source: 'react-dom/cjs/react-dom-client.development.js',
  },
  {
    marker: 'Accessing element.ref was removed in React 19',
    source: 'react/cjs/react.development.js',
  },
];

const JAVASCRIPT_FILE = /\.[cm]?js$/;

// Returns the markers that appear in the code, in marker order.
export function findDevelopmentReactMarkers(code) {
  return DEVELOPMENT_REACT_MARKERS.map(({ marker }) => marker).filter((marker) => code.includes(marker));
}

// Returns the paths of the JavaScript files below the directory, relative to it and sorted.
export function listJavaScriptFiles(directory) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && JAVASCRIPT_FILE.test(entry.name))
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort();
}

// Scans every JavaScript file below the directory. Returns the number of files scanned and one match for
// each file and marker found.
export function scanForDevelopmentReact(directory) {
  const files = listJavaScriptFiles(directory);
  const matches = files.flatMap((file) =>
    findDevelopmentReactMarkers(fs.readFileSync(path.join(directory, file), 'utf8')).map((marker) => ({
      file,
      marker,
    })),
  );
  return { fileCount: files.length, matches };
}

// Checks a build directory and writes the result. Returns the exit status: 0 when the directory holds
// JavaScript and none of it contains a marker, otherwise 1. A missing directory or one without JavaScript
// fails, because then nothing was checked.
export function checkProductionReact(directory, { log = console.log, error = console.error } = {}) {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    error(`Production React check failed: ${directory} is not a directory.`);
    return 1;
  }
  const { fileCount, matches } = scanForDevelopmentReact(directory);
  if (fileCount === 0) {
    error(`Production React check failed: ${directory} contains no JavaScript files.`);
    return 1;
  }
  if (matches.length > 0) {
    error(`Production React check failed: the build in ${directory} contains development React.`);
    for (const { file, marker } of matches) {
      error(`  ${path.join(directory, file)}: "${marker}"`);
    }
    error('Production builds must replace process.env.NODE_ENV with "production" before bundling React.');
    return 1;
  }
  log(`Production React check passed: ${fileCount} JavaScript files in ${directory}, no development React markers.`);
  return 0;
}

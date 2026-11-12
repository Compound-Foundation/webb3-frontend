// Finds React's development build in built JavaScript.
//
// Each development marker is a message that React or ReactDOM logs only from its development build. The
// production builds drop these messages, so a bundle that contains one of them ships development React.
// The production marker is the opposite: production ReactDOM reports errors with it in place of the
// development messages, so a bundle with production ReactDOM contains it.
//
// Each marker names the file of the installed package that holds it. Before it scans, the check confirms
// that each file still holds its marker, so a React upgrade that rewords a message fails the check instead
// of letting it pass on a marker no build contains. The tests also check that no production file of React
// or ReactDOM contains a development marker, and no development file contains the production marker.

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

export const DEVELOPMENT_REACT_MARKERS = [
  {
    marker: 'Each child in a list should have a unique',
    packageName: 'react-dom',
    file: 'cjs/react-dom-client.development.js',
  },
  {
    marker: 'Referentially unequal but deeply equal',
    packageName: 'react-dom',
    file: 'cjs/react-dom-client.development.js',
  },
  {
    marker: 'Accessing element.ref was removed in React 19',
    packageName: 'react',
    file: 'cjs/react.development.js',
  },
];

export const PRODUCTION_REACT_MARKER = {
  marker: 'Minified React error',
  packageName: 'react-dom',
  file: 'cjs/react-dom-client.production.js',
};

const JAVASCRIPT_FILE = /\.[cm]?js$/;

const require = createRequire(import.meta.url);

// Returns the directory of the installed package. React's package exports hide its build files, so this
// resolves the package's package.json, which they expose.
export function installedPackageDirectory(packageName) {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

// Returns the development and production markers whose file is missing or no longer holds the marker.
export function findStaleMarkers(packageDirectory = installedPackageDirectory) {
  return [...DEVELOPMENT_REACT_MARKERS, PRODUCTION_REACT_MARKER].filter(({ marker, packageName, file }) => {
    const source = path.join(packageDirectory(packageName), file);
    return !fs.existsSync(source) || !fs.readFileSync(source, 'utf8').includes(marker);
  });
}

// Returns the markers that appear in the code, in marker order.
export function findDevelopmentReactMarkers(code) {
  return DEVELOPMENT_REACT_MARKERS.map(({ marker }) => marker).filter((marker) => code.includes(marker));
}

// Lists the files below the directory without following symbolic links. Returns the JavaScript files and
// the symbolic links, as paths relative to the directory, each sorted.
function listBuildFiles(directory, subdirectory = '') {
  const listing = { javaScriptFiles: [], symbolicLinks: [] };
  for (const entry of fs.readdirSync(path.join(directory, subdirectory), { withFileTypes: true })) {
    const file = path.join(subdirectory, entry.name);
    if (entry.isSymbolicLink()) {
      listing.symbolicLinks.push(file);
    } else if (entry.isDirectory()) {
      const nested = listBuildFiles(directory, file);
      listing.javaScriptFiles.push(...nested.javaScriptFiles);
      listing.symbolicLinks.push(...nested.symbolicLinks);
    } else if (entry.isFile() && JAVASCRIPT_FILE.test(entry.name)) {
      listing.javaScriptFiles.push(file);
    }
  }
  listing.javaScriptFiles.sort();
  listing.symbolicLinks.sort();
  return listing;
}

// Scans every JavaScript file below the directory. Returns the number of files scanned, one match for each
// file and development marker found, whether any file holds the production marker, and the symbolic links
// found, which it does not follow.
export function scanForDevelopmentReact(directory) {
  const { javaScriptFiles, symbolicLinks } = listBuildFiles(directory);
  let hasProductionReact = false;
  const matches = javaScriptFiles.flatMap((file) => {
    const code = fs.readFileSync(path.join(directory, file), 'utf8');
    hasProductionReact ||= code.includes(PRODUCTION_REACT_MARKER.marker);
    return findDevelopmentReactMarkers(code).map((marker) => ({ file, marker }));
  });
  return { fileCount: javaScriptFiles.length, matches, hasProductionReact, symbolicLinks };
}

// Checks a build directory and writes the result. Returns the exit status: 0 when every marker is still in
// its file, the directory holds JavaScript, none of it contains a development marker and some of it contains
// the production marker, otherwise 1. A stale marker, a missing directory, a directory without JavaScript or
// without production React, or a symbolic link in the build fails, because then the check proves nothing.
export function checkProductionReact(
  directory,
  { packageDirectory = installedPackageDirectory, log = console.log, error = console.error } = {}
) {
  const staleMarkers = findStaleMarkers(packageDirectory);
  if (staleMarkers.length > 0) {
    error('Production React check failed: the installed React no longer holds these markers.');
    for (const { marker, packageName, file } of staleMarkers) {
      error(`  "${marker}" is not in ${packageName}/${file}`);
    }
    error('Choose markers that the installed React holds and update scripts/lib/development-react.js.');
    return 1;
  }
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    error(`Production React check failed: ${directory} is not a directory.`);
    return 1;
  }
  const { fileCount, matches, hasProductionReact, symbolicLinks } = scanForDevelopmentReact(directory);
  if (symbolicLinks.length > 0) {
    error(
      `Production React check failed: the build in ${directory} contains symbolic links, which it does not follow.`
    );
    for (const file of symbolicLinks) {
      error(`  ${path.join(directory, file)}`);
    }
    return 1;
  }
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
  if (!hasProductionReact) {
    error(
      `Production React check failed: no JavaScript file in ${directory} contains production ReactDOM's ` +
        `"${PRODUCTION_REACT_MARKER.marker}".`
    );
    return 1;
  }
  log(
    `Production React check passed: ${fileCount} JavaScript files in ${directory}, production React and no development React markers.`
  );
  return 0;
}

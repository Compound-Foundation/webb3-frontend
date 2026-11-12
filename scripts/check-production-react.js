#!/usr/bin/env node
// Fails the build when the built JavaScript contains React's development build. `yarn build` runs it on
// `dist` after Vite finishes, so a local build and CI apply the same check before anything deploys.
//
// Usage: node scripts/check-production-react.js [build directory, default dist]

import { checkProductionReact } from './lib/development-react.js';

process.exitCode = checkProductionReact(process.argv[2] ?? 'dist');

'use strict';

const path = require('path');

const fs = require('fs-extra');

const appDirectory = fs.realpathSync(process.cwd());
const resolveApp = (relativePath) => path.resolve(appDirectory, relativePath);
const publicPath = resolveApp('./public');
const stylesPath = resolveApp('./node_modules/compound-styles/public');

// Copy compound-styles public contents
fs.copySync(stylesPath, publicPath, {
  dereference: true,
});

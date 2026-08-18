// Jest transformer for react-router 8+, which ships ESM-only.
//
// ts-jest can't be used here: for .js files under node_modules it takes a
// fast path (ts.transpileModule without custom AST transformers), so the
// ts-jest-mock-import-meta transformer never runs and the `import.meta.hot`
// reference in react-router's dist throws a SyntaxError under CJS.
const crypto = require('crypto');
const ts = require('typescript');
const importMetaMock = require('ts-jest-mock-import-meta');

const TRANSFORM_VERSION = '2';

const compilerOptions = {
  allowJs: true,
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
  esModuleInterop: true,
};

module.exports = {
  process(sourceText, sourcePath) {
    const { outputText } = ts.transpileModule(sourceText, {
      // TypeScript refuses to emit CJS for .mjs files, so present them as .js
      fileName: sourcePath.replace(/\.mjs$/, '.js'),
      compilerOptions,
      transformers: {
        before: [importMetaMock.factory({}, { metaObjectReplacement: { hot: false } })],
      },
    });
    return { code: outputText };
  },
  getCacheKey(sourceText, sourcePath) {
    return crypto
      .createHash('sha1')
      .update(TRANSFORM_VERSION)
      .update('\0', 'utf8')
      .update(sourceText)
      .update('\0', 'utf8')
      .update(sourcePath)
      .digest('hex');
  },
};

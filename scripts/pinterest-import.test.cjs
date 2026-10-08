const assert = require('node:assert/strict');
const esbuild = require('esbuild');

const bundle = esbuild.buildSync({
  entryPoints: ['src/extension/pinterest-import-policy.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false,
});
const policyModule = { exports: {} };
new Function('module', 'exports', bundle.outputFiles[0].text)(policyModule, policyModule.exports);
const { hasExtractionProgress, isBoardComplete, PINTEREST_IMPORT_LIMIT } = policyModule.exports;

// Virtualized boards can load more pins without increasing the document height.
assert.equal(hasExtractionProgress(2000, 2000, 400, 425), true);
assert.equal(hasExtractionProgress(2000, 2200, 400, 400), true);
assert.equal(hasExtractionProgress(2000, 2000, 400, 400), false);
// A board with 15% missing must never be reported complete.
assert.equal(isBoardComplete(850, 1000), false);
assert.equal(isBoardComplete(999, 1000), false);
assert.equal(isBoardComplete(1000, 1000), true);
assert.equal(isBoardComplete(1001, 1000), true);
assert.equal(isBoardComplete(1000, null), false);
assert.ok(PINTEREST_IMPORT_LIMIT > 2000);
console.log('Pinterest import progress and completion checks passed.');

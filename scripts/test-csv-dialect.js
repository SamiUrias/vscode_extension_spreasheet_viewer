const assert = require('node:assert/strict');
const { delimiterForCsvResource, delimiterForLanguageId, isStdinTempPath, isSupportedCsvLanguageId } = require('../out/csv-dialect.js');

assert.equal(delimiterForLanguageId('csv'), undefined, 'generic CSV retains automatic delimiter detection');
assert.equal(delimiterForLanguageId('csv (semicolon)'), ';');
assert.equal(delimiterForLanguageId('CSV_Semicolon'), ';');
assert.equal(delimiterForLanguageId('csv (pipe)'), '|');
assert.equal(delimiterForLanguageId('tsv'), '\t');
assert.equal(delimiterForLanguageId('plaintext'), undefined);
assert.equal(delimiterForCsvResource('/tmp/input.tab', 'csv (pipe)'), '\t', 'TSV/TAB filename has priority over language id');
assert.equal(delimiterForCsvResource('/tmp/input.csv', 'csv (semicolon)'), ';');
assert.equal(delimiterForCsvResource('/tmp/input', 'csv (pipe)'), '|');
assert.equal(isSupportedCsvLanguageId('csv (semicolon)'), true);
assert.equal(isSupportedCsvLanguageId('plaintext'), false);
assert.equal(isStdinTempPath('/tmp/code-stdin123', '/tmp'), true);
assert.equal(isStdinTempPath('/tmp/other-file', '/tmp'), false);
assert.equal(isStdinTempPath('/tmp/nested/code-stdin123', '/tmp'), false);
console.log('CSV dialect tests passed');

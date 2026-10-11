const assert = require('node:assert/strict');
const { isDocumentMutationMessageType, isWritableFileSystem } = require('../out/filesystem-capability.js');

assert.equal(isWritableFileSystem(true), true);
assert.equal(isWritableFileSystem(false), false);
assert.equal(isWritableFileSystem(undefined), false, 'unknown schemes fail closed');
for (const type of ['editCell', 'editFormula', 'editCells', 'csvRowOperation', 'xlsxStructureOperation', 'moveCells', 'history', 'draftState']) {
	assert.equal(isDocumentMutationMessageType(type), true, `${type} mutates document state`);
}
for (const type of ['ready', 'copyToClipboard', 'selectSheet', 'setSort', 'persistViewState', 'requestSnapshot', 'reloadFile']) {
	assert.equal(isDocumentMutationMessageType(type), false, `${type} is not a document mutation`);
}
console.log('Filesystem capability tests passed');

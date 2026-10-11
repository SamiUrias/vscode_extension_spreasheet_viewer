const assert = require('node:assert/strict');
const Module = require('node:module');

const errorMessages = [];
const vscode = {
	CancellationError: class CancellationError extends Error {},
	Uri: { joinPath: (base, ...segments) => ({ ...base, path: `${base.path}/${segments.join('/')}` }) },
	workspace: {
		fs: { isWritableFileSystem: () => true },
		getConfiguration: () => ({ get: (_key, fallback) => fallback }),
	},
	window: { showErrorMessage: async message => {errorMessages.push(message);} },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
	if (request === 'vscode') {return vscode;}
	return originalLoad.call(this, request, parent, isMain);
};
const { SpreadsheetDocument } = require('../out/document.js');
const { SpreadsheetEditorProvider } = require('../out/editor.js');
Module._load = originalLoad;

const uri = { scheme: 'file', path: '/test/edit-batch.csv', fsPath: '/test/edit-batch.csv', toString: () => 'file:///test/edit-batch.csv' };
const source = Buffer.from('name,value\nfirst,1\nsecond,2\n');
const document = SpreadsheetDocument.fromBytes(uri, source);
let receiveMessage;
const panel = {
	onDidDispose: () => ({ dispose() {} }),
	webview: {
		postMessage: async () => true,
		onDidReceiveMessage: listener => {receiveMessage = listener; return { dispose() {} };},
	},
};
const provider = Object.create(SpreadsheetEditorProvider.prototype);
provider.extensionUri = { path: '/extension' };
provider.workspaceState = { get: () => undefined, update: async () => undefined };
provider.documents = new Map();
provider.panels = new Map();
provider.panelListeners = new Map();
provider.panelDrafts = new Map();
provider.draftTransactions = new Map();
provider.draftCaptureWaiters = new Map();
provider.formulaSnapshots = new WeakMap();
provider.formulaSnapshotsSent = new WeakMap();
provider.activeSheets = new WeakMap();
provider.emitter = { fire: event => {provider.lastEditEvent = event;} };
provider.output = { appendLine() {} };
provider.viewStates = { write: () => true, remove() {} };
provider.watchDocument = () => {};
provider.disposeWatcher = () => {};
provider.getHtml = () => '<html></html>';
provider.postSaveState = () => {};
provider.postDocument = () => {};
provider.scheduleSave = () => {};
provider.hasPendingDraft = () => false;

provider.resolveCustomEditor(document, panel);
assert.equal(typeof receiveMessage, 'function', 'the custom editor must register its incoming message handler');

receiveMessage({ type: 'editCells', documentId: document.documentId, revision: document.revision,
	sheetIndex: 0, sheetId: document.sheetId(0), edits: [
		{ row: 1, column: 1, value: '10' }, { row: 2, column: 1, value: '20' },
	] });
assert.deepEqual(document.editSession.getRows(0), [['name', 'value'], ['first', '10'], ['second', '20']]);
assert.equal(typeof provider.lastEditEvent?.undo, 'function', 'one batch creates one host undo event');
provider.lastEditEvent.undo();
assert.deepEqual(document.editSession.getRows(0), [['name', 'value'], ['first', '1'], ['second', '2']]);
provider.lastEditEvent.redo();
assert.deepEqual(document.editSession.getRows(0), [['name', 'value'], ['first', '10'], ['second', '20']]);

const afterValidBatch = document.editSession.getRows(0);
receiveMessage({ type: 'editCells', documentId: document.documentId, revision: document.revision,
	sheetIndex: 0, sheetId: document.sheetId(0), edits: [
		{ row: 1, column: 1, value: '30' }, { row: 99, column: 1, value: 'out of range' },
	] });
assert.deepEqual(document.editSession.getRows(0), afterValidBatch, 'an invalid target rejects the entire batch atomically');
assert.ok(errorMessages.some(message => message.includes('No se pudo aplicar la edición')));

receiveMessage({ type: 'editCells', documentId: document.documentId, revision: document.revision - 1,
	sheetIndex: 0, sheetId: document.sheetId(0), edits: [{ row: 1, column: 1, value: 'stale' }] });
assert.deepEqual(document.editSession.getRows(0), afterValidBatch, 'a stale clipboard message must not edit the document');
console.log('Host edit batch tests passed: atomic apply, one undo/redo event, invalid target, and stale revision');

const assert = require('node:assert/strict');
const Module = require('node:module');

const errorMessages = [];
const warningMessages = [];
let firstRowHeaderSetting = true;
const vscode = {
	CancellationError: class CancellationError extends Error {},
	Uri: { joinPath: (base, ...segments) => ({ ...base, path: `${base.path}/${segments.join('/')}` }) },
	workspace: {
		fs: { isWritableFileSystem: () => true },
		getConfiguration: () => ({ get: (key, fallback) => key === 'firstRowHeader' ? firstRowHeaderSetting : fallback }),
	},
	window: {
		showErrorMessage: async message => {errorMessages.push(message);},
		showWarningMessage: async (message, ...choices) => {
			warningMessages.push(message);
			return choices.includes('Eliminar') ? 'Eliminar' : undefined;
		},
	},
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
const panelMessages = [];
const panel = {
	onDidDispose: () => ({ dispose() {} }),
	webview: {
		postMessage: async message => {
			panelMessages.push(message);
			if (message.type === 'captureDraft') {
				queueMicrotask(() => receiveMessage({ type: 'draftCaptureResult', requestId: message.requestId }));
			}
			return true;
		},
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
provider.nextDraftCaptureId = 1;
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

async function testCsvRowActions() {
	const waitForRows = async expected => {
		for (let attempt = 0; attempt < 20; attempt++) {
			if (JSON.stringify(document.editSession.getRows(0)) === JSON.stringify(expected)) {return;}
			await new Promise(resolve => setImmediate(resolve));
		}
		assert.deepEqual(document.editSession.getRows(0), expected);
	};
	const originalRows = document.editSession.getRows(0);
	receiveMessage({ type: 'csvRowOperation', kind: 'delete', documentId: document.documentId, revision: document.revision,
		sheetId: document.sheetId(0), rows: [0] });
	assert.deepEqual(document.editSession.getRows(0), originalRows, 'the configured CSV header cannot be deleted');
	assert.ok(errorMessages.some(message => message.includes('No se puede eliminar la fila de encabezados CSV')));
	receiveMessage({ type: 'csvRowOperation', kind: 'insert', documentId: document.documentId, revision: document.revision,
		sheetId: document.sheetId(0), index: 2 });
	await waitForRows([['name', 'value'], ['first', '10'], ['', ''], ['second', '20']]);
	assert.ok(panelMessages.some(message => message.type === 'focusCell' && message.row === 2 && message.column === 0), 'insert focuses the new row');
	const insertEvent = provider.lastEditEvent;
	insertEvent.undo();
	assert.deepEqual(document.editSession.getRows(0), originalRows);
	insertEvent.redo();
	assert.equal(document.editSession.getRows(0)[2][0], '');

	receiveMessage({ type: 'csvRowOperation', kind: 'delete', documentId: document.documentId, revision: document.revision,
		sheetId: document.sheetId(0), rows: [2] });
	await waitForRows([['name', 'value'], ['first', '10'], ['second', '20']]);
	assert.ok(warningMessages.some(message => message.includes('Eliminar 1 registro(s) CSV')), 'delete asks for explicit confirmation');
	const deleteEvent = provider.lastEditEvent;
	deleteEvent.undo();
	assert.equal(document.editSession.getRows(0)[2][0], '', 'undo restores the deleted row');
	firstRowHeaderSetting = false;
	receiveMessage({ type: 'csvRowOperation', kind: 'delete', documentId: document.documentId, revision: document.revision,
		sheetId: document.sheetId(0), rows: [0] });
	await waitForRows([['first', '10'], ['', ''], ['second', '20']]);
	provider.lastEditEvent.undo();
	assert.deepEqual(document.editSession.getRows(0), [['name', 'value'], ['first', '10'], ['', ''], ['second', '20']], 'disabling firstRowHeader allows deleting the first record');
}

testCsvRowActions().then(() => {
	console.log('Host edit tests passed: cell batch undo/redo, stale/invalid rejection, CSV row confirmation, focus, and undo/redo');
}).catch(error => {console.error(error); process.exitCode = 1;});

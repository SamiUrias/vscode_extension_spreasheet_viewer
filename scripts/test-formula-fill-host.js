const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');

async function main() {
	const root = path.resolve(__dirname, '..');
	const parserModule = await import(pathToFileURL(path.join(root, 'dist/formula-parser-node.mjs')).href);
	const parser = await parserModule.createFormulaParserService();
	const warnings = [];
	const errors = [];
	let promptResponse;
	let receiveMessage;
	const postedMessages = [];
	const vscode = {
		CancellationError: class CancellationError extends Error {},
		Uri: { joinPath: (base, ...segments) => ({ ...base, path: `${base.path}/${segments.join('/')}` }) },
		workspace: {
			fs: { isWritableFileSystem: () => true },
			getConfiguration: () => ({ get: (_key, fallback) => fallback }),
		},
		window: {
			showWarningMessage: async (message, ...choices) => {warnings.push({ message, choices }); return promptResponse;},
			showErrorMessage: async message => {errors.push(message);},
		},
	};
	const originalLoad = Module._load;
	Module._load = function(request, parent, isMain) {
		if (request === 'vscode') {return vscode;}
		if (request === './formula-parser-loader' && parent && path.basename(parent.filename) === 'editor.js'
			&& path.basename(path.dirname(parent.filename)) === 'out') {
			return { loadFormulaParserService: async () => parser };
		}
		return originalLoad.call(this, request, parent, isMain);
	};
	const { SpreadsheetDocument } = require('../out/document.js');
	const { SpreadsheetEditorProvider } = require('../out/editor.js');
	Module._load = originalLoad;

	const uri = {
		scheme: 'file', path: path.join(root, 'formula-fill.xlsx'), fsPath: path.join(root, 'formula-fill.xlsx'),
		toString: () => `file://${path.join(root, 'formula-fill.xlsx')}`,
	};
	const bytes = fs.readFileSync(path.join(root, 'src/test/fixtures/xlsx/formula_excel.xlsx'));
	const document = SpreadsheetDocument.fromBytes(uri, bytes);
	const sheetIndex = document.xlsx.sheets.findIndex(sheet => sheet.name === 'Calculos');
	assert.notEqual(sheetIndex, -1, 'the fixture must contain its calculation sheet');
	const sheetId = document.sheetId(sheetIndex);
	const originalDestination = document.editSession.getCell(sheetIndex, 2, 1).value;
	const originalSecondDestination = document.editSession.getCell(sheetIndex, 3, 1).value;
	assert.equal(await document.editSession.editFormulas([
		{ sheetIndex, row: 2, column: 1, formula: '=7+5' },
		{ sheetIndex, row: 3, column: 1, formula: '=9+9' },
	], parser) !== undefined, true, 'prepare a distinct destination value to verify overwrite and undo');

	const panel = {
		onDidDispose: () => ({ dispose() {} }),
		webview: {
			postMessage: async message => {postedMessages.push(message); return true;},
			onDidReceiveMessage: listener => {receiveMessage = listener; return { dispose() {} };},
		},
	};
	const provider = Object.create(SpreadsheetEditorProvider.prototype);
	provider.extensionUri = { path: root };
	provider.workspaceState = { get: () => undefined, update: async () => undefined };
	provider.documents = new Map(); provider.panels = new Map(); provider.panelListeners = new Map();
	provider.panelDrafts = new Map(); provider.draftTransactions = new Map(); provider.draftCaptureWaiters = new Map();
	provider.nextDraftCaptureId = 1; provider.formulaSnapshots = new WeakMap(); provider.formulaSnapshotsSent = new WeakMap();
	provider.activeSheets = new WeakMap(); provider.emitter = { fire: event => {provider.lastEditEvent = event; provider.editEventCount = (provider.editEventCount ?? 0) + 1;} };
	provider.output = { appendLine() {} }; provider.viewStates = { write: () => true, remove() {} };
	provider.watchDocument = () => {}; provider.disposeWatcher = () => {}; provider.getHtml = () => '<html></html>';
	provider.postSaveState = (_document, state) => {postedMessages.push(state);}; provider.postDocument = () => {};
	provider.scheduleSave = () => {provider.saveCount = (provider.saveCount ?? 0) + 1;};
	provider.saveOnCommit = () => true; provider.hasPendingDraft = () => false;
	provider.clearPendingDraftsForCells = () => {};
	provider.resolveCustomEditor(document, panel);
	assert.equal(typeof receiveMessage, 'function', 'the editor must register the webview message handler');

	const message = {
		type: 'fillFormulaRange', documentId: document.documentId, revision: document.revision,
		sheetId, sheetIndex, startRow: 1, startColumn: 1, endRow: 3, endColumn: 1, direction: 'down',
	};
	const waitFor = async predicate => {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (predicate()) {return;}
			await new Promise(resolve => setTimeout(resolve, 20));
		}
		assert.ok(predicate(), 'timed out waiting for formula-fill host handling');
	};

	promptResponse = undefined;
	receiveMessage(message);
	await waitFor(() => warnings.length === 1);
	await new Promise(resolve => setImmediate(resolve));
	assert.match(warnings[0].message, /Vista previa de 2 fórmulas/);
	assert.match(warnings[0].message, /B3 = =Datos!F3\*Datos!G3/);
	assert.equal(document.editSession.getCell(sheetIndex, 2, 1).value, '=7+5', 'canceling preview must not edit any cells');
	assert.equal(provider.editEventCount ?? 0, 0, 'canceling preview must not add host undo');

	promptResponse = 'Aplicar';
	message.revision = document.revision;
	receiveMessage(message);
	await waitFor(() => provider.editEventCount === 1 || errors.length > 0);
	assert.deepEqual(errors, [], `formula fill should apply without host errors: ${errors.join('; ')}`);
	assert.equal(document.editSession.getCell(sheetIndex, 2, 1).value, '=Datos!F3*Datos!G3');
	assert.equal(document.editSession.getCell(sheetIndex, 3, 1).value, '=Datos!F4*Datos!G4');
	assert.equal(provider.editEventCount, 1, 'the whole fill uses one host undo event');
	assert.equal(provider.saveCount, 1, 'an applied fill schedules one save');
	const filled = document.editSession.getCell(sheetIndex, 2, 1).value;
	provider.lastEditEvent.undo();
	assert.equal(document.editSession.getCell(sheetIndex, 2, 1).value, '=7+5', 'one undo restores the previous destination formula');
	assert.equal(document.editSession.getCell(sheetIndex, 3, 1).value, '=9+9', 'one undo restores the other destination formula');
	provider.lastEditEvent.redo();
	assert.equal(document.editSession.getCell(sheetIndex, 2, 1).value, filled);
	assert.equal(document.editSession.getCell(sheetIndex, 3, 1).value, '=Datos!F4*Datos!G4');

	const stable = document.editSession.getCell(sheetIndex, 2, 1).value;
	receiveMessage({ ...message, revision: document.revision - 1 });
	await waitFor(() => errors.length > 0);
	assert.equal(document.editSession.getCell(sheetIndex, 2, 1).value, stable, 'a stale fill request cannot mutate the workbook');
	assert.equal(originalDestination.startsWith('='), true);
	assert.equal(originalSecondDestination.startsWith('='), true);
	console.log('Formula fill host tests passed: preview cancel, relative references, one-step undo/redo, save, and stale revision rejection');
}

main().catch(error => {console.error(error); process.exitCode = 1;});

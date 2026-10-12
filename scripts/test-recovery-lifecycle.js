const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Module = require('node:module');

class FileUri {
	constructor(filePath) {
		this.fsPath = path.resolve(filePath);
		this.path = this.fsPath;
		this.scheme = 'file';
	}
	static file(filePath) {return new FileUri(filePath);}
	toString() {return pathToFileURL(this.fsPath).toString();}
	with(change) {return new FileUri(change.path);}
}

class CancellationError extends Error {}
class MockFileSystemError extends Error {
	constructor(code) {super(code); this.code = code;}
}
let warningChoice;
let warningActionIds = [];
let configuredSaveOnCommit;
const vscode = {
	CancellationError,
	FileSystemError: MockFileSystemError,
	FileType: { File: 1 },
	Uri: FileUri,
	workspace: {
		fs: {
			isWritableFileSystem: () => true,
			async readFile(uri) {
				try {return new Uint8Array(await readFile(uri.fsPath));}
				catch (error) {
					if (error.code === 'ENOENT') {throw new MockFileSystemError('FileNotFound');}
					throw error;
				}
			},
			async writeFile(uri, bytes) {await writeFile(uri.fsPath, bytes);},
			async createDirectory(uri) {await mkdir(uri.fsPath, { recursive: true });},
			async delete(uri) {await rm(uri.fsPath, { force: true, recursive: true });},
			async rename(source, destination) {await rename(source.fsPath, destination.fsPath);},
			async stat(uri) {
				const item = await stat(uri.fsPath);
				return { type: 1, size: item.size, ctime: item.ctimeMs, mtime: item.mtimeMs };
			},
		},
		getConfiguration: () => ({ get: (key, fallback) => key === 'saveOnCommit' && configuredSaveOnCommit !== undefined ? configuredSaveOnCommit : fallback }),
	},
	window: { showErrorMessage: async () => undefined, showWarningMessage: async (_message, ...items) => {
		warningActionIds = items.filter(item => item && typeof item === 'object' && typeof item.id === 'string').map(item => item.id);
		return warningChoice;
	} },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
	if (request === 'vscode') {return vscode;}
	return originalLoad.call(this, request, parent, isMain);
};

const tests = [];
let currentSuite = { beforeEach: [], afterEach: [] };
global.suite = (_name, run) => {
	const parentSuite = currentSuite;
	currentSuite = { beforeEach: [], afterEach: [] };
	try {run();} finally {currentSuite = parentSuite;}
};
global.setup = run => currentSuite.beforeEach.push(run);
global.teardown = run => currentSuite.afterEach.push(run);
global.test = (name, run) => tests.push({ name, run, beforeEach: [...currentSuite.beforeEach], afterEach: [...currentSuite.afterEach] });
require('../out/test/recovery.test.js');
require('../out/test/recovery-document.test.js');
const { SpreadsheetDocument } = require('../out/document.js');
const { SpreadsheetEditorProvider } = require('../out/editor.js');
const { parseRecoveryEnvelope } = require('../out/recovery.js');
Module._load = originalLoad;

async function testBackupCapturesCommittedBytesAndUnconfirmedDraft() {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'spreadsheet-backup-capture-'));
	const uri = FileUri.file(path.join(directory, 'data.csv'));
	const destination = FileUri.file(path.join(directory, 'recovery.bin'));
	const saveAsDestination = FileUri.file(path.join(directory, 'recovered.csv'));
	const baseline = Buffer.from('name,value\nfirst,1\n');
	const diskBefore = baseline.slice();
	await writeFile(uri.fsPath, baseline);
	const document = SpreadsheetDocument.fromBytes(uri, baseline);
	document.editCell(0, 1, 1, '9');
	const provider = Object.create(SpreadsheetEditorProvider.prototype);
	const panel = { webview: { postMessage: async message => {
		if (message.type === 'captureDraft') {
			provider.panelDrafts.set(panel, { type: 'draftState', dirty: true, documentId: document.documentId,
				revision: document.revision, sheetId: document.sheetId(0), sheetIndex: 0, row: 1, column: 0, value: 'unconfirmed' });
			provider.draftCaptureWaiters.get(message.requestId)?.resolve(true);
		}
		return true;
	} } };
	provider.panels = new Map([[uri.toString(), new Set([panel])]]);
	provider.panelDrafts = new Map();
	provider.draftTransactions = new Map();
	provider.draftCaptureWaiters = new Map();
	provider.nextDraftCaptureId = 1;
	let recovered;
	try {
		const backup = await provider.backupCustomDocument(document,
			{ destination }, { isCancellationRequested: false });
		const envelope = await parseRecoveryEnvelope(await readFile(destination.fsPath));
		assert.ok(envelope);
		assert.equal(envelope.uri, uri.toString());
		assert.deepEqual(Array.from(envelope.baselineBytes), Array.from(baseline));
		assert.deepEqual(Array.from(envelope.workingBytes), Array.from(Buffer.from('name,value\nfirst,9\n')));
		assert.deepEqual(envelope.draft, { sheetIndex: 0, row: 1, column: 0, value: 'unconfirmed' });
		assert.deepEqual(await readFile(uri.fsPath), diskBefore, 'creating a recovery backup does not alter the source file');
		assert.equal(backup.id, destination.toString());
		const external = Buffer.from('name,value\nexternal,2\n');
		await writeFile(uri.fsPath, external);
		recovered = await SpreadsheetDocument.restoreRecovery(uri, envelope);
		assert.equal(recovered.recoveryConflict, true);
		assert.deepEqual(Array.from(recovered.serializeCopy()), Array.from(envelope.workingBytes));
		const saveAsProvider = Object.create(SpreadsheetEditorProvider.prototype);
		saveAsProvider.confirmDraftsBeforeSave = async () => {};
		await saveAsProvider.saveCustomDocumentAs(recovered, saveAsDestination, { isCancellationRequested: false });
		assert.deepEqual(Array.from(await readFile(saveAsDestination.fsPath)), Array.from(envelope.workingBytes));
		assert.deepEqual(await readFile(uri.fsPath), external, 'Save As does not overwrite the externally changed source');
		assert.deepEqual(recovered.takeRecoveredDraft(), envelope.draft, 'the unconfirmed draft remains separate through Save As');
		console.log('Passed: backup captures baseline, working bytes, and a separate unconfirmed draft');
	} finally {
		document.dispose(); recovered?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

function createDraftDecisionProvider(document, draft) {
	const provider = Object.create(SpreadsheetEditorProvider.prototype);
	const panel = { webview: { postMessage: async () => true } };
	const transaction = { current: draft, active: true };
	const events = [];
	provider.panels = new Map([[document.uri.toString(), new Set([panel])]]);
	provider.panelDrafts = new Map([[panel, draft]]);
	provider.draftTransactions = new Map([[panel, transaction]]);
	provider.captureDrafts = async () => true;
	provider.emitter = { fire: event => events.push(event) };
	provider.postCellEditDelta = () => true;
	provider.postDocument = () => {};
	provider.postSaveState = () => {};
	provider.saveOnCommit = () => false;
	return { provider, panel, transaction, events };
}

async function testSaveDraftChoicesAndConfigurationDefault() {
	const bytes = Buffer.from('name,value\nfirst,1\n');
	const uri = FileUri.file('/test/save-draft.csv');
	const defaultCheck = Object.create(SpreadsheetEditorProvider.prototype);
	assert.equal(defaultCheck.saveOnCommit({ uri }), true, 'automatic save is the default');
	configuredSaveOnCommit = false;
	assert.equal(defaultCheck.saveOnCommit({ uri }), false, 'manual save mode can be selected');
	configuredSaveOnCommit = undefined;

	const makeDraft = document => ({ type: 'draftState', dirty: true, documentId: document.documentId,
		revision: document.revision, sheetId: document.sheetId(0), sheetIndex: 0, row: 1, column: 1, value: 'unconfirmed' });
	let document = SpreadsheetDocument.fromBytes(uri, bytes);
	let context = createDraftDecisionProvider(document, makeDraft(document));
	warningChoice = { id: 'save', title: 'Guardar solo cambios aplicados' };
	await context.provider.confirmDraftsBeforeSave(document);
	assert.deepEqual(warningActionIds, ['apply', 'save', 'cancel'], 'draft dialog exposes stable action IDs');
	assert.equal(document.editSession.getCell(0, 1, 1).value, '1', 'saving applied changes does not apply the draft');
	assert.equal(context.provider.panelDrafts.get(context.panel).value, 'unconfirmed', 'the unconfirmed draft remains available');
	assert.ok(context.events.some(event => event.label === 'Unconfirmed cell draft'), 'the pending draft remains visible to VS Code as dirty in the default English locale');
	document.dispose();

	document = SpreadsheetDocument.fromBytes(uri, bytes);
	context = createDraftDecisionProvider(document, makeDraft(document));
	warningChoice = { id: 'cancel', title: 'Cancelar' };
	await assert.rejects(context.provider.confirmDraftsBeforeSave(document), CancellationError);
	assert.equal(context.provider.panelDrafts.get(context.panel).value, 'unconfirmed', 'cancel keeps the draft');
	document.dispose();

	document = SpreadsheetDocument.fromBytes(uri, bytes);
	context = createDraftDecisionProvider(document, makeDraft(document));
	warningChoice = { id: 'apply', title: 'Aplicar borradores y guardar' };
	await context.provider.confirmDraftsBeforeSave(document);
	assert.equal(document.editSession.getCell(0, 1, 1).value, 'unconfirmed', 'apply-and-save commits the draft');
	assert.equal(context.provider.panelDrafts.has(context.panel), false, 'the committed draft is cleared');
	assert.equal(context.transaction.active, false);
	assert.equal(document.undo(), true, 'the applied draft is one undoable transaction');
	assert.equal(document.editSession.getCell(0, 1, 1).value, '1');
	document.dispose();
	warningChoice = undefined;
	console.log('Passed: Save confirms the draft policy, preserves cancellation, and defaults to auto-save');
}

async function main() {
	for (const test of tests) {
		for (const hook of test.beforeEach) {await hook();}
		try {
			await test.run();
			console.log(`Passed: ${test.name}`);
		} finally {
			for (const hook of test.afterEach) {await hook();}
		}
	}
	await testBackupCapturesCommittedBytesAndUnconfirmedDraft();
	await testSaveDraftChoicesAndConfigurationDefault();
}

main().catch(error => {console.error(error); process.exitCode = 1;});

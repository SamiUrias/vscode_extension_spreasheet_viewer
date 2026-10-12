const assert = require('node:assert/strict');
const Module = require('node:module');

class CancellationError extends Error {}
const vscode = {
	CancellationError,
	workspace: {
		fs: { isWritableFileSystem: () => true },
		getConfiguration: () => ({ get: (_key, fallback) => fallback }),
	},
	window: { showErrorMessage: async () => undefined },
};
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
	if (request === 'vscode') {return vscode;}
	return originalLoad.call(this, request, parent, isMain);
};

const { SpreadsheetDocument } = require('../out/document.js');
const { SpreadsheetEditorProvider } = require('../out/editor.js');
const { setLocalFileReplaceAdapter } = require('../out/storage.js');
Module._load = originalLoad;

const uri = {
	scheme: 'file',
	path: '/test/save-coordinator.csv',
	fsPath: '/test/save-coordinator.csv',
	toString: () => 'file:///test/save-coordinator.csv',
};
const initial = Buffer.from('name,value\nfirst,1\nsecond,2\n');
let disk = initial.slice();
let writeStarted;
let writeRelease;

setLocalFileReplaceAdapter(async (_uri, bytes, expected) => {
	if (writeStarted) {
		writeStarted();
		await new Promise(resolve => {writeRelease = resolve;});
	}
	if (expected && !disk.equals(Buffer.from(expected))) {
		const conflict = new Error('Disk bytes differ from the opened version.'); conflict.code = 'external-file-conflict'; throw conflict;
	}
	disk = Buffer.from(bytes);
});

function createProvider() {
	const provider = Object.create(SpreadsheetEditorProvider.prototype);
	provider.saveQueues = new WeakMap();
	provider.automaticSaveInFlight = new Set([uri.toString()]);
	provider.automaticSaveQueued = new Set();
	provider.automaticSaveCallbacks = new Map();
	provider.externalConflicts = new Map();
	provider.panels = new Map();
	provider.panelDrafts = new Map();
	provider.ownWrites = new WeakMap();
	provider.output = { appendLine() {} };
	provider.postSaveState = () => {};
	provider.scheduleSave = () => {provider.followUpSaves++;};
	provider.scheduleExternalCheck = () => {provider.externalChecks++;};
	provider.hasPendingDraft = () => false;
	provider.markPendingDraftsDirty = () => {};
	provider.confirmDraftsBeforeSave = async () => {};
	provider.followUpSaves = 0;
	provider.externalChecks = 0;
	return provider;
}

async function testEditDuringSaveSchedulesLatestRevision() {
	disk = initial.slice();
	const document = SpreadsheetDocument.fromBytes(uri, initial);
	const provider = createProvider();
	assert.notEqual(document.editCell(0, 1, 1, '10'), undefined);
	let resolveStarted;
	const started = new Promise(resolve => {resolveStarted = resolve;});
	writeStarted = resolveStarted;
	const save = provider.saveCustomDocument(document, { isCancellationRequested: false });
	await started;
	assert.notEqual(document.editCell(0, 2, 1, '20'), undefined);
	writeStarted = undefined;
	writeRelease();
	await save;
	assert.deepEqual(disk, Buffer.from('name,value\nfirst,10\nsecond,2\n'));
	assert.equal(provider.followUpSaves, 1, 'a newer revision is scheduled after the captured revision saves');
	assert.equal(document.hasUnsavedChanges, true, 'the newer revision remains dirty until its follow-up save');
	await provider.saveCustomDocument(document, { isCancellationRequested: false });
	assert.deepEqual(disk, Buffer.from('name,value\nfirst,10\nsecond,20\n'));
	assert.equal(document.hasUnsavedChanges, false);
	console.log('Passed: an edit during an in-flight save schedules and saves the newer revision');
}

async function testDiskConflictPreservesExternalBytesAndJournal() {
	disk = initial.slice();
	const document = SpreadsheetDocument.fromBytes(uri, initial);
	const provider = createProvider();
	assert.notEqual(document.editCell(0, 1, 1, '30'), undefined);
	let resolveStarted;
	const started = new Promise(resolve => {resolveStarted = resolve;});
	writeStarted = resolveStarted;
	const save = provider.saveCustomDocument(document, { isCancellationRequested: false });
	await started;
	const external = Buffer.from('name,value\nexternal,999\nsecond,2\n');
	disk = external.slice();
	writeStarted = undefined;
	writeRelease();
	await assert.rejects(save, error => error.code === 'external-file-conflict');
	assert.deepEqual(disk, external, 'a failed save does not replace the external file');
	assert.equal(document.editSession.getCell(0, 1, 1).value, '30', 'the conflicting local journal remains available');
	assert.deepEqual(document.sourceBytes, initial, 'the original baseline remains available');
	assert.equal(document.hasUnsavedChanges, true);
	assert.equal(provider.externalChecks, 1, 'the provider schedules an external-change check');
	console.log('Passed: a disk conflict preserves the external file, baseline, and local journal');
}

Promise.resolve()
	.then(testEditDuringSaveSchedulesLatestRevision)
	.then(testDiskConflictPreservesExternalBytesAndJournal)
	.catch(error => {console.error(error); process.exitCode = 1;});

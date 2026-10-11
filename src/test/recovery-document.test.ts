import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpreadsheetDocument } from '../document';
import type { RecoveryEnvelopeV1 } from '../recovery';

suite('recovery document restoration', () => {
	test('restores journal edits against the original baseline with one undo step and keeps the draft separate', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'spreadsheet-recovery-'));
		const uri = vscode.Uri.file(path.join(directory, 'data.csv'));
		const baseline = Buffer.from('name,value\nfirst,1\n');
		const working = Buffer.from('name,value\nfirst,9\n');
		await writeFile(uri.fsPath, baseline);
		const backup: RecoveryEnvelopeV1 = { uri: uri.toString(), baselineBytes: baseline, workingBytes: working,
			draft: { sheetIndex: 0, row: 1, column: 0, value: 'unconfirmed' } };
		let document: SpreadsheetDocument | undefined;
		try {
			document = await SpreadsheetDocument.restoreRecovery(uri, backup);
			assert.equal(document.recoveryConflict, false);
			assert.deepStrictEqual(document.editSession.getRows(0), [['name', 'value'], ['first', '9']]);
			assert.equal(document.hasUnsavedChanges, true);
			assert.deepStrictEqual(document.takeRecoveredDraft(), backup.draft);
			assert.equal(document.takeRecoveredDraft(), undefined);
			assert.equal(document.undo(), true);
			assert.deepStrictEqual(document.editSession.getRows(0), [['name', 'value'], ['first', '1']]);
		} finally {document?.dispose(); await rm(directory, { recursive: true, force: true });}
	});

	test('flags a changed disk baseline and preserves the recovered working copy for Save As', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'spreadsheet-recovery-conflict-'));
		const uri = vscode.Uri.file(path.join(directory, 'data.csv'));
		const baseline = Buffer.from('name,value\nfirst,1\n');
		const working = Buffer.from('name,value\nfirst,9\n');
		await writeFile(uri.fsPath, Buffer.from('name,value\nexternal,2\n'));
		let document: SpreadsheetDocument | undefined;
		try {
			document = await SpreadsheetDocument.restoreRecovery(uri, { uri: uri.toString(), baselineBytes: baseline, workingBytes: working });
			assert.equal(document.recoveryConflict, true);
			assert.deepStrictEqual(document.editSession.getRows(0), [['name', 'value'], ['first', '9']]);
			assert.deepStrictEqual(Buffer.from(document.serializeCopy()), working);
			assert.deepStrictEqual(await readFile(uri.fsPath), Buffer.from('name,value\nexternal,2\n'));
		} finally {document?.dispose(); await rm(directory, { recursive: true, force: true });}
	});
});

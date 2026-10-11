import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { zipSync } from 'fflate';
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

	test('restores a reversible XLSX structural snapshot from the working-copy backup', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'spreadsheet-recovery-xlsx-'));
		const uri = vscode.Uri.file(path.join(directory, 'data.xlsx'));
		const baseline = miniXlsx();
		await writeFile(uri.fsPath, baseline);
		let document: SpreadsheetDocument | undefined;
		let recovered: SpreadsheetDocument | undefined;
		try {
			document = SpreadsheetDocument.fromBytes(uri, baseline);
			await document.applyXlsxStructure({ kind: 'insertRows', sheetIndex: 0, index: 1, count: 1 });
			const working = document.serializeCopy();
			assert.equal(document.xlsx?.sheets[0]?.rowCount, 3);
			recovered = await SpreadsheetDocument.restoreRecovery(uri, { uri: uri.toString(), baselineBytes: baseline, workingBytes: working });
			assert.equal(recovered.recoveryConflict, false);
			assert.equal(recovered.xlsx?.sheets[0]?.rowCount, 3);
			assert.equal(recovered.hasUnsavedChanges, true);
			assert.deepStrictEqual(recovered.serializeCopy(), working);
			assert.equal(document.undo(), true);
			assert.deepStrictEqual(document.serializeCopy(), baseline);
		} finally {
			document?.dispose(); recovered?.dispose(); await rm(directory, { recursive: true, force: true });
		}
	});
});

function miniXlsx(): Uint8Array {
	const encode = (value: string) => new TextEncoder().encode(value);
	return zipSync({
		'xl/workbook.xml': encode('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
		'xl/_rels/workbook.xml.rels': encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
		'xl/worksheets/sheet1.xml': encode('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c><c r="B1" t="inlineStr"><is><t>value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>first</t></is></c><c r="B2"><v>1</v></c></row></sheetData></worksheet>'),
	});
}

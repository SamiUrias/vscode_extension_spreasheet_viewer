import * as assert from 'assert';
import * as vscode from 'vscode';
import { zipSync } from 'fflate';
import { SpreadsheetDocument } from '../document';

suite('XLSM read-only profile', () => {
	test('classifies extension and macro-enabled content as read-only and disables calculation', () => {
		const xlsm = SpreadsheetDocument.fromBytes(vscode.Uri.file('/tmp/book.xlsm'), createMacroWorkbook());
		const mismatched = SpreadsheetDocument.fromBytes(vscode.Uri.file('/tmp/book.xlsx'), createMacroWorkbook());
		try {
			assert.equal(xlsm.isReadOnly, true);
			assert.equal(xlsm.hasMacroWorkbook, true);
			assert.equal(xlsm.supportsFormulaCalculation, false);
			assert.equal(xlsm.hasProtectedPackage, true);
			assert.equal(mismatched.isReadOnly, true, 'macro-enabled content remains read-only even with an .xlsx filename');
			assert.equal(mismatched.hasMacroWorkbook, true);
			assert.equal(mismatched.supportsFormulaCalculation, false);
		} finally {xlsm.dispose(); mismatched.dispose();}
	});

	test('keeps a plain XLSX editable when its file provider is writable', () => {
		const document = SpreadsheetDocument.fromBytes(vscode.Uri.file('/tmp/plain.xlsx'), createPlainWorkbook());
		try {
			assert.equal(document.isReadOnly, false);
			assert.equal(document.supportsFormulaCalculation, true);
		} finally {document.dispose();}
	});
});

function createPlainWorkbook(): Uint8Array {return workbook(false);}
function createMacroWorkbook(): Uint8Array {return workbook(true);}
function workbook(macroEnabled: boolean): Uint8Array {
	const contentType = macroEnabled
		? '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>'
		: '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
	return zipSync({
		'[Content_Types].xml': bytes(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${contentType}</Types>`),
		'xl/workbook.xml': bytes('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
		'xl/_rels/workbook.xml.rels': bytes('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
		'xl/worksheets/sheet1.xml': bytes('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>safe data</t></is></c></row></sheetData></worksheet>'),
		...(macroEnabled ? { 'xl/vbaProject.bin': new Uint8Array([0, 1, 2]) } : {}),
	});
}

function bytes(value: string): Uint8Array {return new TextEncoder().encode(value);}

import assert from 'node:assert/strict';
import initializeWasm, { parse, tokenize } from 'formualizer';
import { unzipSync, zipSync } from 'fflate';
import { applyXlsxStructureOperation } from '../formats/xlsx-structure';
import { parseXlsxBytes } from '../formats/xlsx';
import { transformFormulaReferences, type FormulaParserService } from '../formula-reference';

async function run(): Promise<void> {
	await initializeWasm();
	const parser: FormulaParserService = {
		parseFormula: formula => parse(formula),
		tokenizeFormula: async formula => (await tokenize(formula)).tokens,
	};

	assert.deepEqual(await transformFormulaReferences("=SUM('My Sheet'!$A1:B$2)+IF(C3=\"B2\",D4,D5)",
		{ kind: 'insert', axis: 'row', index: 2, count: 1, formulaSheet: 'My Sheet', targetSheet: 'My Sheet' }, parser),
	{ status: 'transformed', formula: "=SUM('My Sheet'!$A1:B$3)+IF(C4=\"B2\",D5,D6)" });
	assert.deepEqual(await transformFormulaReferences('=$A1+B$2+C3',
		{ kind: 'copy', rowOffset: 2, columnOffset: 1 }, parser),
	{ status: 'transformed', formula: '=$A3+C$2+D5' });
	assert.deepEqual(await transformFormulaReferences('=SUM(A1:A5)',
		{ kind: 'delete', axis: 'row', index: 2, count: 2, formulaSheet: 'Data', targetSheet: 'Data' }, parser),
	{ status: 'transformed', formula: '=SUM(A1:A3)' });
	assert.deepEqual(await transformFormulaReferences('=A2+B5',
		{ kind: 'delete', axis: 'row', index: 2, count: 1, formulaSheet: 'Data', targetSheet: 'Data' }, parser),
	{ status: 'transformed', formula: '=#REF!+B4' });
	assert.deepEqual(await transformFormulaReferences('=SUM(A2:A3)',
		{ kind: 'delete', axis: 'row', index: 2, count: 2, formulaSheet: 'Data', targetSheet: 'Data' }, parser),
	{ status: 'transformed', formula: '=SUM(#REF!)' });
	assert.deepEqual(await transformFormulaReferences('=A1+"B2"',
		{ kind: 'insert', axis: 'column', index: 1, count: 2, formulaSheet: 'Data', targetSheet: 'Data' }, parser),
	{ status: 'transformed', formula: '=C1+"B2"' });
	assert.deepEqual(await transformFormulaReferences('=XFD1', { kind: 'copy', rowOffset: 0, columnOffset: 1 }, parser),
	{ status: 'transformed', formula: '=#REF!' });
	const badReference = await transformFormulaReferences('=[Budget.xlsx]Sheet1!A1+Sheet1:Sheet3!B2',
		{ kind: 'insert', axis: 'row', index: 1, count: 1, formulaSheet: 'Data', targetSheet: 'Data' }, parser);
	assert.equal(badReference.status, 'unsupported');
	assert.equal((await transformFormulaReferences('="B2"', { kind: 'copy', rowOffset: 1, columnOffset: 1 }, parser)).status, 'unchanged');
	assert.deepEqual(await transformFormulaReferences('=Sheet2!A1+A1',
		{ kind: 'insert', axis: 'row', index: 1, count: 1, formulaSheet: 'Sheet1', targetSheet: 'Sheet1' }, parser),
	{ status: 'transformed', formula: '=Sheet2!A1+A2' });
	assert.equal((await transformFormulaReferences(`=${'A1+'.repeat(11_000)}1`,
		{ kind: 'insert', axis: 'row', index: 1, count: 1, formulaSheet: 'Data', targetSheet: 'Data' }, parser)).status, 'unsupported');

	const original = formulaWorkbook();
	const snapshot = await applyXlsxStructureOperation(original, { kind: 'insertRows', sheetIndex: 0, index: 1, count: 1 }, parser);
	const changed = parseXlsxBytes(snapshot.after);
	assert.equal(changed.sheets[0]!.rows[2]![1], '=SUM(A1:A4)');
	assert.equal(changed.sheets[0]!.formulaCaches.B3, '', 'the changed formula cache must be cleared');
	assert.equal(changed.sheets[1]!.rows[0]![0], '=Data!A1+Data!A3+B1');
	assert.equal(changed.sheets[1]!.formulaCaches.A1, '', 'the cross-sheet formula cache must be cleared');
	assert.equal(changed.sheets[1]!.formulaCaches.C1, '3', 'an unchanged formula cache must be preserved');
	const changedParts = unzipSync(snapshot.after);
	assert.equal(changedParts['xl/calcChain.xml'], undefined);
	const bookXml = new TextDecoder().decode(changedParts['xl/workbook.xml']);
	assert.match(bookXml, /fullCalcOnLoad="1"/);
	assert.match(bookXml, /forceFullCalc="1"/);
	assert.doesNotMatch(new TextDecoder().decode(changedParts['xl/_rels/workbook.xml.rels']), /calcChain/);
	assert.doesNotMatch(new TextDecoder().decode(changedParts['[Content_Types].xml']), /calcChain/);
}

function formulaWorkbook(): Uint8Array {
	const encode = (value: string) => new TextEncoder().encode(value);
	return zipSync({
		'[Content_Types].xml': encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>'),
		'xl/workbook.xml': encode('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>'),
		'xl/_rels/workbook.xml.rels': encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'),
		'xl/calcChain.xml': encode('<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="B2" i="1"/><c r="A1" i="2"/></calcChain>'),
		'xl/worksheets/sheet1.xml': encode('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B2"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="B2"><f>SUM(A1:A3)</f><v>6</v></c></row></sheetData></worksheet>'),
		'xl/worksheets/sheet2.xml': encode('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C1"/><sheetData><row r="1"><c r="A1"><f>Data!A1+Data!A2+B1</f><v>2</v></c><c r="C1"><f>Data!A1+B1</f><v>3</v></c></row></sheetData></worksheet>'),
	});
}

void run().catch(error => {
	console.error(error);
	process.exitCode = 1;
});

import * as assert from 'assert';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { unzipSync, zipSync } from 'fflate';
import { parseCsvBytes, serializeCsvEdits, serializeCsvRowOperation } from '../formats/csv';
import { parseXlsxBytes, serializeXlsxEdits } from '../formats/xlsx';
import { applyXlsxStructureOperation, getXlsxStructureCapability } from '../formats/xlsx-structure';
import { parseOdsBytes, serializeOdsEdits } from '../formats/ods';
import { SpreadsheetEditSession } from '../edit-model';

suite('CSV reader', () => {
	test('keeps numeric-looking and date-looking values as text', () => {
		const table = parseUtf8('id,value,date\n00123,0.25,2026-02-04');
		assert.deepStrictEqual(table.rows, [['id', 'value', 'date'], ['00123', '0.25', '2026-02-04']]);
		assert.strictEqual(table.rowCount, 2);
		assert.strictEqual(table.columnCount, 3);
	});

	test('handles separators, escaped quotes, embedded newlines, blank lines, and irregular rows', () => {
		const table = parseUtf8('name;value\r\n"two;parts";"line 1\nline 2"\r\n\r\nshort');
		assert.strictEqual(table.delimiter, ';');
		assert.deepStrictEqual(table.rows, [
			['name', 'value'],
			['two;parts', 'line 1\nline 2'],
			[''],
			['short'],
		]);
		assert.strictEqual(table.rowCount, 4);
		assert.strictEqual(table.columnCount, 2);
	});

	test('does not add a row solely for the final record break', () => {
		const table = parseUtf8('a,b\n1,2\n');
		assert.deepStrictEqual(table.rows, [['a', 'b'], ['1', '2']]);
	});

	test('recognizes comment records without parsing their quotes and retains source line mapping', () => {
		const table = parseCsvBytes(Buffer.from('name,value\n# text,;| "without closing\n"#dato",1\n# final note'), { commentPrefix: '#' });
		assert.deepStrictEqual(table.rows, [['name', 'value'], [''], ['#dato', '1'], ['']]);
		assert.deepStrictEqual(table.rowKinds, ['data', 'comment', 'data', 'comment']);
		assert.deepStrictEqual(table.physicalLines, [1, 2, 3, 4]);
		assert.deepStrictEqual(table.rowComments, [undefined, '# text,;| "without closing', undefined, '# final note']);
		assert.deepStrictEqual(parseCsvBytes(serializeCsvEdits(table, [{ row: 2, column: 1, value: '2' }]), { commentPrefix: '#' }).rows,
			[['name', 'value'], [''], ['#dato', '2'], ['']]);
	});

	test('supports comma and tab separators and doubled quote escapes', () => {
		const comma = parseUtf8('text,value\n"say ""hello""",0.25');
		assert.strictEqual(comma.delimiter, ',');
		assert.deepStrictEqual(comma.rows, [['text', 'value'], ['say "hello"', '0.25']]);

		const tab = parseUtf8('text\tvalue\na\tb');
		assert.strictEqual(tab.delimiter, '\t');
		assert.deepStrictEqual(tab.rows, [['text', 'value'], ['a', 'b']]);
	});

	test('decodes UTF-8 BOM and UTF-16 little- and big-endian BOM files', () => {
		const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\n1,2')]);
		assert.deepStrictEqual(parseCsvBytes(utf8).rows, [['a', 'b'], ['1', '2']]);
		assert.deepStrictEqual(parseCsvBytes(encodeUtf16('a,b\n1,2', true)).rows, [['a', 'b'], ['1', '2']]);
		assert.deepStrictEqual(parseCsvBytes(encodeUtf16('a,b\n1,2', false)).rows, [['a', 'b'], ['1', '2']]);
	});

	test('reports malformed quoting and invalid UTF-8 rather than displaying a guessed parse', () => {
		assert.throws(() => parseUtf8('a,b\n1,"unterminated'), /No se pudo interpretar el CSV/);
		assert.throws(() => parseCsvBytes(Buffer.from([0xc3, 0x28])), /codificación/);
	});

	test('treats an empty file as a sheet with zero rows and columns', () => {
		assert.deepStrictEqual(parseCsvBytes(new Uint8Array()), {
			rows: [], rowCount: 0, columnCount: 0, delimiter: ',', commentPrefix: undefined, quoteChar: '"', quotes: true, preamble: '', persistDelimiter: false, encoding: 'utf-8',
			sourceText: '', sourceBytes: new Uint8Array(), bom: new Uint8Array(), fieldSpans: [],
			rowKinds: [], physicalLines: [], rowComments: [],
		});
	});

	test('CSV dialects preserve sep directives, tabs, pipes, custom quotes and disabled quoting', () => {
		const sep = parseCsvBytes(Buffer.from('\uFEFFsep=;\r\na;b\r\n1;2\r\n'));
		assert.deepStrictEqual(sep.rows, [['a', 'b'], ['1', '2']]);
		const sepOutput = serializeCsvEdits(sep, [{ row: 1, column: 0, value: '3' }]);
		assert.deepStrictEqual([...sepOutput.slice(0, 3)], [0xef, 0xbb, 0xbf]);
		assert.strictEqual(new TextDecoder().decode(sepOutput.slice(3)), 'sep=;\r\na;b\r\n3;2\r\n');
		assert.deepStrictEqual(parseCsvBytes(Buffer.from('a\tb\r\n1\t2\r\n'), { delimiter: '\t' }).rows, [['a', 'b'], ['1', '2']]);
		assert.deepStrictEqual(parseCsvBytes(Buffer.from('a|b\n1|2'), { delimiter: '|' }).rows, [['a', 'b'], ['1', '2']]);
		assert.deepStrictEqual(parseCsvBytes(Buffer.from("a,b\n'one, two',2"), { quoteChar: "'" }).rows, [['a', 'b'], ['one, two', '2']]);
		assert.deepStrictEqual(parseCsvBytes(Buffer.from('a,b\n"one, two",2'), { quotes: false }).rows, [['a', 'b'], ['"one', ' two"', '2']]);
		assert.throws(() => parseCsvBytes(Buffer.from('a,b;c\n1,2;3')), /ambiguo/);
		const selected = parseCsvBytes(Buffer.from('a|b\n1|2'), { delimiter: '|', persistDelimiter: true });
		const selectedOutput = serializeCsvEdits(selected, [{ row: 1, column: 0, value: 'x' }]);
		assert.deepStrictEqual(parseCsvBytes(selectedOutput).rows, [['a', 'b'], ['x', '2']]);
	});

	test('CSV edits preserve untouched bytes, quoting, CRLF and the original encoding', () => {
		const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\r\n"old, value",0.25\r\n')]);
		const table = parseCsvBytes(bytes);
		assert.deepStrictEqual(serializeCsvEdits(table, []), bytes);
		const output = serializeCsvEdits(table, [{ row: 1, column: 0, value: 'new, "value"' }]);
		assert.deepStrictEqual(parseCsvBytes(output).rows, [['a', 'b'], ['new, "value"', '0.25']]);
		assert.strictEqual(new TextDecoder().decode(output.slice(3)), 'a,b\r\n"new, ""value""",0.25\r\n');
	});

	test('CSV row operations preserve untouched records, preamble, comments, multiline cells, and EOLs', () => {
		const original = Buffer.from('\uFEFFsep=;\r\nname;value\r\n#keep this note\r\n"multi\nline";1\r\nlast;2\r\n');
		const table = parseCsvBytes(original, { commentPrefix: '#' });
		const inserted = serializeCsvRowOperation(table, { kind: 'insert', index: 3, rows: [['new;name', '003']] });
		assert.deepStrictEqual(parseCsvBytes(inserted, { commentPrefix: '#' }).rows,
			[['name', 'value'], [''], ['multi\nline', '1'], ['new;name', '003'], ['last', '2']]);
		assert.match(new TextDecoder().decode(inserted), /#keep this note\r\n"multi\nline";1\r\n"new;name";003\r\nlast;2\r\n$/);
		const deleted = serializeCsvRowOperation(table, { kind: 'delete', rows: [2] });
		assert.deepStrictEqual(parseCsvBytes(deleted, { commentPrefix: '#' }).rows, [['name', 'value'], [''], ['last', '2']]);
		assert.throws(() => serializeCsvRowOperation(table, { kind: 'delete', rows: [1] }), /registros de datos/);
	});

	test('CSV model undo/redo and invalid edits preserve the prior value', () => {
		const table = parseUtf8('id,value\n001,0.25000000000000000001');
		const session = new SpreadsheetEditSession(table);
		session.editCell(0, 1, 1, '0.25000000000000000002');
		assert.strictEqual(session.getCell(0, 1, 1).value, '0.25000000000000000002');
		assert.throws(() => session.editCell(0, 1, 1, 'bad', 'number'), /CSV se conservan como texto/);
		assert.strictEqual(session.getCell(0, 1, 1).value, '0.25000000000000000002');
		assert.strictEqual(session.undo(), true);
		assert.strictEqual(session.getCell(0, 1, 1).value, '0.25000000000000000001');
		assert.strictEqual(session.redo(), true);
		assert.strictEqual(session.getCell(0, 1, 1).value, '0.25000000000000000002');
	});

	test('an edited empty CSV cell is distinct from a missing field', () => {
		const session = new SpreadsheetEditSession(parseUtf8('a,b\n1'));
		assert.strictEqual(session.getCell(0, 1, 1).exists, false);
		session.editCell(0, 1, 1, '');
		assert.strictEqual(session.getCell(0, 1, 1).exists, true);
		assert.strictEqual(new TextDecoder().decode(session.serializeCopy()), 'a,b\n1,');
		assert.throws(() => session.editCell(0, 1, 0, '1', 'number'), /CSV se conservan como texto/);
	});
});

function parseUtf8(text: string) {
	return parseCsvBytes(Buffer.from(text, 'utf8'));
}

function encodeUtf16(text: string, littleEndian: boolean): Buffer {
	const output = Buffer.alloc(2 + text.length * 2);
	output[0] = littleEndian ? 0xff : 0xfe;
	output[1] = littleEndian ? 0xfe : 0xff;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		output.writeUInt16LE(code, 2 + index * 2);
	}
	if (!littleEndian) {
		for (let offset = 2; offset < output.length; offset += 2) {
			[output[offset], output[offset + 1]] = [output[offset + 1], output[offset]];
		}
	}
	return output;
}

suite('XLSX reader', () => {
	test('reads raw numeric/date values, booleans, gaps, shared/inline strings and formula cache', () => {
		const workbook = parseXlsxBytes(createXlsxFixture());
		assert.deepStrictEqual(workbook.sheets.map(sheet => sheet.name), ['Datos', 'Vacia']);
		const sheet = workbook.sheets[0];
		assert.ok(sheet);
		assert.strictEqual(sheet.rows[0][0], '0.25');
		assert.strictEqual(sheet.rows[0][1], '45292.123456789012345');
		assert.strictEqual(sheet.rows[0][2], '2026-02-04');
		assert.strictEqual(sheet.rows[1][0], '1');
		assert.strictEqual(sheet.rows[1][2], 'texto compartido');
		assert.strictEqual(sheet.rows[1][3], 'texto en línea');
		assert.strictEqual(sheet.rows[2][1], '=A1+1');
		assert.strictEqual(sheet.formulaCaches.B3, '1.25');
		assert.strictEqual(sheet.cellKinds[1][1], 'missing');
		assert.strictEqual(sheet.cellKinds[1][2], 'value');
		assert.strictEqual(workbook.sheets[1].rowCount, 0);
		assert.strictEqual(workbook.sheets[1].columnCount, 0);
	});

	test('a fixture-only worksheet edit serializes and reopens without changing other XML parts', () => {
		const original = createXlsxFixture();
		const originalParts = unzipSync(original);
		const worksheet = new DOMParser().parseFromString(
			new TextDecoder().decode(originalParts['xl/worksheets/sheet1.xml']), 'application/xml');
		const target = Array.from(worksheet.getElementsByTagName('c')).find(cell => cell.getAttribute('r') === 'A1');
		assert.ok(target);
		const value = target.getElementsByTagName('v').item(0);
		assert.ok(value);
		value.textContent = '0.5';
		const serialized = new XMLSerializer().serializeToString(worksheet);
		const editedCopy = zipSync({
			...originalParts,
			'xl/worksheets/sheet1.xml': new TextEncoder().encode(serialized),
		});
		const reopenedParts = unzipSync(editedCopy);
		for (const name of Object.keys(originalParts)) {
			if (name !== 'xl/worksheets/sheet1.xml') {
				assert.deepStrictEqual(reopenedParts[name], originalParts[name], `${name} changed`);
			}
		}
		assert.strictEqual(parseXlsxBytes(editedCopy).sheets[0].rows[0][0], '0.5');
	});

	test('XLSX structural model shifts row and column coordinates, returns a reversible byte snapshot, and preserves untouched parts', async () => {
		const originalParts = unzipSync(createXlsxFixture());
		const safeSheet = new DOMParser().parseFromString(new TextDecoder().decode(originalParts['xl/worksheets/sheet1.xml']), 'application/xml');
		const dimension = safeSheet.createElementNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'dimension'); dimension.setAttribute('ref', 'A1:D3');
		safeSheet.documentElement?.insertBefore(dimension, safeSheet.documentElement.firstChild);
		const cols = safeSheet.createElementNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'cols');
		const col = safeSheet.createElementNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'col'); col.setAttribute('min', '2'); col.setAttribute('max', '3'); col.setAttribute('width', '12'); col.setAttribute('customWidth', '1'); cols.appendChild(col);
		dimension.parentNode?.insertBefore(cols, dimension.nextSibling);
		const formula = Array.from(safeSheet.getElementsByTagName('f'))[0];
		assert.ok(formula);
		formula.parentNode?.removeChild(formula);
		const cache = Array.from(safeSheet.getElementsByTagName('v')).at(-1);
		cache?.parentNode?.removeChild(cache);
		const firstRow = Array.from(safeSheet.getElementsByTagName('row'))[0]; firstRow?.setAttribute('spans', '1:4');
		const safeBytes = zipSync({ ...originalParts, 'xl/worksheets/sheet1.xml': xml(new XMLSerializer().serializeToString(safeSheet)) });
		const inserted = await applyXlsxStructureOperation(safeBytes, { kind: 'insertRows', sheetIndex: 0, index: 1, count: 2 });
		const insertedWorkbook = parseXlsxBytes(inserted.after);
		assert.strictEqual(insertedWorkbook.sheets[0]!.rows[3]![1], '');
		assert.strictEqual(insertedWorkbook.sheets[0]!.rows[3]![2], 'texto compartido');
		assert.strictEqual(insertedWorkbook.sheets[0]!.rowCount, 5);
		const insertedWorksheet = new DOMParser().parseFromString(new TextDecoder().decode(unzipSync(inserted.after)['xl/worksheets/sheet1.xml']), 'application/xml');
		assert.strictEqual(insertedWorksheet.getElementsByTagName('dimension').item(0)?.getAttribute('ref'), 'A1:D5');
		assert.strictEqual(insertedWorksheet.getElementsByTagName('row').item(0)?.getAttribute('spans'), '1:4');
		const deletedRows = await applyXlsxStructureOperation(safeBytes, { kind: 'deleteRows', sheetIndex: 0, index: 1, count: 1 });
		assert.strictEqual(parseXlsxBytes(deletedRows.after).sheets[0]!.rowCount, 2);
		assert.strictEqual(parseXlsxBytes(deletedRows.after).sheets[0]!.rows[1]![2], '');
		const shifted = await applyXlsxStructureOperation(inserted.after, { kind: 'insertColumns', sheetIndex: 0, index: 1, count: 1 });
		assert.strictEqual(parseXlsxBytes(shifted.after).sheets[0]!.rows[0]![2], '45292.123456789012345');
		const shiftedWorksheet = new DOMParser().parseFromString(new TextDecoder().decode(unzipSync(shifted.after)['xl/worksheets/sheet1.xml']), 'application/xml');
		assert.strictEqual(shiftedWorksheet.getElementsByTagName('dimension').item(0)?.getAttribute('ref'), 'A1:E5');
		assert.strictEqual(shiftedWorksheet.getElementsByTagName('row').item(0)?.getAttribute('spans'), '1:5');
		assert.strictEqual(shiftedWorksheet.getElementsByTagName('col').item(0)?.getAttribute('min'), '3');
		assert.strictEqual(shiftedWorksheet.getElementsByTagName('col').item(0)?.getAttribute('max'), '4');
		const deletedColumns = await applyXlsxStructureOperation(safeBytes, { kind: 'deleteColumns', sheetIndex: 0, index: 1, count: 1 });
		assert.strictEqual(parseXlsxBytes(deletedColumns.after).sheets[0]!.rows[0]![1], '2026-02-04');
		assert.deepStrictEqual(shifted.before, inserted.after);
		const session = new SpreadsheetEditSession(undefined, parseXlsxBytes(safeBytes), safeBytes);
		const transaction = await session.applyXlsxStructure({ kind: 'insertRows', sheetIndex: 0, index: 1, count: 2 });
		assert.strictEqual(session.hasEdits, true);
		assert.strictEqual(session.getSheetSnapshot(0).rows.length, 5);
		const saved = session.serializeCopy();
		assert.strictEqual(parseXlsxBytes(saved).sheets[0]!.rowCount, 5);
		assert.strictEqual(session.undo(transaction), true);
		assert.deepStrictEqual(session.serializeCopy(), safeBytes);
		assert.strictEqual(session.redo(transaction), true);
		assert.deepStrictEqual(session.serializeCopy(), saved);
		const beforeParts = unzipSync(safeBytes); const afterParts = unzipSync(inserted.after);
		for (const name of Object.keys(beforeParts)) {
			if (name !== 'xl/worksheets/sheet1.xml') {assert.deepStrictEqual(afterParts[name], beforeParts[name], `${name} changed`);}
		}
		assert.deepStrictEqual(inserted.before, safeBytes);
	});

	test('XLSX structural model allows normal formulas only with a parser and rejects out-of-range operations', async () => {
		const original = createXlsxFixture();
		assert.equal(getXlsxStructureCapability(original).allowed, true);
		await assert.rejects(applyXlsxStructureOperation(original, { kind: 'insertRows', sheetIndex: 1, index: 0, count: 1 }), /parser de fórmulas/);
		const parts = unzipSync(original);
		const sheet = new DOMParser().parseFromString(new TextDecoder().decode(parts['xl/worksheets/sheet1.xml']), 'application/xml');
		const formula = Array.from(sheet.getElementsByTagName('f'))[0]; formula?.parentNode?.removeChild(formula);
		const cache = Array.from(sheet.getElementsByTagName('v')).at(-1); cache?.parentNode?.removeChild(cache);
		const safe = zipSync({ ...parts, 'xl/worksheets/sheet1.xml': xml(new XMLSerializer().serializeToString(sheet)) });
		assert.deepStrictEqual(getXlsxStructureCapability(safe), { allowed: true });
		await assert.rejects(applyXlsxStructureOperation(safe, { kind: 'deleteRows', sheetIndex: 0, index: 1, count: 99 }), /límites/);
		const safeParts = unzipSync(safe);
		const unsafeWorksheet = new DOMParser().parseFromString(new TextDecoder().decode(safeParts['xl/worksheets/sheet1.xml']), 'application/xml');
		unsafeWorksheet.documentElement?.appendChild(unsafeWorksheet.createElementNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'autoFilter'));
		const unsafe = zipSync({ ...safeParts, 'xl/worksheets/sheet1.xml': xml(new XMLSerializer().serializeToString(unsafeWorksheet)) });
		await assert.rejects(applyXlsxStructureOperation(unsafe, { kind: 'insertRows', sheetIndex: 0, index: 0, count: 1 }), /referencias o extensiones/);
	});

	test('rejects an expanded archive above the configured extraction limit', () => {
		const oversized = zipSync({ 'payload.xml': new Uint8Array(65 * 1024 * 1024) });
		assert.throws(() => parseXlsxBytes(oversized), /descomprimidos/);
	});

	test('XLSX model edits raw lexemes, protects formulas and shared strings, and retains other sheets', () => {
		const original = createXlsxFixture();
		const workbook = parseXlsxBytes(original);
		const session = new SpreadsheetEditSession(undefined, workbook, original);
		assert.strictEqual(session.getCell(0, 0, 1).value, '45292.123456789012345');
		session.editCell(0, 0, 0, '0.25000000000000000001');
		session.editCell(0, 1, 2, 'texto propio');
		assert.throws(() => session.editCell(0, 2, 1, '2'), /no se puede editar/);
		const copy = session.serializeCopy();
		assert.deepStrictEqual(session.serializeCopy(), copy, 'serialization should be stable for save-state comparisons');
		const reopened = parseXlsxBytes(copy);
		assert.strictEqual(reopened.sheets[0].rows[0][0], '0.25000000000000000001');
		assert.strictEqual(reopened.sheets[0].rows[1][2], 'texto propio');
		assert.strictEqual(reopened.sheets[0].rows[1][3], 'texto en línea');
		assert.strictEqual(reopened.sheets[0].rows[1][1], '');
		assert.strictEqual(reopened.sheets[0].rows[2][1], '=A1+1');
		assert.strictEqual(reopened.sheets[1].rowCount, 0);
		const parts = unzipSync(copy);
		assert.deepStrictEqual(parts['xl/sharedStrings.xml'], unzipSync(original)['xl/sharedStrings.xml']);
	});

	test('XLSX rejects an invalid edit without changing the source value and preserves date-formatted raw numbers', () => {
		const original = createXlsxFixture();
		const session = new SpreadsheetEditSession(undefined, parseXlsxBytes(original), original);
		assert.throws(() => session.editCell(0, 0, 0, 'not numeric'), /Número inválido/);
		assert.strictEqual(session.getCell(0, 0, 0).value, '0.25');
		session.editCell(0, 0, 1, '45292.000000000000001');
		assert.strictEqual(parseXlsxBytes(session.serializeCopy()).sheets[0].rows[0][1], '45292.000000000000001');
		assert.throws(() => serializeXlsxEdits(original, [{ sheetIndex: 0, row: 0, column: 0, value: 'x', type: 'number' }]), /Número XLSX inválido/);
	});
	test('reads XLSX workbook, sheet, style, geometry, merge, pane, and protection metadata without expanding the value matrix', () => {
		const files: Record<string, Uint8Array> = unzipSync(createXlsxFixture());
		files['xl/workbook.xml'] = xml('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets><sheet name="Datos" sheetId="1" state="veryHidden" r:id="rId1"/><sheet name="Vacia" sheetId="2" state="hidden" r:id="rId2"/></sheets><definedNames><definedName name="MyRange">Datos!$A$1</definedName></definedNames><externalReferences><externalReference r:id="external1"/></externalReferences></workbook>');
		files['xl/styles.xml'] = xml('<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts><numFmt numFmtId="165" formatCode="0.000%"/></numFmts><fonts><font/><font><b/><i/><sz val="12"/><color rgb="FF112233"/></font></fonts><fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF445566"/></patternFill></fill></fills><borders><border><left style="thin"><color rgb="FF010203"/></left></border></borders><cellStyles><cellStyle name="Normal"/></cellStyles><cellXfs><xf numFmtId="165" fontId="1" fillId="1" borderId="0" xfId="0"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>');
		files['xl/theme/theme1.xml'] = xml('<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"/>');
		files['xl/worksheets/sheet1.xml'] = xml('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView><pane xSplit="2" ySplit="1" topLeftCell="C2" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="2" width="18.5" customWidth="1" hidden="1" style="1"/></cols><sheetData><row r="1" ht="28" customHeight="1" s="0"><c r="A1" s="1"><v>0.25</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells><sheetProtection sheet="1"/><hyperlinks><hyperlink ref="A1" r:id="externalHyperlink"/></hyperlinks><tableParts count="1"><tablePart r:id="table1"/></tableParts><legacyDrawing r:id="vml1"/><drawing r:id="drawing1"/></worksheet>');
		files['xl/worksheets/_rels/sheet1.xml.rels'] = xml('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="externalHyperlink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/><Relationship Id="table1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/><Relationship Id="comments1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/></Relationships>');
		files['xl/tables/table1.xml'] = xml('<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Orders" displayName="Orders" ref="A1:B1"/>');
		files['xl/comments1.xml'] = xml('<?xml version="1.0"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Sam</author></authors><commentList><comment ref="A1" authorId="0"><text><r><t>Check</t></r><r><t> value</t></r></text></comment></commentList></comments>');
		files['xl/customFeature.bin'] = new Uint8Array([1, 2, 3]);
		const workbook = parseXlsxBytes(zipSync(files));
		assert.equal(workbook.date1904, true);
		assert.deepStrictEqual(workbook.definedNames, ['MyRange']);
		assert.equal(workbook.hasExternalReferences, true);
		assert.deepStrictEqual(workbook.unknownParts, ['xl/customFeature.bin']);
		assert.equal(workbook.styles?.customNumberFormats[0]?.formatCode, '0.000%');
		assert.deepStrictEqual(workbook.styles?.cellFormats[0], { numberFormatId: 165, fontId: 1, fillId: 1, borderId: 0, baseFormatId: 0 });
		assert.deepStrictEqual(workbook.styles?.cellVisualStyles[0], { bold: true, italic: true, fontSize: 12, fontColor: '#112233', fillColor: '#445566', horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true, borders: { left: { style: 'thin', color: '#010203' } } });
		assert.equal(workbook.styles?.fontCount, 2);
		assert.equal(workbook.styles?.fillCount, 2);
		assert.equal(workbook.styles?.borderCount, 1);
		assert.equal(workbook.styles?.namedStyleCount, 1);
		assert.equal(workbook.hasTheme, true);
		assert.deepStrictEqual(workbook.sheets.map(sheet => sheet.state), ['veryHidden', 'hidden']);
		assert.deepStrictEqual(workbook.sheets[0]?.cellStyleIndexes?.[0], [1]);
		assert.deepStrictEqual(workbook.sheets[0]?.metadata?.frozenPane, { xSplit: 2, ySplit: 1, topLeftCell: 'C2', state: 'frozen' });
		assert.deepStrictEqual(workbook.sheets[0]?.metadata?.mergedRanges, ['A1:B1']);
		assert.equal(workbook.sheets[0]?.metadata?.protected, true);
		assert.deepStrictEqual(workbook.sheets[0]?.metadata?.columns[0], { min: 1, max: 2, width: 18.5, hidden: true, style: 1 });
		assert.equal(workbook.sheets[0]?.metadata?.rows[0]?.height, 28);
		assert.equal(workbook.sheets[0]?.metadata?.hyperlinkCount, 1);
		assert.deepStrictEqual(workbook.sheets[0]?.metadata?.hyperlinks[0], { reference: 'A1', target: 'https://example.com' });
		assert.equal(workbook.sheets[0]?.metadata?.tableCount, 1);
		assert.deepStrictEqual(workbook.sheets[0]?.metadata?.tables[0], { name: 'Orders', displayName: 'Orders', reference: 'A1:B1' });
		assert.equal(workbook.sheets[0]?.metadata?.hasNotes, true);
		assert.deepStrictEqual(workbook.sheets[0]?.metadata?.notes[0], { reference: 'A1', author: 'Sam', text: 'Check value' });
		assert.equal(workbook.sheets[0]?.metadata?.hasDrawings, true);
		assert.equal(workbook.sheets[0]?.rowCount, 1, 'style/merge geometry must not expand the value matrix');
		assert.throws(() => serializeXlsxEdits(zipSync(files), [{ sheetIndex: 0, row: 0, column: 0, value: '1', type: 'number' }]), /protegida/);
		const unprotectedFiles: Record<string, Uint8Array> = unzipSync(createXlsxFixture());
		unprotectedFiles['xl/customFeature.bin'] = new Uint8Array([9, 8, 7]);
		const sheetXml = new TextDecoder().decode(unprotectedFiles['xl/worksheets/sheet1.xml']);
		unprotectedFiles['xl/worksheets/sheet1.xml'] = xml(sheetXml.replace('</worksheet>', '<mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>'));
		const mergedBytes = zipSync(unprotectedFiles);
		assert.throws(() => serializeXlsxEdits(mergedBytes, [{ sheetIndex: 0, row: 0, column: 1, value: 'x', type: 'number' }]), /cubierta por una combinación/);
		const edited = unzipSync(serializeXlsxEdits(mergedBytes, [{ sheetIndex: 0, row: 0, column: 0, value: '0.5', type: 'number' }]));
		assert.deepStrictEqual(edited['xl/customFeature.bin'], new Uint8Array([9, 8, 7]));
	});
});

suite('ODS reader', () => {
	test('reads raw numbers, dates, strings, cached formulas, sheets and repeated cells', () => {
		const workbook = parseOdsBytes(createOdsFixture());
		assert.deepStrictEqual(workbook.sheets.map(sheet => sheet.name), ['Datos', 'Vacia']);
		const sheet = workbook.sheets[0];
		assert.ok(sheet);
		assert.deepStrictEqual(sheet.rows[0], ['0.25', '45292.123456789012345', '2026-02-04', 'te  xto\tfin\nab', '0.25', '0.25']);
		assert.strictEqual(sheet.rows[1][0], 'of:=SUM([.A1:.B1])');
		assert.strictEqual(sheet.formulaCaches.A2, '12.5');
		assert.strictEqual(sheet.cellKinds[1][0], 'formula');
		assert.strictEqual(workbook.sheets[1].rowCount, 0);
	});
	test('preserves ODS visibility, protection, covered cells, merged ranges, geometry, and duration semantics', () => {
		const bytes = createOdsMetadataFixture(false);
		const workbook = parseOdsBytes(bytes);
		const sheet = workbook.sheets[0]!;
		assert.equal(sheet.odsMetadata?.state, 'hidden');
		assert.equal(sheet.odsMetadata?.protected, false);
		assert.equal(sheet.odsMetadata?.styleName, 'ta1');
		assert.deepStrictEqual(sheet.odsMetadata?.mergedRanges, ['A1:B2']);
		assert.deepStrictEqual(sheet.odsMetadata?.rowGeometry[0], { row: 1, repeated: 2, hidden: true, styleName: 'ro1' });
		assert.equal(sheet.odsMetadata?.rowGeometry[1]?.row, 3, 'next geometry row follows the repeated row count');
		assert.deepStrictEqual(sheet.odsMetadata?.columnGeometry[0], { repeated: 2, hidden: true, styleName: 'co1' });
		assert.equal(sheet.cellTypes[0]?.[0], 'duration');
		assert.equal(sheet.cellTypes[0]?.[1], 'unsupported', 'covered cell remains non-editable');
		const session = new SpreadsheetEditSession(undefined, undefined, undefined, workbook, bytes);
		assert.throws(() => session.editCell(0, 0, 0, 'PT2H'), /no se puede editar/);
		assert.throws(() => serializeOdsEdits(bytes, [{ sheetIndex: 0, row: 0, column: 0, value: 'PT2H', type: 'string' }]), /no se puede editar/);
		const protectedBytes = createOdsMetadataFixture(true);
		const protectedWorkbook = parseOdsBytes(protectedBytes);
		assert.equal(protectedWorkbook.sheets[0]?.odsMetadata?.protected, true);
		assert.throws(() => new SpreadsheetEditSession(undefined, undefined, undefined, protectedWorkbook, protectedBytes)
			.editCell(0, 0, 0, 'x'), /protegida/);
		assert.throws(() => serializeOdsEdits(protectedBytes, [{ sheetIndex: 0, row: 0, column: 0, value: 'x', type: 'string' }]), /protegida/);
	});
	test('edits ODS raw values while retaining formulas and untouched package parts', () => {
		const original = createOdsFixture();
		const originalParts = unzipSync(original);
		const workbook = parseOdsBytes(original);
		const session = new SpreadsheetEditSession(undefined, undefined, undefined, workbook, original);
		session.editCell(0, 0, 0, '0.25000000000000000001');
		session.editCell(0, 0, 3, 'nuevo texto');
		session.editCell(0, 0, 5, '0.5');
		assert.throws(() => session.editCell(0, 1, 0, '12'), /no se puede editar/);
		const output = session.serializeCopy();
		const reopened = parseOdsBytes(output);
		assert.strictEqual(reopened.sheets[0].rows[0][0], '0.25000000000000000001');
		assert.strictEqual(reopened.sheets[0].rows[0][3], 'nuevo texto');
		assert.strictEqual(reopened.sheets[0].rows[0][4], '0.25');
		assert.strictEqual(reopened.sheets[0].rows[0][5], '0.5');
		assert.strictEqual(reopened.sheets[0].rows[1][0], 'of:=SUM([.A1:.B1])');
		assert.strictEqual(reopened.sheets[0].formulaCaches.A2, '12.5');
		assert.deepStrictEqual(unzipSync(output)['styles.xml'], originalParts['styles.xml']);
		assert.deepStrictEqual(unzipSync(output)['meta.xml'], originalParts['meta.xml']);
		assert.deepStrictEqual(parseOdsBytes(serializeOdsEdits(original, [])).sheets[0].rows, workbook.sheets[0].rows);
	});
});

function createOdsFixture(): Uint8Array {
	const mimetype = new TextEncoder().encode('application/vnd.oasis.opendocument.spreadsheet');
	const entries = {
		mimetype: [mimetype, { level: 0 }] as [Uint8Array, { level: 0 }],
		'content.xml': xml('<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2"><office:body><office:spreadsheet><table:table table:name="Datos"><table:table-row><table:table-cell office:value-type="float" office:value="0.25"/><table:table-cell office:value-type="float" office:value="45292.123456789012345"/><table:table-cell office:value-type="date" office:date-value="2026-02-04"/><table:table-cell office:value-type="string"><text:p>te<text:s text:c="2"/>xto<text:tab/>fin<text:line-break/>ab</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2" office:value-type="float" office:value="0.25"/></table:table-row><table:table-row><table:table-cell table:formula="of:=SUM([.A1:.B1])" office:value-type="float" office:value="12.5"/></table:table-row></table:table><table:table table:name="Vacia"/></office:spreadsheet></office:body></office:document-content>'),
		'styles.xml': xml('<office:document-styles/>'),
		'meta.xml': xml('<office:document-meta/>'),
	};
	return zipSync(entries);
}

function createOdsMetadataFixture(protectedSheet: boolean): Uint8Array {
	const mimetype = new TextEncoder().encode('application/vnd.oasis.opendocument.spreadsheet');
	const content = xml(`<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:spreadsheet><table:table table:name="Meta" table:display="false" table:protected="${protectedSheet ? 'true' : 'false'}" table:style-name="ta1"><table:table-column table:number-columns-repeated="2" table:visibility="collapse" table:style-name="co1"/><table:table-row table:number-rows-repeated="2" table:visibility="collapse" table:style-name="ro1"><table:table-cell office:value-type="time" office:time-value="PT1H" table:number-columns-spanned="2" table:number-rows-spanned="2"/><table:covered-table-cell/></table:table-row><table:table-row><table:table-cell/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`);
	const entries = { mimetype: [mimetype, { level: 0 }] as [Uint8Array, { level: 0 }], 'content.xml': content };
	return zipSync(entries);
}

function createXlsxFixture(): Uint8Array {
	const entries: Record<string, Uint8Array> = {
		'xl/workbook.xml': xml('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Datos" sheetId="1" r:id="rId1"/><sheet name="Vacia" sheetId="2" r:id="rId2"/></sheets></workbook>'),
		'xl/_rels/workbook.xml.rels': xml('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
		'xl/sharedStrings.xml': xml('<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>texto compartido</t></si></sst>'),
		'xl/styles.xml': xml('<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts><numFmt numFmtId="9" formatCode="0%"/><numFmt numFmtId="14" formatCode="mm-dd-yy"/></numFmts></styleSheet>'),
		'xl/worksheets/sheet1.xml': xml('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="1"><v>0.25</v></c><c r="B1" s="2"><v>45292.123456789012345</v></c><c r="C1" t="inlineStr"><is><t>2026-02-04</t></is></c></row><row r="2"><c r="A2" t="b"><v>1</v></c><c r="C2" t="s"><v>0</v></c><c r="D2" t="inlineStr"><is><r><t>texto </t></r><r><t>en línea</t></r></is></c></row><row r="3"><c r="B3"><f>A1+1</f><v>1.25</v></c></row></sheetData></worksheet>'),
		'xl/worksheets/sheet2.xml': xml('<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'),
	};
	return zipSync(entries);
}

function xml(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

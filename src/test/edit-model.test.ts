import * as assert from 'node:assert/strict';
import { SpreadsheetEditSession } from '../edit-model';
import { parseCsvBytes } from '../formats/csv';
import type { XlsxWorkbook } from '../formats/xlsx';

suite('edit transactions', () => {
	test('preflights the whole transaction before changing any cell', () => {
		const csv = parseCsvBytes(new TextEncoder().encode('a,b\nc,d'));
		const session = new SpreadsheetEditSession(csv);
		assert.throws(() => session.editCells([
			{ sheetIndex: 0, row: 0, column: 0, value: 'changed' },
			{ sheetIndex: 0, row: 99, column: 1, value: 'out of range' },
		]), /rango actual/);
		assert.deepStrictEqual(session.getRows(0), [['a', 'b'], ['c', 'd']]);
		assert.equal(session.hasEdits, false);
		assert.equal(session.undo(), false);
	});
	test('applies a multi-cell transaction with one undo and one redo', () => {
		const session = new SpreadsheetEditSession(parseCsvBytes(new TextEncoder().encode('a,b\nc,d')));
		const transactionId = session.editCells([
			{ sheetIndex: 0, row: 0, column: 0, value: 'A' },
			{ sheetIndex: 0, row: 1, column: 1, value: 'D' },
		]);
		assert.equal(typeof transactionId, 'number');
		assert.deepStrictEqual(session.getRows(0), [['A', 'b'], ['c', 'D']]);
		assert.equal(session.undo(), true);
		assert.deepStrictEqual(session.getRows(0), [['a', 'b'], ['c', 'd']]);
		assert.equal(session.redo(), true);
		assert.deepStrictEqual(session.getRows(0), [['A', 'b'], ['c', 'D']]);
		assert.equal(session.undo(), true);
		assert.equal(session.hasEdits, false);
	});
	test('does not add history for a no-op and rejects repeated cell coordinates', () => {
		const session = new SpreadsheetEditSession(parseCsvBytes(new TextEncoder().encode('a')));
		assert.equal(session.editCells([{ sheetIndex: 0, row: 0, column: 0, value: 'a' }]), undefined);
		assert.equal(session.undo(), false);
		assert.throws(() => session.editCells([
			{ sheetIndex: 0, row: 0, column: 0, value: 'first' },
			{ sheetIndex: 0, row: 0, column: 0, value: 'second' },
		]), /celda repetida/);
		assert.deepStrictEqual(session.getRows(0), [['a']]);
	});
	test('undo and redo closures can target their own transaction identity', () => {
		const session = new SpreadsheetEditSession(parseCsvBytes(new TextEncoder().encode('a,b')));
		const first = session.editCells([{ sheetIndex: 0, row: 0, column: 0, value: 'A' }])!;
		const second = session.editCells([{ sheetIndex: 0, row: 0, column: 1, value: 'B' }])!;
		assert.equal(session.undo(first), false);
		assert.equal(session.undo(second), true);
		assert.equal(session.undo(first), true);
		assert.equal(session.redo(first), true);
		assert.equal(session.redo(second), true);
		assert.deepStrictEqual(session.getRows(0), [['A', 'B']]);
	});
	test('derives XLSX row, kind, type, and existence metadata from the active journal', () => {
		const workbook: XlsxWorkbook = { warnings: [], sheets: [{ name: 'Sheet1', rows: [['1', '']], cellKinds: [['value', 'missing']], cellTypes: [['number', 'missing']], formulaCaches: {}, rowCount: 1, columnCount: 2 }] };
		const session = new SpreadsheetEditSession(undefined, workbook, new Uint8Array());
		session.editCells([
			{ sheetIndex: 0, row: 0, column: 0, value: '2' },
			{ sheetIndex: 0, row: 0, column: 1, value: 'new' },
		]);
		const changed = session.getSheetSnapshot(0);
		assert.deepStrictEqual(changed.rows, [['2', 'new']]);
		assert.deepStrictEqual(changed.cellKinds, [['value', 'value']]);
		assert.deepStrictEqual(changed.cellTypes, [['number', 'string']]);
		assert.equal(session.undo(), true);
		const restored = session.getSheetSnapshot(0);
		assert.deepStrictEqual(restored.rows, [['1', '']]);
		assert.deepStrictEqual(restored.cellKinds, [['value', 'missing']]);
		assert.deepStrictEqual(restored.cellTypes, [['number', 'missing']]);
	});
	test('CSV structural transactions rebase prior cell edits and undo/redo in source order', () => {
		const session = new SpreadsheetEditSession(parseCsvBytes(new TextEncoder().encode('name,value\r\nfirst,1\r\nlast,2\r\n')));
		const cellEdit = session.editCells([{ sheetIndex: 0, row: 1, column: 1, value: '9' }])!;
		const structure = session.applyCsvRowOperation({ kind: 'insert', index: 2, rows: [['middle', '3']] });
		assert.deepStrictEqual(session.getRows(0), [['name', 'value'], ['first', '9'], ['middle', '3'], ['last', '2']]);
		assert.equal(session.undo(structure), true);
		assert.deepStrictEqual(session.getRows(0), [['name', 'value'], ['first', '9'], ['last', '2']]);
		assert.equal(session.undo(cellEdit), true);
		assert.deepStrictEqual(session.getRows(0), [['name', 'value'], ['first', '1'], ['last', '2']]);
		assert.equal(session.redo(cellEdit), true);
		assert.equal(session.redo(structure), true);
		assert.deepStrictEqual(session.getRows(0), [['name', 'value'], ['first', '9'], ['middle', '3'], ['last', '2']]);
		assert.deepStrictEqual(parseCsvBytes(session.serializeCopy()).rows, session.getRows(0));
	});
	test('XLSX protected sheets and merged covered cells are rejected before journal mutation', () => {
		const sheet: XlsxWorkbook['sheets'][number] = { name: 'Sheet1', rows: [['1', '2']], cellKinds: [['value', 'value']], cellTypes: [['number', 'number']],
			formulaCaches: {}, rowCount: 1, columnCount: 2, metadata: { mergedRanges: ['A1:B1'], protected: false,
			columns: [], rows: [], hyperlinkCount: 0, tableCount: 0, hasNotes: false, hasDrawings: false, hyperlinks: [], tables: [], notes: [] } };
		const workbook: XlsxWorkbook = { warnings: [], sheets: [sheet] };
		const session = new SpreadsheetEditSession(undefined, workbook, new Uint8Array());
		assert.throws(() => session.editCell(0, 0, 1, '3'), /cubierta por una combinación/);
		assert.equal(session.getCell(0, 0, 1).value, '2');
		session.editCell(0, 0, 0, '3');
		const protectedWorkbook: XlsxWorkbook = { warnings: [], sheets: [{ ...sheet, metadata: { ...sheet.metadata!, mergedRanges: [], protected: true } }] };
		const protectedSession = new SpreadsheetEditSession(undefined, protectedWorkbook, new Uint8Array());
		assert.throws(() => protectedSession.editCell(0, 0, 0, '4'), /protegida/);
		assert.equal(protectedSession.hasEdits, false);
	});
});

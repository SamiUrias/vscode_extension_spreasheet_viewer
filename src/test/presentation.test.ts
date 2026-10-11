import * as assert from 'assert';
import type { XlsxDataMessage } from '../protocol';
import { presentXlsxCell } from '../webview/presentation';

suite('XLSX presentation', () => {
	function snapshot(value: string, numberFormatId: number, formatCode?: string, date1904 = false): XlsxDataMessage {
		return {
			type: 'xlsxData', fileFormat: 'xlsx', revision: 0, documentId: 'doc', sheetId: 'sheet', sheetIds: ['sheet'],
			fileName: 'fixture.xlsx', sheetName: 'Sheet1', sheetNames: ['Sheet1'], activeSheetIndex: 0,
			rows: [[value]], rowCount: 1, columnCount: 1, warnings: [], cellKinds: [['value']], cellTypes: [['number']], cellCapabilities: [[{ storedType: 'number', editable: true }]],
			formulaCaches: {}, cellStyleIndexes: [[0]], cellNumberFormats: [{ numberFormatId, ...(formatCode ? { formatCode } : {}) }], date1904,
		};
	}

	test('shows formatted percentages only in book mode', () => {
		const data = snapshot('0.25', 9);
		assert.strictEqual(presentXlsxCell(data, 0, 0, '0.25', 'raw'), '0.25');
		assert.strictEqual(presentXlsxCell(data, 0, 0, '0.25', 'book'), '25%');
		assert.strictEqual(data.rows[0]?.[0], '0.25', 'presentation does not mutate source values');
	});

	test('supports date systems and the 1900 leap-year serial without local Date conversion', () => {
		assert.strictEqual(presentXlsxCell(snapshot('60', 14), 0, 0, '60', 'book'), '2/29/00');
		assert.strictEqual(presentXlsxCell(snapshot('0', 14, undefined, true), 0, 0, '0', 'book'), '1/1/04');
		assert.strictEqual(presentXlsxCell(snapshot('45292', 165, 'yyyy-mm-dd'), 0, 0, '45292', 'book'), '2024-01-01');
	});

	test('formats ISO XLSX dates in UTC and booleans explicitly', () => {
		const date = { ...snapshot('2024-01-01', 165, 'yyyy-mm-dd'), cellTypes: [['date']] };
		assert.strictEqual(presentXlsxCell(date, 0, 0, '2024-01-01', 'book'), '2024-01-01');
		const boolean = { ...snapshot('1', 0), cellTypes: [['boolean']] };
		assert.strictEqual(presentXlsxCell(boolean, 0, 0, '1', 'book'), 'TRUE');
		assert.strictEqual(presentXlsxCell(boolean, 0, 0, '0', 'book'), 'FALSE');
	});

	test('preserves high precision values and formula expressions', () => {
		const large = snapshot('1234567890123456', 1, '0%');
		assert.strictEqual(presentXlsxCell(large, 0, 0, large.rows[0]![0]!, 'book'), '1234567890123456');
		const formula = { ...snapshot('=A1*2', 9), cellKinds: [['formula']] };
		assert.strictEqual(presentXlsxCell(formula, 0, 0, '=A1*2', 'book'), '=A1*2');
	});

	test('leaves ODS values unchanged', () => {
		const data = { ...snapshot('0.25', 9), fileFormat: 'ods' as const };
		assert.strictEqual(presentXlsxCell(data, 0, 0, '0.25', 'book'), '0.25');
	});
});

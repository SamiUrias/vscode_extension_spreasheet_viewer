import * as assert from 'assert';
import { odsColumnDimensions, odsRowDimensions, xlsxColumnDimensions, xlsxRowDimensions } from '../formats/view-metadata';
import type { XlsxSheetMetadata } from '../formats/xlsx';
import type { OdsSheetMetadata } from '../formats/ods';

suite('Workbook view metadata', () => {
	test('maps XLSX dimensions from one-based workbook coordinates', () => {
		const metadata = { columns: [{ min: 2, max: 4, width: 12, hidden: false }], rows: [{ row: 5, height: 30, hidden: true }] } as XlsxSheetMetadata;
		assert.deepStrictEqual(xlsxColumnDimensions(metadata), [{ min: 1, max: 3, width: 12, hidden: false }]);
		assert.deepStrictEqual(xlsxRowDimensions(metadata), [{ row: 4, height: 30, hidden: true }]);
	});

	test('expands repeated ODS geometry only to the visible matrix bounds', () => {
		const metadata = {
			columnGeometry: [{ repeated: 3, hidden: true }, { repeated: 20, hidden: false }],
			rowGeometry: [{ row: 1, repeated: 2, hidden: false }, { row: 3, repeated: 10, hidden: true }],
		} as OdsSheetMetadata;
		assert.deepStrictEqual(odsColumnDimensions(metadata, 4), [
			{ min: 0, max: 2, hidden: true }, { min: 3, max: 3, hidden: false },
		]);
		assert.deepStrictEqual(odsRowDimensions(metadata, 4), [
			{ row: 0, hidden: false }, { row: 1, hidden: false }, { row: 2, hidden: true }, { row: 3, hidden: true },
		]);
	});
});

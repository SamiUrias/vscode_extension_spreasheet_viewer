import type { OdsSheetMetadata } from './ods';
import type { XlsxSheetMetadata } from './xlsx';

export interface ColumnViewDimension { readonly min: number; readonly max: number; readonly width?: number; readonly hidden: boolean; }
export interface RowViewDimension { readonly row: number; readonly height?: number; readonly hidden: boolean; }

/** Converts source-format geometry to zero-based, bounded grid coordinates. */
export function xlsxColumnDimensions(metadata: XlsxSheetMetadata): ColumnViewDimension[] {
	return metadata.columns.map(column => ({ min: Math.max(0, column.min - 1), max: Math.max(0, column.max - 1),
		...(column.width === undefined ? {} : { width: column.width }), hidden: column.hidden }));
}

export function xlsxRowDimensions(metadata: XlsxSheetMetadata): RowViewDimension[] {
	return metadata.rows.map(row => ({ row: Math.max(0, row.row - 1),
		...(row.height === undefined ? {} : { height: row.height }), hidden: row.hidden }));
}

export function odsColumnDimensions(metadata: OdsSheetMetadata, columnLimit: number): ColumnViewDimension[] {
	const result: ColumnViewDimension[] = [];
	let start = 0;
	for (const column of metadata.columnGeometry) {
		if (start >= columnLimit) {break;}
		const end = Math.min(columnLimit - 1, start + column.repeated - 1);
		result.push({ min: start, max: end, hidden: column.hidden });
		start = end + 1;
	}
	return result;
}

export function odsRowDimensions(metadata: OdsSheetMetadata, rowLimit: number): RowViewDimension[] {
	const result: RowViewDimension[] = [];
	for (const item of metadata.rowGeometry) {
		for (let offset = 0; offset < item.repeated && result.length < rowLimit; offset++) {
			result.push({ row: item.row - 1 + offset, hidden: item.hidden });
		}
		if (result.length >= rowLimit) {break;}
	}
	return result;
}

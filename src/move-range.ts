import { t } from './i18n';

import type { EditableCellType } from './edit-model';

export interface MoveCellValue { readonly value: string; readonly type: Exclude<EditableCellType, 'formula'>; }
export interface MoveRangeEdit { readonly row: number; readonly column: number; readonly value: string; readonly targetType: Exclude<EditableCellType, 'formula'>; }

/** Build a single after-map for an in-sheet value move, including overlapping source/destination ranges. */
export function createMoveRangeEdits(
	values: readonly (readonly MoveCellValue[])[],
	source: { readonly row: number; readonly column: number },
	destination: { readonly row: number; readonly column: number },
	height: number,
	width: number,
	rowCount: number,
	columnCount: number,
): MoveRangeEdit[] {
	if (![source.row, source.column, destination.row, destination.column, height, width, rowCount, columnCount].every(Number.isSafeInteger)
		|| source.row < 0 || source.column < 0 || destination.row < 0 || destination.column < 0 || height < 1 || width < 1
		|| source.row + height > rowCount || source.column + width > columnCount
		|| destination.row + height > rowCount || destination.column + width > columnCount || height * width > 100_000) {
		throw new Error(t('domain.move.bounds'));
	}
	const changes = new Map<string, MoveRangeEdit>();
	for (let row = 0; row < height; row++) {for (let column = 0; column < width; column++) {
		const targetRow = source.row + row, targetColumn = source.column + column;
		changes.set(`${targetRow}:${targetColumn}`, { row: targetRow, column: targetColumn, value: '', targetType: 'string' });
	}}
	for (let row = 0; row < height; row++) {for (let column = 0; column < width; column++) {
		const value = values[row]?.[column];
		if (!value) {throw new Error(t('domain.move.source'));}
		const targetRow = destination.row + row, targetColumn = destination.column + column;
		changes.set(`${targetRow}:${targetColumn}`, { row: targetRow, column: targetColumn, value: value.value, targetType: value.value === '' ? 'string' : value.type });
	}}
	return [...changes.values()];
}

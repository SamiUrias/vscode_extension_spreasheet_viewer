export interface CellPosition {
	readonly row: number;
	readonly column: number;
}

export interface CellRangeBounds { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number; }

/** Resolves an A1 reference to zero-based coordinates if it is inside the active sheet. */
export function resolveCellReference(reference: string, rowCount: number, columnCount: number): CellPosition | undefined {
	const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(reference);
	if (!match || rowCount < 1 || columnCount < 1) {
		return undefined;
	}

	let column = 0;
	for (const character of match[1].toUpperCase()) {
		column = column * 26 + character.charCodeAt(0) - 64;
	}
	const row = Number(match[2]);
	if (!Number.isSafeInteger(row) || row > rowCount || column > columnCount) {
		return undefined;
	}
	return { row: row - 1, column: column - 1 };
}

/** Returns true for cells covered by a range while leaving its top-left anchor editable. */
export function isCellCoveredByRange(range: string, row: number, column: number): boolean {
	const bounds = parseCellRangeBounds(range);
	return Boolean(bounds && row >= bounds.top && row <= bounds.bottom && column >= bounds.left && column <= bounds.right
		&& (row !== bounds.top || column !== bounds.left));
}

export function parseCellRangeBounds(range: string): CellRangeBounds | undefined {
	const parts = range.split(':');
	if (parts.length !== 2) {return undefined;}
	const first = resolveCellReference(parts[0]!, 1_048_576, 18_278);
	const last = resolveCellReference(parts[1]!, 1_048_576, 18_278);
	if (!first || !last) {return undefined;}
	return { top: Math.min(first.row, last.row), bottom: Math.max(first.row, last.row),
		left: Math.min(first.column, last.column), right: Math.max(first.column, last.column) };
}

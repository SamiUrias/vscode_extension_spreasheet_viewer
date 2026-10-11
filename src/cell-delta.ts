export interface TextCellDelta { readonly row: number; readonly column: number; readonly value: string; }
export interface CsvCellEditDelta {
	readonly documentId: string; readonly baseRevision: number; readonly revision: number;
	readonly cells: readonly TextCellDelta[];
}
export interface CsvDeltaSnapshot {
	readonly documentId: string; readonly revision: number; readonly rows: string[][]; readonly columnCount: number;
}
export type CsvDeltaResult =
	| { readonly status: 'applied'; readonly snapshot: CsvDeltaSnapshot }
	| { readonly status: 'resync' }
	| { readonly status: 'ignore' };

export function applyCsvCellEditDelta(snapshot: CsvDeltaSnapshot, delta: CsvCellEditDelta): CsvDeltaResult {
	if (snapshot.documentId !== delta.documentId) {return { status: 'ignore' };}
	if (snapshot.revision !== delta.baseRevision || delta.revision !== delta.baseRevision + 1) {return { status: 'resync' };}
	const rows = applyTextCellDeltas(snapshot.rows, delta.cells, snapshot.columnCount);
	return rows ? { status: 'applied', snapshot: { ...snapshot, revision: delta.revision, rows } } : { status: 'resync' };
}

/** Applies a validated cell-only transaction while cloning only rows it touches. */
export function applyTextCellDeltas(
	rows: readonly (readonly string[])[],
	cells: readonly TextCellDelta[],
	columnCount: number,
): string[][] | undefined {
	if (!Number.isInteger(columnCount) || columnCount < 0 || cells.length === 0 || cells.length > 500_000) {return undefined;}
	const next = rows.slice() as string[][];
	const copiedRows = new Set<number>();
	for (const cell of cells) {
		if (!Number.isInteger(cell.row) || cell.row < 0 || cell.row >= rows.length
			|| !Number.isInteger(cell.column) || cell.column < 0 || cell.column >= columnCount || typeof cell.value !== 'string') {return undefined;}
		if (!copiedRows.has(cell.row)) {next[cell.row] = [...rows[cell.row]!]; copiedRows.add(cell.row);}
		next[cell.row]![cell.column] = cell.value;
	}
	return next;
}

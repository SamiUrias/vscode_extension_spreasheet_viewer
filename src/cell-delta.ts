export interface TextCellDelta { readonly row: number; readonly column: number; readonly value: string; }
export interface CsvCellEditDelta {
	readonly documentId: string; readonly baseRevision: number; readonly revision: number;
	readonly cells: readonly TextCellDelta[];
}
export interface WorkbookCellDelta extends TextCellDelta {
	readonly kind: string; readonly storedType: string; readonly editable: boolean; readonly reason?: string;
}
export interface WorkbookCellEditDelta {
	readonly documentId: string; readonly baseRevision: number; readonly revision: number;
	readonly sheetIndex: number; readonly cells: readonly WorkbookCellDelta[];
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

export function applyWorkbookCellEditDelta<T extends CsvDeltaSnapshot & {
	readonly activeSheetIndex: number; readonly cellKinds: string[][]; readonly cellTypes: string[][];
	readonly cellCapabilities: Array<Array<{ storedType: string; editable: boolean; reason?: string }>>;
}>(snapshot: T, delta: WorkbookCellEditDelta): { readonly status: 'applied'; readonly snapshot: T } | { readonly status: 'resync' } | { readonly status: 'ignore' } {
	if (snapshot.documentId !== delta.documentId) {return { status: 'ignore' };}
	if (snapshot.revision !== delta.baseRevision || delta.revision !== delta.baseRevision + 1) {return { status: 'resync' };}
	if (!Number.isInteger(delta.sheetIndex) || delta.sheetIndex < 0 || delta.cells.length === 0 || delta.cells.length > 500_000) {return { status: 'resync' };}
	if (snapshot.activeSheetIndex !== delta.sheetIndex) {return { status: 'applied', snapshot: { ...snapshot, revision: delta.revision } as T };}
	const rows = applyTextCellDeltas(snapshot.rows, delta.cells, snapshot.columnCount);
	if (!rows) {return { status: 'resync' };}
	const cellKinds = snapshot.cellKinds.slice(); const cellTypes = snapshot.cellTypes.slice();
	const cellCapabilities = snapshot.cellCapabilities.slice();
	const copiedRows = new Set<number>();
	for (const cell of delta.cells) {
		if (!['value', 'empty'].includes(cell.kind) || !cell.storedType || typeof cell.editable !== 'boolean') {return { status: 'resync' };}
		if (!copiedRows.has(cell.row)) {
			cellKinds[cell.row] = [...cellKinds[cell.row]!]; cellTypes[cell.row] = [...cellTypes[cell.row]!];
			cellCapabilities[cell.row] = [...cellCapabilities[cell.row]!]; copiedRows.add(cell.row);
		}
		cellKinds[cell.row]![cell.column] = cell.kind;
		cellTypes[cell.row]![cell.column] = cell.storedType;
		cellCapabilities[cell.row]![cell.column] = { storedType: cell.storedType, editable: cell.editable, ...(cell.reason ? { reason: cell.reason } : {}) };
	}
	return { status: 'applied', snapshot: { ...snapshot, revision: delta.revision, rows, cellKinds, cellTypes, cellCapabilities } as T };
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

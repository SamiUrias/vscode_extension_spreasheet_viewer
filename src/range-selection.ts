export interface CellPosition { row: number; column: number; }
export interface CellRange { anchor: CellPosition; focus: CellPosition; }

/** Tests a rectangle in visible row order, so filtered rows are not selected. */
export function isCellInVisibleRange(cell: CellPosition, range: CellRange | undefined, sourceToVisible: ReadonlyMap<number, number>): boolean {
	if (!range) {return false;}
	const row = sourceToVisible.get(cell.row);
	const anchorRow = sourceToVisible.get(range.anchor.row);
	const focusRow = sourceToVisible.get(range.focus.row);
	if (row === undefined || anchorRow === undefined || focusRow === undefined) {return false;}
	return row >= Math.min(anchorRow, focusRow) && row <= Math.max(anchorRow, focusRow)
		&& cell.column >= Math.min(range.anchor.column, range.focus.column)
		&& cell.column <= Math.max(range.anchor.column, range.focus.column);
}

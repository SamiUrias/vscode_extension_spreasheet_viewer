import { parseCellRangeBounds, type CellRangeBounds } from '../cell-reference';

export interface RenderableMergeRange extends CellRangeBounds { readonly reference: string; }

/** Returns merges that can be drawn without crossing a frozen pane or reordered/filtered rows. */
export function getRenderableMerges(references: readonly string[], rowCount: number, columnCount: number,
	visibleRows: readonly number[], freezeRows: number, freezeColumns: number): RenderableMergeRange[] {
	if (visibleRows.length !== rowCount || visibleRows.some((row, index) => row !== index)) {return [];}
	return references.flatMap(reference => {
		const range = parseCellRangeBounds(reference);
		return range && range.bottom < rowCount && range.right < columnCount
			&& !(range.top < freezeRows && range.bottom >= freezeRows)
			&& !(range.left < freezeColumns && range.right >= freezeColumns) ? [{ ...range, reference }] : [];
	});
}

export function mergeAnchorIntersectsViewport(range: CellRangeBounds, firstVisibleRow: number, lastVisibleRow: number, overscan: number): boolean {
	return range.top <= lastVisibleRow + overscan && range.bottom >= firstVisibleRow - overscan;
}

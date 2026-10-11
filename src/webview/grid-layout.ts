export interface RowLayout { heights: number[]; offsets: number[]; }

export function rebuildRowOffsets(layout: RowLayout): void {
	layout.offsets.length = layout.heights.length + 1;
	layout.offsets[0] = 0;
	for (let row = 0; row < layout.heights.length; row++) {
		layout.offsets[row + 1] = layout.offsets[row]! + layout.heights[row]!;
	}
}

export function findRowAtOffset(offsets: readonly number[], offset: number): number {
	const rowCount = offsets.length - 1;
	if (rowCount <= 0) {return 0;}
	let low = 0;
	let high = rowCount - 1;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if ((offsets[middle + 1] ?? 0) <= offset) {low = middle + 1;} else {high = middle;}
	}
	return low;
}

export function gridTemplateColumns(widths: readonly number[], rowHeaderWidth: number): string {
	return `${rowHeaderWidth}px ${widths.map(width => `${width}px`).join(' ')}`;
}

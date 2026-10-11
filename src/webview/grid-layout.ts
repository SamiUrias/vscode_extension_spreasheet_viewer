export interface RowLayout { heights: number[]; offsets: number[]; }

export function sampleEvenly<T>(items: readonly T[], maximum: number): T[] {
	if (maximum <= 0 || items.length === 0) {return [];}
	if (items.length <= maximum) {return [...items];}
	if (maximum === 1) {return [items[0]!];}
	return Array.from({ length: maximum }, (_, index) => items[Math.round(index * (items.length - 1) / (maximum - 1))]!);
}

export function wrappedTextHeight(texts: readonly string[], widths: readonly number[], measure: (text: string) => number,
	lineHeight: number, minimum: number, maximum: number, horizontalPadding = 16, verticalPadding = 8): number {
	let rowLines = 1;
	for (let index = 0; index < texts.length; index++) {
		const width = Math.max(1, (widths[index] ?? 160) - horizontalPadding);
		const text = texts[index]!.slice(0, 1_024);
		let lines = 0;
		for (const hardLine of text.split(/\r\n|\r|\n/)) {
			if (!hardLine) {lines++; continue;}
			lines++;
			let lineWidth = 0;
			for (const part of hardLine.split(/(\s+)/).filter(Boolean)) {
				const partWidth = measure(part);
				if (lineWidth > 0 && lineWidth + partWidth > width) {lines++; lineWidth = 0;}
				if (partWidth > width) {
					const extraLines = Math.ceil(partWidth / width);
					lines += extraLines - 1;
					lineWidth = partWidth % width;
				} else {lineWidth += partWidth;}
			}
		}
		rowLines = Math.max(rowLines, lines);
	}
	return Math.max(minimum, Math.min(maximum, Math.ceil(rowLines * lineHeight + verticalPadding)));
}

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

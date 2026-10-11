/** Serialize a rectangular matrix as quoted TSV suitable for spreadsheet pasting. */
export function serializeTsv(rows: readonly (readonly string[])[]): string {
	return rows.map(row => row.map(quoteTsvField).join('\t')).join('\r\n');
}

function quoteTsvField(value: string): string {
	if (!/[\t\r\n"]/.test(value)) {return value;}
	return `"${value.replaceAll('"', '""')}"`;
}

/** Parse TSV using the same quote/doubled-quote rules as serializeTsv. */
export function parseTsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index]!;
		if (quoted) {
			if (character === '"' && text[index + 1] === '"') {field += '"'; index++;}
			else if (character === '"') {quoted = false;}
			else {field += character;}
		} else if (character === '"' && field.length === 0) {quoted = true;}
		else if (character === '\t') {row.push(field); field = '';}
		else if (character === '\r' || character === '\n') {
			row.push(field); rows.push(row); row = []; field = '';
			if (character === '\r' && text[index + 1] === '\n') {index++;}
		} else {field += character;}
	}
	row.push(field);
	if (row.length > 1 || field.length > 0 || rows.length === 0 || !/[\r\n]$/.test(text)) {rows.push(row);}
	return rows;
}

export interface TsvCell { readonly row: number; readonly column: number; }

/** Copy a source-coordinate selection by slicing its current visible-row projection. */
export function serializeVisibleSelection(
	rows: readonly (readonly string[])[], visibleRows: readonly number[],
	selection: { readonly anchor: TsvCell; readonly focus: TsvCell }, columnCount: number,
	headers?: readonly string[],
): string | undefined {
	const anchorIndex = visibleRows.indexOf(selection.anchor.row);
	const focusIndex = visibleRows.indexOf(selection.focus.row);
	if (anchorIndex < 0 || focusIndex < 0 || columnCount < 1) {return undefined;}
	const firstVisible = Math.min(anchorIndex, focusIndex), lastVisible = Math.max(anchorIndex, focusIndex);
	const firstColumn = Math.max(0, Math.min(selection.anchor.column, selection.focus.column));
	const lastColumn = Math.min(columnCount - 1, Math.max(selection.anchor.column, selection.focus.column));
	if (firstColumn > lastColumn) {return undefined;}
	const output = visibleRows.slice(firstVisible, lastVisible + 1).map(sourceRow =>
		Array.from({ length: lastColumn - firstColumn + 1 }, (_, offset) => rows[sourceRow]?.[firstColumn + offset] ?? ''),
	);
	if (headers) {output.unshift(Array.from({ length: lastColumn - firstColumn + 1 }, (_, offset) => headers[firstColumn + offset] ?? ''));}
	return serializeTsv(output);
}

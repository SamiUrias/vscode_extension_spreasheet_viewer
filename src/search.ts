const SEARCH_CHECKS_PER_TURN = 8_000;

/** Finds literal, case-insensitive cell matches and yields periodically to keep the UI responsive. */
export async function findSearchMatches(
	rows: string[][],
	columnCount: number,
	query: string,
	isCancelled: () => boolean = () => false,
	visibleRows?: readonly number[],
): Promise<number[] | undefined> {
	if (query.length === 0) {
		return [];
	}
	const term = query.toLocaleLowerCase();
	const matches: number[] = [];
	let checkedCells = 0;
	const rowsToSearch = visibleRows ?? rows.map((_, index) => index);
	for (const rowIndex of rowsToSearch) {
		if (isCancelled()) {
			return undefined;
		}
		const row = rows[rowIndex];
		if (!row) {continue;}
		for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
			if (row[columnIndex].toLocaleLowerCase().includes(term)) {
				matches.push(rowIndex * columnCount + columnIndex);
			}
			checkedCells++;
			if (checkedCells >= SEARCH_CHECKS_PER_TURN) {
				await yieldToEventLoop();
				checkedCells = 0;
				if (isCancelled()) {
					return undefined;
				}
			}
		}
	}
	return isCancelled() ? undefined : matches;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

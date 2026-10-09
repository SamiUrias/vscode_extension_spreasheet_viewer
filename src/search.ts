const SEARCH_CHECKS_PER_TURN = 8_000;

/** Finds literal, case-insensitive cell matches and yields periodically to keep the UI responsive. */
export async function findSearchMatches(
	rows: string[][],
	columnCount: number,
	query: string,
	isCancelled: () => boolean = () => false,
): Promise<number[] | undefined> {
	if (query.length === 0) {
		return [];
	}
	const term = query.toLocaleLowerCase();
	const matches: number[] = [];
	let checkedCells = 0;
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
		if (isCancelled()) {
			return undefined;
		}
		const row = rows[rowIndex];
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

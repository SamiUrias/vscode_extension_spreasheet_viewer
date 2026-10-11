export interface SortCriterion { readonly column: number; readonly direction: 'asc' | 'desc'; readonly mode: 'text' | 'number'; }
export interface RowProjection { readonly visibleRows: number[]; readonly sourceToVisible: Map<number, number>; }

/** Build a stable row projection. The data matrix is never modified. */
export function projectRows(rows: readonly (readonly string[])[], criteria: readonly SortCriterion[] = [], hidden: ReadonlySet<number> = new Set()): RowProjection {
	const visibleRows = rows.map((_, index) => index).filter(index => !hidden.has(index));
	visibleRows.sort((left, right) => {
		for (const criterion of criteria) {
			const a = rows[left]?.[criterion.column] ?? '';
			const b = rows[right]?.[criterion.column] ?? '';
			const emptyA = a.length === 0, emptyB = b.length === 0;
			if (emptyA !== emptyB) { return emptyA ? 1 : -1; }
			const compared = criterion.mode === 'number' ? compareDecimalLexemes(a, b) : compareText(a, b);
			if (compared !== 0) { return compared * (criterion.direction === 'asc' ? 1 : -1); }
		}
		return left - right;
	});
	return { visibleRows, sourceToVisible: new Map(visibleRows.map((source, visible) => [source, visible])) };
}

export function cycleSort(criteria: readonly SortCriterion[], column: number, modifiers: { shift?: boolean; remove?: boolean }, mode: 'text' | 'number' = 'text'): SortCriterion[] {
	const next = [...criteria];
	const index = next.findIndex(item => item.column === column);
	if (modifiers.remove) { return next.filter(item => item.column !== column); }
	if (index < 0) { return modifiers.shift ? [...next, { column, direction: 'asc', mode }] : [{ column, direction: 'asc', mode }]; }
	const current = next[index]!;
	if (current.direction === 'asc') { next[index] = { ...current, direction: 'desc' }; return next; }
	return next.filter(item => item.column !== column);
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Exact decimal comparison of bounded decimal/scientific notation lexemes. */
export function compareDecimalLexemes(a: string, b: string): number {
	const left = decimalParts(a), right = decimalParts(b);
	if (!left || !right) { return left ? -1 : right ? 1 : 0; }
	if (left.sign !== right.sign) { return left.sign < right.sign ? -1 : 1; }
	if (left.sign === 0) { return 0; }
	const magnitude = left.order - right.order || compareText(left.digits.padEnd(Math.max(left.digits.length, right.digits.length), '0'), right.digits.padEnd(Math.max(left.digits.length, right.digits.length), '0'));
	return magnitude * left.sign;
}

function decimalParts(value: string): { sign: number; order: number; digits: string } | undefined {
	if (value.length > 4096) { return undefined; }
	const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value);
	if (!match) { return undefined; }
	const exponent = Number(match[5] ?? '0');
	if (!Number.isInteger(exponent) || Math.abs(exponent) > 10_000) { return undefined; }
	const integer = match[2] ?? '0';
	const fraction = match[3] ?? match[4] ?? '';
	const allDigits = `${integer}${fraction}`.replace(/^0+/, '') || '0';
	const significant = allDigits.replace(/0+$/, '') || '0';
	const scale = exponent - fraction.length;
	const sign = significant === '0' ? 0 : match[1] === '-' ? -1 : 1;
	return { sign: significant === '0' ? 0 : sign, order: allDigits.length + scale, digits: significant };
}

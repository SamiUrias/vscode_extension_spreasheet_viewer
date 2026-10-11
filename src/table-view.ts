export interface SortCriterion { readonly column: number; readonly direction: 'asc' | 'desc'; readonly mode: 'text' | 'number'; }
export type FilterOperator = 'equals' | 'notEquals' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'empty' | 'notEmpty' | 'gt' | 'gte' | 'lt' | 'lte';
export interface FilterCondition { readonly operator: FilterOperator; readonly mode: 'text' | 'number'; readonly value: string; }
export type ColumnFilter =
	| { readonly column: number; readonly kind: 'values'; readonly values: Array<string | null> }
	| { readonly column: number; readonly kind: 'conditions'; readonly join: 'and' | 'or'; readonly conditions: FilterCondition[] };
export interface ColumnFilterValue { readonly value: string | null; readonly count: number; }
export interface RowProjection { readonly visibleRows: number[]; readonly sourceToVisible: Map<number, number>; readonly incompatibleColumns: number[]; }

const MAX_FILTER_VALUES = 10_000;
const MAX_FILTER_BYTES = 64 * 1024;

/** Build a stable row projection. The data matrix is never modified. */
export function projectRows(rows: readonly (readonly string[])[], criteria: readonly SortCriterion[] = [], hidden: ReadonlySet<number> = new Set(), fixedRows: ReadonlySet<number> = new Set(), filters: readonly ColumnFilter[] = []): RowProjection {
	const incompatibleColumns = new Set<number>();
	for (const criterion of criteria) {
		if (criterion.mode === 'number' && rows.some((row, index) => !hidden.has(index) && !fixedRows.has(index) && filters.every(filter => matchesFilter(row, filter))
			&& (row[criterion.column] ?? '') !== '' && !decimalParts(row[criterion.column] ?? ''))) {
			incompatibleColumns.add(criterion.column);
		}
	}
	const fixed = [...fixedRows].filter(index => index >= 0 && index < rows.length && !hidden.has(index)).sort((a, b) => a - b);
	const sortableRows = rows.map((_, index) => index).filter(index => !hidden.has(index) && !fixedRows.has(index)
		&& filters.every(filter => matchesFilter(rows[index] ?? [], filter)));
	sortableRows.sort((left, right) => {
		for (const criterion of criteria) {
			const a = rows[left]?.[criterion.column] ?? '';
			const b = rows[right]?.[criterion.column] ?? '';
			const emptyA = a.length === 0, emptyB = b.length === 0;
			if (emptyA !== emptyB) { return emptyA ? 1 : -1; }
			if (criterion.mode === 'number') {
				const validA = decimalParts(a) !== undefined;
				const validB = decimalParts(b) !== undefined;
				if (validA !== validB) {return validA ? -1 : 1;}
			}
			const compared = criterion.mode === 'number' ? compareDecimalLexemes(a, b) : compareText(a, b);
			if (compared !== 0) { return compared * (criterion.direction === 'asc' ? 1 : -1); }
		}
		return left - right;
	});
	const visibleRows = [...fixed, ...sortableRows];
	return { visibleRows, sourceToVisible: new Map(visibleRows.map((source, visible) => [source, visible])), incompatibleColumns: [...incompatibleColumns] };
}

/** Validate untrusted popup/state criteria and enforce bounded payloads. */
export function validateColumnFilters(value: unknown, columnCount: number): ColumnFilter[] | undefined {
	if (!Array.isArray(value) || value.length > Math.min(columnCount, 256)) {return undefined;}
	const result: ColumnFilter[] = [];
	const seen = new Set<number>();
	for (const raw of value) {
		if (!isRecord(raw) || !Number.isInteger(raw.column) || raw.column < 0 || raw.column >= columnCount || seen.has(raw.column)) {return undefined;}
		seen.add(raw.column);
		if (raw.kind === 'values') {
			if (!Array.isArray(raw.values) || raw.values.length > MAX_FILTER_VALUES || raw.values.some(item => item !== null && typeof item !== 'string')) {return undefined;}
			const filter: ColumnFilter = { column: raw.column, kind: 'values', values: [...new Set(raw.values as Array<string | null>)] };
			if (serializedBytes(filter) > MAX_FILTER_BYTES) {return undefined;}
			result.push(filter);
		} else if (raw.kind === 'conditions' && (raw.join === 'and' || raw.join === 'or') && Array.isArray(raw.conditions)
			&& raw.conditions.length >= 1 && raw.conditions.length <= 2) {
			const conditions: FilterCondition[] = [];
			for (const item of raw.conditions) {
				if (!isRecord(item) || !FILTER_OPERATORS.has(item.operator as FilterOperator)
					|| (item.mode !== 'text' && item.mode !== 'number') || typeof item.value !== 'string' || item.value.length > 4096) {return undefined;}
				const operator = item.operator as FilterOperator;
				if (item.mode === 'number' && !['equals', 'notEquals', 'empty', 'notEmpty', 'gt', 'gte', 'lt', 'lte'].includes(operator)) {return undefined;}
				if (item.mode === 'text' && ['gt', 'gte', 'lt', 'lte'].includes(operator)) {return undefined;}
				if (item.mode === 'number' && !['empty', 'notEmpty'].includes(operator) && !decimalParts(item.value)) {return undefined;}
				conditions.push({ operator, mode: item.mode, value: item.value });
			}
			const filter: ColumnFilter = { column: raw.column, kind: 'conditions', join: raw.join, conditions };
			if (serializedBytes(filter) > MAX_FILTER_BYTES) {return undefined;}
			result.push(filter);
		} else {return undefined;}
	}
	return result;
}

/** Distinct raw values for the popup, after applying every other column's filter. */
export function getColumnFilterValues(rows: readonly (readonly string[])[], column: number, filters: readonly ColumnFilter[] = [], hidden: ReadonlySet<number> = new Set(), fixedRows: ReadonlySet<number> = new Set()): ColumnFilterValue[] {
	const counts = new Map<string, ColumnFilterValue>();
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
		if (hidden.has(rowIndex) || fixedRows.has(rowIndex) || !filters.every(filter => filter.column === column || matchesFilter(rows[rowIndex] ?? [], filter))) {continue;}
		const row = rows[rowIndex]!;
		const value = column >= row.length ? null : row[column]!;
		const key = value === null ? 'missing:' : `value:${value}`;
		const existing = counts.get(key);
		if (existing) {counts.set(key, { ...existing, count: existing.count + 1 });}
		else {counts.set(key, { value, count: 1 });}
	}
	return [...counts.values()].sort((left, right) => left.value === null ? (right.value === null ? 0 : -1)
		: right.value === null ? 1 : compareText(left.value, right.value));
}

export function matchesFilter(row: readonly string[], filter: ColumnFilter): boolean {
	const actual = filter.column >= row.length ? null : row[filter.column]!;
	if (filter.kind === 'values') {return filter.values.some(value => value === actual);}
	const results = filter.conditions.map(condition => matchesCondition(actual, condition));
	return filter.join === 'and' ? results.every(Boolean) : results.some(Boolean);
}

function matchesCondition(actual: string | null, condition: FilterCondition): boolean {
	const empty = actual === null || actual === '';
	if (condition.operator === 'empty') {return empty;}
	if (condition.operator === 'notEmpty') {return !empty;}
	if (actual === null) {return condition.operator === 'notEquals';}
	if (condition.mode === 'number') {
		const left = decimalParts(actual), right = decimalParts(condition.value);
		if (!left || !right) {return false;}
		const compared = compareDecimalLexemes(actual, condition.value);
		return condition.operator === 'equals' ? compared === 0 : condition.operator === 'notEquals' ? compared !== 0
			: condition.operator === 'gt' ? compared > 0 : condition.operator === 'gte' ? compared >= 0
				: condition.operator === 'lt' ? compared < 0 : compared <= 0;
	}
	const compared = compareText(actual, condition.value);
	switch (condition.operator) {
		case 'equals': return compared === 0;
		case 'notEquals': return compared !== 0;
		case 'contains': return actual.includes(condition.value);
		case 'notContains': return !actual.includes(condition.value);
		case 'startsWith': return actual.startsWith(condition.value);
		case 'endsWith': return actual.endsWith(condition.value);
		default: return false;
	}
}

const FILTER_OPERATORS = new Set<FilterOperator>(['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'empty', 'notEmpty', 'gt', 'gte', 'lt', 'lte']);
function isRecord(value: unknown): value is Record<string, any> {return typeof value === 'object' && value !== null && !Array.isArray(value);}
function serializedBytes(value: unknown): number {return new TextEncoder().encode(JSON.stringify(value)).byteLength;}

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

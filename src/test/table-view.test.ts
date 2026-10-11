import * as assert from 'node:assert/strict';
import { cycleSort, getColumnFilterValues, projectRows, validateColumnFilters, type ColumnFilter } from '../table-view';

suite('table view sorting', () => {
	test('keeps source rows stable and puts blanks last in both directions', () => {
		const rows = [['b'], [''], ['a'], ['a']];
		assert.deepStrictEqual(projectRows(rows, [{ column: 0, direction: 'asc', mode: 'text' }]).visibleRows, [2, 3, 0, 1]);
		assert.deepStrictEqual(projectRows(rows, [{ column: 0, direction: 'desc', mode: 'text' }]).visibleRows, [0, 2, 3, 1]);
		assert.deepStrictEqual(rows, [['b'], [''], ['a'], ['a']]);
	});
	test('compares large decimals exactly and cycles criteria', () => {
		const rows = [['9007199254740993'], ['9007199254740992'], ['00123'], ['-1e-2']];
		assert.deepStrictEqual(projectRows(rows, [{ column: 0, direction: 'asc', mode: 'number' }]).visibleRows, [3, 2, 1, 0]);
		assert.deepStrictEqual(cycleSort([], 1, {}), [{ column: 1, direction: 'asc', mode: 'text' }]);
		assert.deepStrictEqual(cycleSort([{ column: 1, direction: 'asc', mode: 'text' }], 1, {}), [{ column: 1, direction: 'desc', mode: 'text' }]);
		assert.deepStrictEqual(cycleSort([{ column: 1, direction: 'desc', mode: 'text' }], 1, {}), []);
	});
	test('keeps CSV header fixed and orders by stable multiple criteria', () => {
		const rows = [['city', 'country'], ['X', 'B'], ['Y', 'A'], ['Z', 'A']];
		const projection = projectRows(rows, [
			{ column: 1, direction: 'asc', mode: 'text' },
			{ column: 0, direction: 'desc', mode: 'text' },
		], new Set(), new Set([0]));
		assert.deepStrictEqual(projection.visibleRows, [0, 3, 2, 1]);
		assert.strictEqual(projection.sourceToVisible.get(0), 0);
	});
	test('puts incompatible numeric lexemes last and reports their column', () => {
		const rows = [['20'], ['not a number'], ['-3.5e1'], [''], ['00123']];
		const projection = projectRows(rows, [{ column: 0, direction: 'asc', mode: 'number' }]);
		assert.deepStrictEqual(projection.visibleRows, [2, 0, 4, 1, 3]);
		assert.deepStrictEqual(projection.incompatibleColumns, [0]);
		assert.deepStrictEqual(projectRows(rows, [{ column: 0, direction: 'desc', mode: 'number' }]).visibleRows, [4, 0, 2, 1, 3]);
	});
	test('compares decimal lexemes without coercion, trimming, or precision loss', () => {
		const rows = [['9007199254740993'], ['9007199254740992'], [' 1'], ['1e10001'], ['.25'], ['-0']];
		const projection = projectRows(rows, [{ column: 0, direction: 'asc', mode: 'number' }]);
		assert.deepStrictEqual(projection.visibleRows, [5, 4, 1, 0, 2, 3]);
		assert.deepStrictEqual(projection.incompatibleColumns, [0]);
	});
	test('applies value filters by raw value and keeps missing distinct from empty', () => {
		const rows = [['name', 'region'], ['A', 'North'], ['B', 'North'], ['C', 'South'], ['D'], ['E', '']];
		const fixed = new Set([0]);
		const filters: ColumnFilter[] = [
			{ column: 1, kind: 'values', values: ['North', null] },
			{ column: 0, kind: 'values', values: ['A', 'D'] },
		];
		const projection = projectRows(rows, [], new Set(), fixed, filters);
		assert.deepStrictEqual(projection.visibleRows, [0, 1, 4]);
		assert.strictEqual(projection.sourceToVisible.get(4), 2);
		assert.deepStrictEqual(getColumnFilterValues(rows, 0, filters, new Set(), fixed).map(item => item.value), ['A', 'B', 'D']);
	});
	test('combines text and exact numeric conditions with AND/OR per column', () => {
		const rows = [['name', 'amount'], ['Alfa', '9007199254740993'], ['Beta', '9007199254740992'], ['Alpine', 'bad'], ['Gamma', '']];
		const filters: ColumnFilter[] = [
			{ column: 0, kind: 'conditions', join: 'or', conditions: [
				{ operator: 'startsWith', mode: 'text', value: 'Al' },
				{ operator: 'equals', mode: 'text', value: 'Gamma' },
			] },
			{ column: 1, kind: 'conditions', join: 'and', conditions: [
				{ operator: 'gte', mode: 'number', value: '9007199254740993' },
			] },
		];
		assert.deepStrictEqual(projectRows(rows, [], new Set(), new Set([0]), filters).visibleRows, [0, 1]);
	});
	test('supports text predicates, empty fields, and numeric inequalities', () => {
		const rows = [['h', 'h'], ['alpha-one', '10'], ['beta-two', '20'], ['alpha-three', 'bad'], ['other', ''], ['missing']];
		const fixed = new Set([0]);
		assert.deepStrictEqual(projectRows(rows, [], new Set(), fixed, [{ column: 0, kind: 'conditions', join: 'and', conditions: [{ operator: 'endsWith', mode: 'text', value: 'three' }] }]).visibleRows, [0, 3]);
		assert.deepStrictEqual(projectRows(rows, [], new Set(), fixed, [{ column: 1, kind: 'conditions', join: 'and', conditions: [{ operator: 'empty', mode: 'text', value: '' }] }]).visibleRows, [0, 4, 5]);
		assert.deepStrictEqual(projectRows(rows, [], new Set(), fixed, [{ column: 1, kind: 'conditions', join: 'and', conditions: [{ operator: 'lt', mode: 'number', value: '15' }] }]).visibleRows, [0, 1]);
	});
	test('derives values after other filters but ignores the selected column own filter', () => {
		const rows = [['h', 'h'], ['a', 'x'], ['a', 'y'], ['b', 'x']];
		const filters: ColumnFilter[] = [{ column: 0, kind: 'values', values: ['a'] }];
		const values = getColumnFilterValues(rows, 1, filters, new Set(), new Set([0]));
		assert.deepStrictEqual(values.map(item => [item.value, item.count]), [['x', 1], ['y', 1]]);
	});
	test('returns the full unique-value universe beyond the popup first page', () => {
		const rows = Array.from({ length: 501 }, (_, index) => [`value-${index}`]);
		assert.strictEqual(getColumnFilterValues(rows, 0).length, 501);
	});
	test('projects a 50,000-row table without changing source row identity', () => {
		const rows = Array.from({ length: 50_000 }, (_, index) => [String(index), String(index % 3)]);
		const projection = projectRows(rows, [{ column: 0, direction: 'desc', mode: 'number' }], new Set(), new Set(), [
			{ column: 1, kind: 'values', values: ['1'] },
		]);
		assert.strictEqual(projection.visibleRows.length, 16_667);
		assert.strictEqual(projection.visibleRows[0], 49_999);
		assert.strictEqual(rows[49_999]?.[0], '49999');
	});
	test('rejects filter payloads beyond supported types and limits', () => {
		assert.strictEqual(validateColumnFilters([{ column: 0, kind: 'values', values: Array.from({ length: 10_001 }, (_, index) => String(index)) }], 1), undefined);
		assert.strictEqual(validateColumnFilters([{ column: 0, kind: 'conditions', join: 'and', conditions: [{ operator: 'gt', mode: 'text', value: 'a' }] }], 1), undefined);
		assert.strictEqual(validateColumnFilters([{ column: 0, kind: 'conditions', join: 'and', conditions: [{ operator: 'gt', mode: 'number', value: '1e10001' }] }], 1), undefined);
		assert.strictEqual(validateColumnFilters([{ column: 0, kind: 'values', values: ['x'.repeat(70_000)] }], 1), undefined);
	});
});

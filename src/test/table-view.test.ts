import * as assert from 'node:assert/strict';
import { cycleSort, projectRows } from '../table-view';

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
});

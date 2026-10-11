import * as assert from 'assert';
import { isCellInVisibleRange } from '../range-selection';

suite('Visible range selection', () => {
	test('selects a rectangle in visible row order and skips filtered source rows', () => {
		const visible = new Map([[2, 0], [8, 1], [9, 2]]);
		const range = { anchor: { row: 2, column: 1 }, focus: { row: 9, column: 3 } };
		assert.strictEqual(isCellInVisibleRange({ row: 8, column: 2 }, range, visible), true);
		assert.strictEqual(isCellInVisibleRange({ row: 8, column: 0 }, range, visible), false);
		assert.strictEqual(isCellInVisibleRange({ row: 4, column: 2 }, range, visible), false);
	});

	test('supports reverse drags and hidden range endpoints safely', () => {
		const visible = new Map([[4, 0], [7, 1], [12, 2]]);
		assert.strictEqual(isCellInVisibleRange({ row: 7, column: 2 }, { anchor: { row: 12, column: 4 }, focus: { row: 4, column: 1 } }, visible), true);
		assert.strictEqual(isCellInVisibleRange({ row: 7, column: 2 }, { anchor: { row: 5, column: 1 }, focus: { row: 7, column: 3 } }, visible), false);
	});
});

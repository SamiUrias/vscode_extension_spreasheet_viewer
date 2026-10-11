import * as assert from 'assert';
import { isCellCoveredByRange, parseCellRangeBounds, resolveCellReference } from '../cell-reference';
import { findSearchMatches } from '../search';

suite('Cell references', () => {
	test('resolves B54 and columns after Z using zero-based coordinates', () => {
		assert.deepStrictEqual(resolveCellReference('B54', 100, 30), { row: 53, column: 1 });
		assert.deepStrictEqual(resolveCellReference('AA4', 100, 30), { row: 3, column: 26 });
		assert.deepStrictEqual(resolveCellReference('$ab$4', 100, 30), { row: 3, column: 27 });
	});

	test('rejects malformed references and coordinates outside the active sheet', () => {
		for (const reference of ['A0', '54B', '', 'A-1', ' A1', 'AAAA1']) {
			assert.strictEqual(resolveCellReference(reference, 100, 30), undefined, reference);
		}
		assert.strictEqual(resolveCellReference('B54', 53, 30), undefined);
		assert.strictEqual(resolveCellReference('AE1', 100, 30), undefined);
		assert.strictEqual(resolveCellReference('A1', 0, 30), undefined);
	});
	test('identifies covered cells in an A1 range but leaves the anchor editable', () => {
		assert.deepStrictEqual(parseCellRangeBounds('B2:A1'), { top: 0, bottom: 1, left: 0, right: 1 });
		assert.equal(isCellCoveredByRange('A1:B2', 0, 0), false);
		assert.equal(isCellCoveredByRange('A1:B2', 1, 1), true);
		assert.equal(isCellCoveredByRange('$B$4:$C$5', 4, 2), true);
		assert.equal(isCellCoveredByRange('bad', 0, 0), false);
	});
});

suite('Active sheet search', () => {
	test('finds repeated case-insensitive literal matches in row order', async () => {
		const rows = [['Alpha', 'alphabet', 'a.b'], ['ALPHA', 'beta', 'Axb']];
		assert.deepStrictEqual(await findSearchMatches(rows, 3, 'alpha'), [0, 1, 3]);
		assert.deepStrictEqual(await findSearchMatches(rows, 3, '.'), [2]);
	});

	test('reports no matches and treats an empty query as no search', async () => {
		const rows = [['one', 'two']];
		assert.deepStrictEqual(await findSearchMatches(rows, 2, 'missing'), []);
		assert.deepStrictEqual(await findSearchMatches(rows, 2, ''), []);
	});

	test('cancels an in-progress scan when its sheet/query becomes stale', async () => {
		const rows = [Array.from({ length: 10_000 }, () => 'value')];
		let checks = 0;
		const matches = await findSearchMatches(rows, rows[0].length, 'value', () => ++checks > 1);
		assert.strictEqual(matches, undefined);
	});
});

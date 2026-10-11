import assert from 'node:assert/strict';
import { applyCsvCellEditDelta, applyTextCellDeltas } from '../cell-delta';

suite('cell transaction deltas', () => {
	test('updates only touched rows and leaves the snapshot source intact', () => {
		const source = [['a', 'b'], ['c', 'd']];
		const changed = applyTextCellDeltas(source, [
			{ row: 0, column: 1, value: 'B' },
			{ row: 0, column: 0, value: 'A' },
		], 2);

		assert.deepEqual(changed, [['A', 'B'], ['c', 'd']]);
		assert.deepEqual(source, [['a', 'b'], ['c', 'd']]);
		assert.notEqual(changed, source);
		assert.notEqual(changed![0], source[0]);
		assert.equal(changed![1], source[1]);
	});

	test('rejects invalid coordinates and malformed transactions for resync', () => {
		const source = [['a', 'b']];
		assert.equal(applyTextCellDeltas(source, [{ row: 2, column: 0, value: 'x' }], 2), undefined);
		assert.equal(applyTextCellDeltas(source, [{ row: 0, column: 2, value: 'x' }], 2), undefined);
		assert.equal(applyTextCellDeltas(source, [], 2), undefined);
	});

	test('requests a full snapshot after a gap and ignores a different document', () => {
		const snapshot = { documentId: 'doc-a', revision: 4, rows: [['before']], columnCount: 1 };
		const delta = { documentId: 'doc-a', baseRevision: 3, revision: 4, cells: [{ row: 0, column: 0, value: 'stale' }] };
		assert.deepEqual(applyCsvCellEditDelta(snapshot, delta), { status: 'resync' });
		assert.deepEqual(applyCsvCellEditDelta(snapshot, { ...delta, documentId: 'doc-b' }), { status: 'ignore' });
		assert.deepEqual(applyCsvCellEditDelta(snapshot, { ...delta, baseRevision: 4, revision: 5 }), {
			status: 'applied', snapshot: { ...snapshot, revision: 5, rows: [['stale']] },
		});
	});
});

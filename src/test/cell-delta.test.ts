import assert from 'node:assert/strict';
import { applyCsvCellEditDelta, applyTextCellDeltas, applyWorkbookCellEditDelta } from '../cell-delta';

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

	test('updates workbook cell metadata and advances revisions on other sheets', () => {
		const snapshot = { documentId: 'book', revision: 8, activeSheetIndex: 0, rows: [['1']], columnCount: 1,
			cellKinds: [['value']], cellTypes: [['number']], cellCapabilities: [[{ storedType: 'number', editable: true }]] };
		const delta = { documentId: 'book', baseRevision: 8, revision: 9, sheetIndex: 0,
			cells: [{ row: 0, column: 0, value: 'text', kind: 'value', storedType: 'string', editable: true }] };
		const updated = applyWorkbookCellEditDelta(snapshot, delta);
		assert.equal(updated.status, 'applied');
		if (updated.status !== 'applied') {return;}
		assert.deepEqual(updated.snapshot.rows, [['text']]);
		assert.deepEqual(updated.snapshot.cellKinds, [['value']]);
		assert.deepEqual(updated.snapshot.cellTypes, [['string']]);
		assert.deepEqual(updated.snapshot.cellCapabilities, [[{ storedType: 'string', editable: true }]]);
		assert.equal(snapshot.rows[0]![0], '1');

		const otherSheet = applyWorkbookCellEditDelta({ ...snapshot, activeSheetIndex: 1 }, { ...delta, sheetIndex: 0 });
		assert.equal(otherSheet.status, 'applied');
		if (otherSheet.status === 'applied') {
			assert.equal(otherSheet.snapshot.revision, 9);
			assert.deepEqual(otherSheet.snapshot.rows, [['1']]);
		}
	});
});

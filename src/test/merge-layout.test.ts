import * as assert from 'assert';
import { getRenderableMerges, mergeAnchorIntersectsViewport } from '../webview/merge-layout';

suite('Merged-cell grid layout', () => {
	test('accepts bounded merges only when rows remain in source order and do not cross frozen panes', () => {
		assert.deepStrictEqual(getRenderableMerges(['A1:B2', 'C1:C2', 'D1:E1', 'C2:D2'], 5, 5, [0, 1, 2, 3, 4], 1, 1), [
			{ top: 0, bottom: 0, left: 3, right: 4, reference: 'D1:E1' },
			{ top: 1, bottom: 1, left: 2, right: 3, reference: 'C2:D2' },
		]);
		assert.deepStrictEqual(getRenderableMerges(['A1:B2'], 5, 5, [0, 2, 3, 4], 0, 0), []);
		assert.deepStrictEqual(getRenderableMerges(['E5:F5'], 5, 5, [0, 1, 2, 3, 4], 0, 0), []);
	});

	test('keeps an offscreen anchor rendered when its merge reaches the viewport', () => {
		assert.equal(mergeAnchorIntersectsViewport({ top: 2, bottom: 6, left: 0, right: 1 }, 5, 8, 1), true);
		assert.equal(mergeAnchorIntersectsViewport({ top: 0, bottom: 1, left: 0, right: 1 }, 5, 8, 1), false);
	});
});

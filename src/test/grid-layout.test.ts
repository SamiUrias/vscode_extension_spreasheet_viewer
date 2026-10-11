import * as assert from 'assert';
import { buildColumnOffsets, buildProjectedRowLayout, findColumnAtOffset, getVisibleColumnWindow, rebuildRowOffsets, sampleEvenly, wrappedTextHeight, type RowLayout } from '../webview/grid-layout';

suite('Grid layout helpers', () => {
	test('samples rows evenly and deterministically within the requested limit', () => {
		assert.deepStrictEqual(sampleEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4), [0, 3, 6, 9]);
		assert.deepStrictEqual(sampleEvenly([1, 2], 200), [1, 2]);
		assert.deepStrictEqual(sampleEvenly([1, 2, 3], 1), [1]);
	});

	test('sizes a wrapped row by the tallest cell and honors row size limits', () => {
		const measure = (text: string): number => text.length * 10;
		assert.strictEqual(wrappedTextHeight(['123456789', '1'], [56, 56], measure, 18, 28, 600), 62);
		assert.strictEqual(wrappedTextHeight(['x'.repeat(100)], [48], measure, 18, 28, 70), 70);
	});

	test('builds projected row offsets for reordered rows and revisions resized layouts', () => {
		assert.deepStrictEqual(buildProjectedRowLayout([3, 1, 4], [10, 20, 30, 40], 25), {
			heights: [40, 20, 25], offsets: [0, 40, 60, 85],
		});
		const layout: RowLayout = { heights: [20, 30], offsets: [] };
		rebuildRowOffsets(layout);
		assert.equal(layout.revision, 1);
		layout.heights[0] = 40;
		rebuildRowOffsets(layout);
		assert.equal(layout.revision, 2);
		assert.deepStrictEqual(layout.offsets, [0, 40, 70]);
	});

	test('renders only visible columns plus overscan while retaining frozen columns', () => {
		const widths = Array.from({ length: 20 }, () => 100);
		const offsets = buildColumnOffsets(widths);
		assert.equal(findColumnAtOffset(offsets, 0), 0);
		assert.equal(findColumnAtOffset(offsets, 250), 2);
		assert.deepStrictEqual(getVisibleColumnWindow(widths, 0, 500, 60, 1, 1).rendered, [0, 1, 2, 3, 4, 5]);
		assert.deepStrictEqual(getVisibleColumnWindow(widths, 500, 500, 60, 1, 1).rendered, [0, 5, 6, 7, 8, 9, 10]);
		assert.deepStrictEqual(getVisibleColumnWindow(widths, 0, 400, 60, 2, 1).rendered, [0, 1, 2, 3, 4]);
	});
});

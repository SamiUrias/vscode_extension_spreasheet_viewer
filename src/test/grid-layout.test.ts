import * as assert from 'assert';
import { sampleEvenly, wrappedTextHeight } from '../webview/grid-layout';

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
});

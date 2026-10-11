import * as assert from 'node:assert/strict';
import { findSearchMatches } from '../search';

suite('table search scope', () => {
	test('searches all source rows by default and preserves source coordinates', async () => {
		const rows = [['needle'], ['other'], ['needle']];
		assert.deepStrictEqual(await findSearchMatches(rows, 1, 'needle'), [0, 2]);
	});
	test('can search only rows in visible visual order', async () => {
		const rows = [['needle'], ['needle'], ['other']];
		assert.deepStrictEqual(await findSearchMatches(rows, 1, 'needle', () => false, [1, 0]), [1, 0]);
	});
});

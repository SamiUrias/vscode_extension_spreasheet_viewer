import * as assert from 'node:assert/strict';
import { parseClipboardTsv, parseTsv, serializeTsv, serializeVisibleSelection } from '../clipboard';

suite('spreadsheet clipboard TSV', () => {
	test('round-trips delimiters, quotes, line endings, Unicode, blanks, and trailing zeros', () => {
		const rows = [
			['normal', 'contains\ttab', 'contains\r\nnewline', 'quote " here'],
			['', '東京 🧪', '001.2300', '=SUM(A1:A2)'],
		];
		assert.deepStrictEqual(parseTsv(serializeTsv(rows)), rows);
	});
	test('uses CRLF between rows and does not append a final newline', () => {
		assert.strictEqual(serializeTsv([['a', 'b'], ['c', 'd']]), 'a\tb\r\nc\td');
		assert.deepStrictEqual(parseTsv('a\tb\r\nc\td'), [['a', 'b'], ['c', 'd']]);
	});
	test('preserves a single empty cell and rows containing empty fields', () => {
		assert.deepStrictEqual(parseTsv(''), [['']]);
		assert.deepStrictEqual(parseTsv('\t'), [['', '']]);
		assert.deepStrictEqual(parseTsv('a\r\n'), [['a']]);
	});
	test('parses quoted multiline clipboard cells and rejects malformed or oversized clipboard text', () => {
		assert.deepStrictEqual(parseClipboardTsv('one\t"two\nlines"\r\nthree\tfour'), [['one', 'two\nlines'], ['three', 'four']]);
		assert.throws(() => parseClipboardTsv('"unclosed'), /comillas sin cerrar/);
		assert.throws(() => parseClipboardTsv('"quoted"tail'), /después de una comilla/);
		assert.throws(() => parseClipboardTsv('x'.repeat(50 * 1024 * 1024 + 1)), /50 MiB/);
	});
	test('maps a selected source range through sorted and filtered visible rows', () => {
		const sourceRows = [['header'], ['hidden'], ['last-visible'], ['middle-visible']];
		assert.equal(serializeVisibleSelection(sourceRows, [0, 3, 2], { anchor: { row: 3, column: 0 }, focus: { row: 2, column: 0 } }, 1), 'middle-visible\r\nlast-visible');
		assert.equal(serializeVisibleSelection(sourceRows, [0, 3, 2], { anchor: { row: 1, column: 0 }, focus: { row: 2, column: 0 } }, 1), undefined);
	});
	test('prepends visible column labels only for the explicit header action', () => {
		assert.equal(serializeVisibleSelection([['raw', 'x']], [0], { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 1 } }, 2, ['DISPLAY', 'B']), 'DISPLAY\tB\r\nraw\tx');
	});
	test('formats only selected cells for displayed copy and leaves source rows unchanged', () => {
		const rows = [['0.25', 'large'], ['0.5', 'unchanged']];
		const copied = serializeVisibleSelection(rows, [0, 1], { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } }, 2,
			undefined, (_row, column, raw) => column === 0 ? `${Number(raw) * 100}%` : raw);
		assert.equal(copied, '25%');
		assert.deepStrictEqual(rows[0], ['0.25', 'large']);
	});
});

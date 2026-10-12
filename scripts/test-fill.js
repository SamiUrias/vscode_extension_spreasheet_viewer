const assert = require('node:assert/strict');
const { configureLocale } = require('../out/i18n/index.js');
configureLocale('en');
const { createFillEdits } = require('../out/fill.js');
const { SpreadsheetEditSession } = require('../out/edit-model.js');
const { parseCsvBytes } = require('../out/formats/csv.js');

const repeated = createFillEdits([[{ value: '001', type: 'string' }, { value: 'x', type: 'string' }]], 4, 2, 4, 2, 'down', 'repeat');
assert.deepEqual(repeated.map(edit => [edit.row, edit.column, edit.value, edit.targetType]), [
	[5, 2, '001', 'string'], [5, 3, 'x', 'string'],
	[6, 2, '001', 'string'], [6, 3, 'x', 'string'],
	[7, 2, '001', 'string'], [7, 3, 'x', 'string'],
]);

const decimalSeries = createFillEdits([[{ value: '0.1', type: 'number' }], [{ value: '0.2', type: 'number' }]], 0, 0, 5, 1, 'down', 'series');
assert.deepEqual(decimalSeries.map(edit => edit.value), ['0.3', '0.4', '0.5']);
assert(decimalSeries.every(edit => edit.targetType === 'number'));

const horizontal = createFillEdits([[{ value: 'A' }, { value: 'B' }]], 2, 1, 1, 6, 'right', 'repeat');
assert.deepEqual(horizontal.map(edit => edit.value), ['A', 'B', 'A', 'B']);

assert.throws(() => createFillEdits([[{ value: 'x' }]], 0, 0, 100, 100, 'down', 'repeat', 10), /limit/);
assert.throws(() => createFillEdits([[{ value: 'x' }]], 0, 0, 3, 1, 'down', 'series'), /two numeric/ );
const scientific = createFillEdits([[{ value: '1e-2', type: 'number' }], [{ value: '2e-2', type: 'number' }]], 0, 0, 4, 1, 'down', 'series');
assert.deepEqual(scientific.map(edit => edit.value), ['0.03', '0.04']);
assert.throws(() => createFillEdits([[{ value: '1' }], [{ value: 'no es número' }]], 0, 0, 3, 1, 'down', 'series'), /decimal numeric/);

const table = parseCsvBytes(new TextEncoder().encode('a,b,c,d\n' + Array.from({ length: 7 }, () => ',,,').join('\n')));
const session = new SpreadsheetEditSession(table);
const transaction = session.editCells(repeated.map(edit => ({ sheetIndex: 0, ...edit })));
assert.notEqual(transaction, undefined);
assert.equal(session.getCell(0, 5, 2).value, '001');
assert.equal(session.getCell(0, 5, 3).value, 'x');
assert.equal(session.undo(transaction), true);
assert.equal(session.getCell(0, 5, 2).value, '');

console.log('Range fill calculation tests passed');

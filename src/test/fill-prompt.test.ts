import * as assert from 'assert';
import { parseFillDirection, parseFillMode } from '../fill-prompt';

suite('Fill prompt parsing', () => {
	test('maps English and Spanish prompt options to stable enums', () => {
		assert.strictEqual(parseFillDirection(' down '), 'down');
		assert.strictEqual(parseFillDirection('DERECHA'), 'right');
		assert.strictEqual(parseFillMode(' Repeat '), 'repeat');
		assert.strictEqual(parseFillMode('SERIE'), 'series');
		assert.strictEqual(parseFillMode('series'), 'series');
	});

	test('keeps cancellation, empty, and unknown answers cancelled', () => {
		for (const value of [null, undefined, '', '  ', 'left']) {assert.strictEqual(parseFillDirection(value), undefined);}
		for (const value of [null, undefined, '', '  ', 'sequence']) {assert.strictEqual(parseFillMode(value), undefined);}
	});
});

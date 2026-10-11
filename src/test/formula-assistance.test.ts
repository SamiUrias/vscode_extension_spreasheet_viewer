import assert from 'node:assert/strict';
import { completeFormulaFunction, getFormulaCompletions, insertFormulaReference } from '../formula-assistance';

suite('Formula assistance', () => {
	test('offers only verified function names and replaces the token without changing following text', () => {
		const text = '=su+Other!A1';
		const choices = getFormulaCompletions(text, 3);
		assert.deepEqual(choices.map(item => item.name), ['SUMPRODUCT', 'SUBTOTAL']);
		const completion = completeFormulaFunction(text, choices[0]!);
		assert.deepEqual(completion, { value: '=SUMPRODUCT(+Other!A1', cursor: 12 });
		assert.deepEqual(getFormulaCompletions('=SUM(', 5), []);
		assert.deepEqual(getFormulaCompletions('plain=su', 8), []);
	});

	test('inserts selected references at the cursor and keeps the rest of the draft intact', () => {
		assert.deepEqual(insertFormulaReference('=SUM()', 5, 'B3'), { value: '=SUM(B3)', cursor: 7 });
		assert.deepEqual(insertFormulaReference('=A1+', 4, 'C3'), { value: '=A1+C3', cursor: 6 });
		assert.deepEqual(insertFormulaReference('=SUM(A1', 7, 'B3'), { value: '=SUM(A1,B3', cursor: 10 });
	});
});

import assert from 'node:assert/strict';
import initializeWasm, { parse, tokenize } from 'formualizer';
import { transformFormulaReferences, type FormulaParserService } from '../formula-reference';

async function run(): Promise<void> {
	await initializeWasm();
	const parser: FormulaParserService = {
		parseFormula: formula => parse(formula),
		tokenizeFormula: async formula => (await tokenize(formula)).tokens,
	};

	assert.deepEqual(await transformFormulaReferences("=SUM('My Sheet'!$A1:B$2)+IF(C3=\"B2\",D4,D5)",
		{ kind: 'insert', axis: 'row', index: 2, count: 1, formulaSheet: 'My Sheet', targetSheet: 'My Sheet' }, parser),
	{ status: 'transformed', formula: "=SUM('My Sheet'!$A1:B$3)+IF(C4=\"B2\",D5,D6)" });
	assert.deepEqual(await transformFormulaReferences('=$A1+B$2+C3',
		{ kind: 'copy', rowOffset: 2, columnOffset: 1 }, parser),
	{ status: 'transformed', formula: '=$A3+C$2+D5' });
	assert.deepEqual(await transformFormulaReferences('=SUM(A1:A5)',
		{ kind: 'delete', axis: 'row', index: 2, count: 2, formulaSheet: 'Data', targetSheet: 'Data' }, parser),
	{ status: 'transformed', formula: '=SUM(A1:A3)' });
	assert.deepEqual(await transformFormulaReferences('=A2+B5',
		{ kind: 'delete', axis: 'row', index: 2, count: 1, formulaSheet: 'Data', targetSheet: 'Data' }, parser),
	{ status: 'transformed', formula: '=#REF!+B4' });
	assert.deepEqual(await transformFormulaReferences('=SUM(A2:A3)',
		{ kind: 'delete', axis: 'row', index: 2, count: 2, formulaSheet: 'Data', targetSheet: 'Data' }, parser),
	{ status: 'transformed', formula: '=SUM(#REF!)' });
	assert.deepEqual(await transformFormulaReferences('=A1+"B2"',
		{ kind: 'insert', axis: 'column', index: 1, count: 2, formulaSheet: 'Data', targetSheet: 'Data' }, parser),
	{ status: 'transformed', formula: '=C1+"B2"' });
	assert.deepEqual(await transformFormulaReferences('=XFD1', { kind: 'copy', rowOffset: 0, columnOffset: 1 }, parser),
	{ status: 'transformed', formula: '=#REF!' });
	const badReference = await transformFormulaReferences('=[Budget.xlsx]Sheet1!A1+Sheet1:Sheet3!B2',
		{ kind: 'insert', axis: 'row', index: 1, count: 1, formulaSheet: 'Data', targetSheet: 'Data' }, parser);
	assert.equal(badReference.status, 'unsupported');
	assert.equal((await transformFormulaReferences('="B2"', { kind: 'copy', rowOffset: 1, columnOffset: 1 }, parser)).status, 'unchanged');
	assert.deepEqual(await transformFormulaReferences('=Sheet2!A1+A1',
		{ kind: 'insert', axis: 'row', index: 1, count: 1, formulaSheet: 'Sheet1', targetSheet: 'Sheet1' }, parser),
	{ status: 'transformed', formula: '=Sheet2!A1+A2' });
	assert.equal((await transformFormulaReferences(`=${'A1+'.repeat(11_000)}1`,
		{ kind: 'insert', axis: 'row', index: 1, count: 1, formulaSheet: 'Data', targetSheet: 'Data' }, parser)).status, 'unsupported');
}

void run().catch(error => {
	console.error(error);
	process.exitCode = 1;
});

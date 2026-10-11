import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { parseXlsxBytes, serializeXlsxEdits } from '../formats/xlsx';
import { calculateFormulaResults } from '../webview/formula-calculator';

const workbookPath = resolve(process.cwd(), 'src/test/fixtures/xlsx/formula_excel.xlsx');
const bytes = readFileSync(workbookPath);
const workbook = parseXlsxBytes(bytes);
const base64 = bytes.toString('base64');

const expectedFormulaCounts: Record<string, number> = {
	Guia: 0,
	Datos: 0,
	Calculos: 1_050,
	Texto_Fecha: 1_200,
	Busquedas: 600,
	Validaciones: 100,
	Matrices: 18,
};

const expectedStatusCounts: Record<string, { calculated: number; error: number; unsupported: number }> = {
	Guia: { calculated: 0, error: 0, unsupported: 0 },
	Datos: { calculated: 0, error: 0, unsupported: 0 },
	Calculos: { calculated: 1_050, error: 0, unsupported: 0 },
	Texto_Fecha: { calculated: 1_150, error: 0, unsupported: 50 },
	Busquedas: { calculated: 600, error: 0, unsupported: 0 },
	Validaciones: { calculated: 50, error: 0, unsupported: 50 },
	Matrices: { calculated: 10, error: 1, unsupported: 7 },
};

async function run(): Promise<void> {
	assert.deepEqual(workbook.sheets.map(sheet => sheet.name), Object.keys(expectedFormulaCounts), 'La estructura de hojas del archivo de prueba cambió.');

	let formulaCount = 0;
	const resultsBySheet: Record<string, Awaited<ReturnType<typeof calculateFormulaResults>>> = {};
	for (let index = 0; index < workbook.sheets.length; index++) {
		const sheet = workbook.sheets[index];
		assert.ok(sheet);
		const formulaCountInSheet = sheet.cellKinds.flat().filter(kind => kind === 'formula').length;
		assert.equal(formulaCountInSheet, expectedFormulaCounts[sheet.name], `${sheet.name}: cantidad de fórmulas`);
		formulaCount += formulaCountInSheet;
		resultsBySheet[sheet.name] = await calculateFormulaResults(base64, 0, sheet.name, sheet.cellKinds, sheet.rows);
	}
	assert.equal(formulaCount, 2_968, 'Total de fórmulas cubiertas en el XLSX');

	for (const [sheetName, results] of Object.entries(resultsBySheet)) {
		const counts = { calculated: 0, error: 0, unsupported: 0 };
		for (const result of Object.values(results)) {counts[result.status]++;}
		assert.deepEqual(counts, expectedStatusCounts[sheetName], `${sheetName}: perfil de compatibilidad; actual=${JSON.stringify(counts)} esperado=${JSON.stringify(expectedStatusCounts[sheetName])}`);
	}

	const calculations = resultsBySheet.Calculos;
	assert.ok(calculations);
	for (const [cell, value] of Object.entries({
		A2: '1001', B2: '170', C2: '161.5', D2: '19.38', E2: '180.88',
		F2: 'Normal', G2: 'Bajo', H2: 'TRUE', I2: 'FALSE', J2: 'Sin división',
		K2: '5477.9375', L2: '17', N2: '1815', P2: '180.88', Q2: '3', R2: '0.05',
	})) {
		assert.deepEqual(calculations[cell], { status: 'calculated', value }, `Calculos!${cell}`);
	}

	const textAndDate = resultsBySheet.Texto_Fecha;
	assert.ok(textAndDate);
	for (const [cell, value] of Object.entries({ B2: 'Ana López', D2: 'Ana-López', E2: 'ANA LóPEZ', H2: 'Ana', J2: 'na Ló', M2: 'Ana_López', N2: 'Ana López', Q2: '2026', R2: '1', S2: '4' })) {
		assert.deepEqual(textAndDate[cell], { status: 'calculated', value }, `Texto_Fecha!${cell}`);
	}

	const lookups = resultsBySheet.Busquedas;
	assert.ok(lookups);
	assert.deepEqual(lookups.A3, { status: 'calculated', value: '1001' });
	assert.deepEqual(lookups.G3, { status: 'calculated', value: 'Rojo' });
	assert.deepEqual(lookups.J3, { status: 'calculated', value: '6' });
	assert.deepEqual(lookups.B3, { status: 'calculated', value: 'Ana' }, 'VLOOKUP exact match against Datos row 2.');
	assert.deepEqual(lookups.C3, { status: 'calculated', value: 'Bronce' }, 'HLOOKUP exact match against the small horizontal table.');
	assert.deepEqual(lookups.D3, { status: 'calculated', value: 'Ana' }, 'INDEX/MATCH exact match against Datos row 2.');
	assert.deepEqual(lookups.E3, { status: 'calculated', value: '1' }, 'MATCH returns the 1-based position.');
	assert.deepEqual(lookups.F3, { status: 'calculated', value: 'López' });

	const matrix = resultsBySheet.Matrices;
	assert.ok(matrix);
	assert.deepEqual(matrix.B7, { status: 'calculated', value: '27898.75' });
	assert.deepEqual(matrix.B10, { status: 'calculated', value: '27898.75' });
	assert.deepEqual(matrix.B13, { status: 'calculated', value: 'Ana' });
	assert.deepEqual(matrix.B2, { status: 'unsupported', value: '', reason: 'spill' });
	assert.deepEqual(matrix.B9, { status: 'unsupported', value: '', reason: 'unsupported-function' });
	assert.deepEqual(matrix.B11, { status: 'unsupported', value: '', reason: 'unsupported-function' });
	assert.deepEqual(matrix.B19, { status: 'error', value: '#N/A', reason: 'formula-error' }, 'NA() remains a formula error.');

	assert.deepEqual(textAndDate.O2, { status: 'unsupported', value: '', reason: 'date-format' }, 'Known Formualizer serial-zero TEXT date defect stays cache-only.');
	assert.deepEqual(resultsBySheet.Validaciones?.F2, { status: 'unsupported', value: '', reason: 'date-format' }, 'Known Formualizer concatenated TEXT date defect stays cache-only.');

	const originalBytes = bytes.slice();
	const editedBytes = serializeXlsxEdits(bytes, [{ sheetIndex: 1, row: 1, column: 0, value: '2001', type: 'number' }]);
	const editedWorkbook = parseXlsxBytes(editedBytes);
	const editedResults = await calculateFormulaResults(Buffer.from(editedBytes).toString('base64'), 0, 'Calculos', editedWorkbook.sheets[2]!.cellKinds, editedWorkbook.sheets[2]!.rows);
	assert.deepEqual(editedResults.A2, { status: 'calculated', value: '2001' }, 'Editing Datos!A2 recalculates the dependent formula in Calculos!A2.');
	assert.deepEqual(await calculateFormulaResults(base64, 0, 'Calculos', workbook.sheets[2]!.cellKinds, workbook.sheets[2]!.rows), calculations, 'Returning to the original bytes reloads its formula results.');
	assert.deepEqual(bytes, originalBytes, 'Evaluation must not mutate the source workbook or its caches.');

	const invalidNameBytes = bytesWithFormula(bytes, 'B19', 'NOT_A_REAL_FUNCTION()');
	const invalidNameWorkbook = parseXlsxBytes(invalidNameBytes);
	const invalidNameResults = await calculateFormulaResults(
		Buffer.from(invalidNameBytes).toString('base64'), 0, 'Matrices',
		invalidNameWorkbook.sheets[6]!.cellKinds, invalidNameWorkbook.sheets[6]!.rows,
	);
	assert.deepEqual(invalidNameResults.B19, { status: 'error', value: '#NAME?', reason: 'invalid-name' }, 'An invalid function name is a formula error, not an unsupported engine function.');

	for (const system of ['1900', '1904']) {
		const matrixBytes = readFileSync(resolve(process.cwd(), `src/test/fixtures/xlsx/formula_matrix_${system}.xlsx`));
		const matrixWorkbook = parseXlsxBytes(matrixBytes);
		const evaluationStartedAt = Date.now();
		const matrixResults = await calculateFormulaResults(
			matrixBytes.toString('base64'), 0, 'Checks', matrixWorkbook.sheets[1]!.cellKinds, matrixWorkbook.sheets[1]!.rows,
		);
		const matrixArchive = unzipSync(matrixBytes);
		const workbookXml = new TextDecoder().decode(matrixArchive['xl/workbook.xml']);
		assert.match(workbookXml, new RegExp(`date1904="${system === '1904' ? '1' : '0'}"`), `fixture uses the ${system} date system`);
		const { A33: today, ...stableResults } = matrixResults;
		assert.equal(today?.status, 'calculated', `TODAY() is calculated in the ${system} system`);
		assert.match(today?.value ?? '', /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const allowedDates = new Set([localDate(evaluationStartedAt, timeZone), localDate(Date.now(), timeZone)]);
		assert.ok(allowedDates.has(today?.value.slice(0, 10) ?? ''), 'TODAY() matches the bounded local test clock.');
		assert.deepEqual(stableResults, {
			A1: { status: 'calculated', value: 'TRUE' },
			A2: { status: 'calculated', value: '3.5' },
			A3: { status: 'calculated', value: 'zero' },
			A4: { status: 'calculated', value: '3.50' },
			A5: { status: 'calculated', value: 'needle' },
			A6: { status: 'calculated', value: '2' },
			A7: { status: 'calculated', value: '2024-02-29T00:00:00.000Z' },
			A8: { status: 'calculated', value: '2024' },
			A9: { status: 'error', value: '#N/A', reason: 'formula-error' },
			A10: { status: 'error', value: '#NAME?', reason: 'invalid-name' },
			A11: { status: 'calculated', value: '2' },
			A12: { status: 'calculated', value: '1.75' },
			A13: { status: 'calculated', value: '6' },
			A14: { status: 'calculated', value: 'nee' },
			A15: { status: 'calculated', value: '23' },
			A16: { status: 'calculated', value: 'needle' },
			A17: { status: 'calculated', value: 'safe' },
			A18: { status: 'calculated', value: '1' },
			A19: { status: 'unsupported', value: '', reason: 'date-format' },
			A20: { status: 'calculated', value: '0' },
			A21: { status: 'calculated', value: '00123' },
			A22: { status: 'calculated', value: '2' },
			A23: { status: 'calculated', value: '2' },
			A24: { status: 'calculated', value: '3.5' },
			A25: { status: 'calculated', value: '0.029228540769133535' },
			A26: { status: 'calculated', value: '2' },
			A27: { status: 'calculated', value: '29' },
			A28: { status: 'calculated', value: '4' },
			A29: system === '1904' ? { status: 'unsupported', value: '', reason: 'date-system' } : { status: 'calculated', value: '45351' },
			A30: system === '1904' ? { status: 'unsupported', value: '', reason: 'date-system' } : { status: 'calculated', value: '45351' },
			A31: { status: 'calculated', value: '5' },
			A32: { status: 'calculated', value: 'Inputs!$B$2' },
		}, `Independent formula matrix for date system ${system}`);
	}

	console.log('Independent 1900/1904 formula matrices passed (arithmetic, aggregates, text, dates, lookup, references, finance, errors, and array limits).');
	console.log('Formualizer compatibility tests passed: 2,968 formulas across 7 sheets.');
	console.log('Calculated: 2,860; formula errors: 1; explicitly unsupported/cache-only: 107.');
	console.log('Unsupported cases: Formualizer #N/IMPL!, dynamic-array #SPILL!, serial-zero TEXT dates, and EDATE/EOMONTH serials in 1904 books.');
}

function bytesWithFormula(bytes: Uint8Array, reference: string, formula: string): Uint8Array {
	const files = unzipSync(bytes);
	const part = files['xl/worksheets/sheet7.xml'];
	assert.ok(part);
	const xml = new TextDecoder().decode(part);
	const cell = new RegExp(`(<c[^>]*r="${reference}"[^>]*>[\\s\\S]*?<f[^>]*>)[\\s\\S]*?(</f>)`);
	assert.match(xml, cell, `Fixture has formula cell ${reference}.`);
	files['xl/worksheets/sheet7.xml'] = new TextEncoder().encode(xml.replace(cell, `$1${formula}$2`));
	return zipSync(files);
}

function localDate(timestamp: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
		.formatToParts(timestamp).reduce<Record<string, string>>((result, part) => {
			if (part.type !== 'literal') {result[part.type] = part.value;}
			return result;
		}, {});
	return `${parts.year}-${parts.month}-${parts.day}`;
}

void run().catch(error => {
	console.error(error);
	process.exitCode = 1;
});

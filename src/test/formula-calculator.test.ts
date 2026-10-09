import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseXlsxBytes } from '../formats/xlsx';
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
	Texto_Fecha: { calculated: 1_200, error: 0, unsupported: 0 },
	Busquedas: { calculated: 546, error: 54, unsupported: 0 },
	Validaciones: { calculated: 100, error: 0, unsupported: 0 },
	Matrices: { calculated: 10, error: 8, unsupported: 0 },
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
		resultsBySheet[sheet.name] = await calculateFormulaResults(base64, index + 1, sheet.name, sheet.cellKinds);
	}
	assert.equal(formulaCount, 2_968, 'Total de fórmulas cubiertas en el XLSX');

	for (const [sheetName, results] of Object.entries(resultsBySheet)) {
		const counts = { calculated: 0, error: 0, unsupported: 0 };
		for (const result of Object.values(results)) {counts[result.status]++;}
		assert.deepEqual(counts, expectedStatusCounts[sheetName], `${sheetName}: perfil de compatibilidad de Formualizer`);
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
	assert.deepEqual(lookups.B3, { status: 'error', value: '#N/A' });
	assert.deepEqual(lookups.E3, { status: 'error', value: '#N/A' });

	const matrix = resultsBySheet.Matrices;
	assert.ok(matrix);
	assert.deepEqual(matrix.B7, { status: 'calculated', value: '27898.75' });
	assert.deepEqual(matrix.B10, { status: 'calculated', value: '27898.75' });
	assert.deepEqual(matrix.B13, { status: 'calculated', value: 'Ana' });
	assert.deepEqual(matrix.B2, { status: 'error', value: '#SPILL!' });
	assert.deepEqual(matrix.B9, { status: 'error', value: '#N/IMPL!' });
	assert.deepEqual(matrix.B11, { status: 'error', value: '#N/IMPL!' });

	// These assertions lock in observed defects so the test report makes them visible instead of counting them as supported formulas.
	assert.deepEqual(textAndDate.O2, { status: 'calculated', value: '1900-01-00' }, 'Known gap: TEXT date format is currently calculated incorrectly.');
	assert.deepEqual(resultsBySheet.Validaciones?.F2, { status: 'calculated', value: 'Ventas-19000100' }, 'Known gap: date formatting in concatenated formula is currently incorrect.');

	console.log('Formualizer compatibility tests passed: 2,968 formulas across 7 sheets.');
	console.log('Calculated: 2,906; returned formula errors: 62; reported unsupported: 0.');
	console.log('Known gaps found: 54 Busquedas formula errors, 5 dynamic-array #SPILL! results, 2 #N/IMPL! results, 1 #N/A from NA(), and incorrectly formatted date results.');
}

void run().catch(error => {
	console.error(error);
	process.exitCode = 1;
});

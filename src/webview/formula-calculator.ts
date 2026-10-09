import initializeWasm, { Workbook } from 'formualizer';
import type { FormulaEvaluation } from '../protocol';

let loadedRevision: number | undefined;
let workbook: InstanceType<typeof Workbook> | undefined;
let initialization: Promise<void> | undefined;

export async function calculateFormulaResults(
	workbookBase64: string,
	revision: number,
	sheetName: string,
	kinds: readonly (readonly string[])[],
): Promise<Record<string, FormulaEvaluation>> {
	const formulas: Array<{ row: number; column: number }> = [];
	for (let row = 0; row < kinds.length; row++) {
		for (let column = 0; column < (kinds[row]?.length ?? 0); column++) {
			if (kinds[row]?.[column] === 'formula') {formulas.push({ row, column });}
		}
	}
	if (formulas.length === 0) {return {};}

	initialization ??= initializeWasm();
	await initialization;
	if (loadedRevision !== revision || !workbook) {
		workbook = Workbook.fromXlsxBytes(decodeBase64(workbookBase64));
		loadedRevision = revision;
	}

	const results: Record<string, FormulaEvaluation> = {};
	for (const { row, column } of formulas) {
		const reference = `${columnName(column)}${row + 1}`;
		try {
			const value: unknown = workbook.evaluateCell(sheetName, row + 1, column + 1);
			if (typeof value === 'string' && value.toUpperCase() === '#NAME?') {
				results[reference] = { status: 'unsupported', value: '' };
			} else if (typeof value === 'string' && /^#[A-Z0-9/?!]+$/i.test(value)) {
				results[reference] = { status: 'error', value };
			} else {
				results[reference] = { status: 'calculated', value: displayValue(value) };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			results[reference] = /unsupported|unknown function|formula parse|parse error|parse failed|#NAME\??/i.test(message)
				? { status: 'unsupported', value: '' }
				: { status: 'error', value: message };
		}
	}
	return results;
}

function displayValue(value: unknown): string {
	if (value === null || value === undefined) {return '';}
	if (typeof value === 'boolean') {return value ? 'TRUE' : 'FALSE';}
	if (typeof value === 'object') {
		try {return JSON.stringify(value) ?? String(value);}
		catch {return String(value);}
	}
	return String(value);
}

function columnName(column: number): string {
	let name = '';
	for (let index = column + 1; index > 0; index = Math.floor((index - 1) / 26)) {
		name = String.fromCharCode(65 + (index - 1) % 26) + name;
	}
	return name;
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {bytes[index] = binary.charCodeAt(index);}
	return bytes;
}

import initializeWasm, { Workbook } from 'formualizer';
import { unzipSync } from 'fflate';
import type { FormulaEvaluation } from '../protocol';

let loadedRevision: number | undefined;
let loadedWorkbookBytes: string | undefined;
let loadedDate1904: boolean | undefined;
let workbook: InstanceType<typeof Workbook> | undefined;
let initialization: Promise<void> | undefined;

export async function calculateFormulaResults(
	workbookBase64: string,
	revision: number,
	sheetName: string,
	kinds: readonly (readonly string[])[],
	rows?: readonly (readonly string[])[],
): Promise<Record<string, FormulaEvaluation>> {
	const formulas: Array<{ row: number; column: number }> = [];
	for (let row = 0; row < kinds.length; row++) {
		for (let column = 0; column < (kinds[row]?.length ?? 0); column++) {
			if (kinds[row]?.[column] === 'formula') {formulas.push({ row, column });}
		}
	}
	initialization ??= initializeWasm().catch(error => {
		initialization = undefined;
		throw error;
	});
	await initialization;
	if (loadedRevision !== revision || loadedWorkbookBytes !== workbookBase64 || !workbook) {
		workbook?.free();
		workbook = undefined;
		loadedRevision = undefined;
		loadedWorkbookBytes = undefined;
		loadedDate1904 = readDate1904System(workbookBase64);
		loadedRevision = revision;
		loadedWorkbookBytes = workbookBase64;
	}
	if (formulas.length === 0) {return {};}
	if (!workbook) {workbook = Workbook.fromXlsxBytes(decodeBase64(workbookBase64));}

	const results: Record<string, FormulaEvaluation> = {};
	for (const { row, column } of formulas) {
		const reference = `${columnName(column)}${row + 1}`;
		try {
			const value: unknown = workbook.evaluateCell(sheetName, row + 1, column + 1);
			const formula = rows?.[row]?.[column] ?? '';
			if (isKnownIncorrectEpochText(value, formula)) {
				results[reference] = { status: 'unsupported', value: '', reason: 'date-format' };
			} else if (isKnown1904SerialResult(value, formula, loadedDate1904)) {
				results[reference] = { status: 'unsupported', value: '', reason: 'date-system' };
			} else if (typeof value === 'string' && /^#N\/IMPL!$/i.test(value)) {
				results[reference] = { status: 'unsupported', value: '', reason: 'unsupported-function' };
			} else if (typeof value === 'string' && /^#SPILL!$/i.test(value)) {
				results[reference] = { status: 'unsupported', value: '', reason: 'spill' };
			} else if (typeof value === 'string' && /^#[A-Z0-9/?!]+$/i.test(value)) {
				results[reference] = { status: 'error', value, reason: value.toUpperCase() === '#NAME?' ? 'invalid-name' : 'formula-error' };
			} else {
				results[reference] = { status: 'calculated', value: displayValue(value) };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			results[reference] = /not implemented|unsupported|unknown function/i.test(message)
				? { status: 'unsupported', value: '', reason: 'unsupported-function' }
				: { status: 'error', value: message, reason: 'formula-error' };
		}
	}
	return results;
}

/** Formualizer 0.10.1 renders known serial-zero TEXT date cases as January day 00. */
function isKnownIncorrectEpochText(value: unknown, formula: string): boolean {
	return typeof value === 'string' && /(?:^|[^0-9])19000100$|^1900-01-00$/.test(value)
		&& /\bTEXT\s*\(/i.test(formula);
}

function isKnown1904SerialResult(value: unknown, formula: string, date1904: boolean | undefined): boolean {
	return date1904 === true && (typeof value === 'number' || typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
		&& /\b(?:EDATE|EOMONTH)\s*\(/i.test(formula);
}

function readDate1904System(workbookBase64: string): boolean | undefined {
	try {
		const workbookXml = unzipSync(decodeBase64(workbookBase64))['xl/workbook.xml'];
		if (!workbookXml) {return undefined;}
		const match = /<workbookPr\b[^>]*\bdate1904\s*=\s*['"]([^'"]+)['"]/i.exec(new TextDecoder().decode(workbookXml));
		return match ? match[1] === '1' || match[1]?.toLowerCase() === 'true' : false;
	} catch {
		return undefined;
	}
}

function displayValue(value: unknown): string {
	if (value === null || value === undefined) {return '';}
	if (typeof value === 'boolean') {return value ? 'TRUE' : 'FALSE';}
	if (value instanceof Date) {return value.toISOString();}
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

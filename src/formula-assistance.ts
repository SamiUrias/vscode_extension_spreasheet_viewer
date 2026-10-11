export interface FormulaFunctionHelp {
	readonly name: string;
	readonly signature: string;
	readonly description: string;
}

/** Functions exercised by the compatibility fixtures and marked calculated by the bundled engine. */
export const VERIFIED_FORMULA_FUNCTIONS: readonly FormulaFunctionHelp[] = [
	{ name: 'ABS', signature: 'ABS(number)', description: 'Valor absoluto.' },
	{ name: 'AVERAGEIF', signature: 'AVERAGEIF(range, criterion, [average_range])', description: 'Calcula la media de valores que cumplen un criterio.' },
	{ name: 'COUNTIF', signature: 'COUNTIF(range, criterion)', description: 'Cuenta celdas que cumplen un criterio.' },
	{ name: 'COUNTIFS', signature: 'COUNTIFS(criteria_range1, criterion1, ...)', description: 'Cuenta celdas que cumplen varios criterios.' },
	{ name: 'DATE', signature: 'DATE(year, month, day)', description: 'Crea una fecha a partir de sus componentes.' },
	{ name: 'DAY', signature: 'DAY(serial)', description: 'Devuelve el día del mes.' },
	{ name: 'IF', signature: 'IF(condition, value_if_true, [value_if_false])', description: 'Elige un valor según una condición.' },
	{ name: 'IFERROR', signature: 'IFERROR(value, value_if_error)', description: 'Sustituye un resultado de error.' },
	{ name: 'INDEX', signature: 'INDEX(array, row_num, [column_num])', description: 'Devuelve un valor por posición.' },
	{ name: 'LEFT', signature: 'LEFT(text, [num_chars])', description: 'Toma caracteres desde el inicio del texto.' },
	{ name: 'LEN', signature: 'LEN(text)', description: 'Cuenta caracteres.' },
	{ name: 'MATCH', signature: 'MATCH(lookup_value, lookup_array, [match_type])', description: 'Busca la posición de un valor.' },
	{ name: 'MAX', signature: 'MAX(number1, [number2, ...])', description: 'Devuelve el valor mayor.' },
	{ name: 'MIN', signature: 'MIN(number1, [number2, ...])', description: 'Devuelve el valor menor.' },
	{ name: 'MONTH', signature: 'MONTH(serial)', description: 'Devuelve el mes.' },
	{ name: 'ROUND', signature: 'ROUND(number, num_digits)', description: 'Redondea a la cantidad indicada de decimales.' },
	{ name: 'SUMPRODUCT', signature: 'SUMPRODUCT(array1, [array2, ...])', description: 'Suma los productos de matrices correspondientes.' },
	{ name: 'SUBTOTAL', signature: 'SUBTOTAL(function_num, ref1, [ref2, ...])', description: 'Calcula un subtotal con una operación seleccionada.' },
	{ name: 'UPPER', signature: 'UPPER(text)', description: 'Convierte el texto a mayúsculas.' },
	{ name: 'VLOOKUP', signature: 'VLOOKUP(value, table, column_index, [approximate])', description: 'Busca en la primera columna de una tabla.' },
	{ name: 'YEAR', signature: 'YEAR(serial)', description: 'Devuelve el año.' },
];

export interface FormulaCompletion {
	readonly name: string;
	readonly signature: string;
	readonly description: string;
	readonly start: number;
	readonly end: number;
}

export function getFormulaCompletions(value: string, cursor: number): FormulaCompletion[] {
	const end = Math.max(0, Math.min(value.length, cursor));
	const before = value.slice(0, end);
	const match = /([A-Za-z][A-Za-z0-9.]*)$/.exec(before);
	if (!match || !before.startsWith('=')) {return [];}
	const query = match[1]!.toUpperCase();
	if (VERIFIED_FORMULA_FUNCTIONS.some(item => item.name === query)) {return [];}
	const start = end - match[1]!.length;
	return VERIFIED_FORMULA_FUNCTIONS.filter(item => item.name.startsWith(query))
		.map(item => ({ ...item, start, end }));
}

export function completeFormulaFunction(value: string, completion: FormulaCompletion): { value: string; cursor: number } {
	const insertion = `${completion.name}(`;
	const result = value.slice(0, completion.start) + insertion + value.slice(completion.end);
	return { value: result, cursor: completion.start + insertion.length };
}

export function insertFormulaReference(value: string, cursor: number, reference: string): { value: string; cursor: number } {
	const position = Math.max(0, Math.min(value.length, cursor));
	const prefix = position > 0 && !/[=(,+\-*/^&<>:]\s*$/.test(value.slice(0, position)) ? ',' : '';
	const insertion = `${prefix}${reference}`;
	return { value: value.slice(0, position) + insertion + value.slice(position), cursor: position + insertion.length };
}

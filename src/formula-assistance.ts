import { t, type MessageKey } from './i18n';

export interface FormulaFunctionHelp {
	readonly name: string;
	readonly signature: string;
	readonly descriptionKey: MessageKey;
}

/** Functions exercised by the compatibility fixtures and marked calculated by the bundled engine. */
export const VERIFIED_FORMULA_FUNCTIONS: readonly FormulaFunctionHelp[] = [
	{ name: 'ABS', signature: 'ABS(number)', descriptionKey: 'domain.formula.help.abs' },
	{ name: 'AVERAGEIF', signature: 'AVERAGEIF(range, criterion, [average_range])', descriptionKey: 'domain.formula.help.averageif' },
	{ name: 'COUNTIF', signature: 'COUNTIF(range, criterion)', descriptionKey: 'domain.formula.help.countif' },
	{ name: 'COUNTIFS', signature: 'COUNTIFS(criteria_range1, criterion1, ...)', descriptionKey: 'domain.formula.help.countifs' },
	{ name: 'DATE', signature: 'DATE(year, month, day)', descriptionKey: 'domain.formula.help.date' },
	{ name: 'DAY', signature: 'DAY(serial)', descriptionKey: 'domain.formula.help.day' },
	{ name: 'IF', signature: 'IF(condition, value_if_true, [value_if_false])', descriptionKey: 'domain.formula.help.if' },
	{ name: 'IFERROR', signature: 'IFERROR(value, value_if_error)', descriptionKey: 'domain.formula.help.iferror' },
	{ name: 'INDEX', signature: 'INDEX(array, row_num, [column_num])', descriptionKey: 'domain.formula.help.index' },
	{ name: 'LEFT', signature: 'LEFT(text, [num_chars])', descriptionKey: 'domain.formula.help.left' },
	{ name: 'LEN', signature: 'LEN(text)', descriptionKey: 'domain.formula.help.len' },
	{ name: 'MATCH', signature: 'MATCH(lookup_value, lookup_array, [match_type])', descriptionKey: 'domain.formula.help.match' },
	{ name: 'MAX', signature: 'MAX(number1, [number2, ...])', descriptionKey: 'domain.formula.help.max' },
	{ name: 'MIN', signature: 'MIN(number1, [number2, ...])', descriptionKey: 'domain.formula.help.min' },
	{ name: 'MONTH', signature: 'MONTH(serial)', descriptionKey: 'domain.formula.help.month' },
	{ name: 'ROUND', signature: 'ROUND(number, num_digits)', descriptionKey: 'domain.formula.help.round' },
	{ name: 'SUMPRODUCT', signature: 'SUMPRODUCT(array1, [array2, ...])', descriptionKey: 'domain.formula.help.sumproduct' },
	{ name: 'SUBTOTAL', signature: 'SUBTOTAL(function_num, ref1, [ref2, ...])', descriptionKey: 'domain.formula.help.subtotal' },
	{ name: 'UPPER', signature: 'UPPER(text)', descriptionKey: 'domain.formula.help.upper' },
	{ name: 'VLOOKUP', signature: 'VLOOKUP(value, table, column_index, [approximate])', descriptionKey: 'domain.formula.help.vlookup' },
	{ name: 'YEAR', signature: 'YEAR(serial)', descriptionKey: 'domain.formula.help.year' },
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
		.map(item => ({ name: item.name, signature: item.signature, description: t(item.descriptionKey), start, end }));
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

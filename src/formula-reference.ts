import type { ASTNodeData, Token } from 'formualizer' with { 'resolution-mode': 'import' };

export interface FormulaParserService {
	parseFormula(formula: string): Promise<ASTNodeData>;
	tokenizeFormula(formula: string): Promise<readonly Token[]>;
}

export type ReferenceTransform =
	| { readonly kind: 'insert' | 'delete'; readonly axis: 'row' | 'column'; readonly index: number; readonly count: number; readonly formulaSheet: string; readonly targetSheet: string }
	| { readonly kind: 'copy'; readonly rowOffset: number; readonly columnOffset: number };

export type FormulaTransformResult =
	| { readonly status: 'transformed'; readonly formula: string }
	| { readonly status: 'unchanged'; readonly formula: string }
	| { readonly status: 'unsupported'; readonly formula: string; readonly reason: string };

const MAX_FORMULA_LENGTH = 32 * 1024;
const MAX_ROW = 1_048_576;
const MAX_COLUMN = 16_384;
const CELL_COORDINATE = /^(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)$/i;
const SHEET_PREFIX = /^(?:(?:'(?:[^']|'')+')|(?:[A-Za-z_][A-Za-z0-9_.]*))!/;

/** Applies A1 reference edits using parser spans and patches only those spans in the original text. */
export async function transformFormulaReferences(
	formula: string,
	operation: ReferenceTransform,
	parser: FormulaParserService,
): Promise<FormulaTransformResult> {
	if (formula.length > MAX_FORMULA_LENGTH) {return unsupported(formula, `La fórmula supera el límite de ${MAX_FORMULA_LENGTH.toLocaleString()} caracteres.`);}
	if (operation.kind !== 'copy' && (!Number.isSafeInteger(operation.index) || operation.index < 1
		|| !Number.isSafeInteger(operation.count) || operation.count < 1 || !operation.formulaSheet || !operation.targetSheet)) {
		return unsupported(formula, 'La operación de referencias requiere una posición y cantidad positivas.');
	}
	if (operation.kind !== 'copy') {
		const limit = operation.axis === 'row' ? MAX_ROW : MAX_COLUMN;
		if (operation.index > limit || operation.count > limit - operation.index + 1) {
			return unsupported(formula, `La operación excede el límite de ${limit.toLocaleString()} ${operation.axis === 'row' ? 'filas' : 'columnas'} de Excel.`);
		}
	}
	if (operation.kind === 'copy' && (!Number.isSafeInteger(operation.rowOffset) || !Number.isSafeInteger(operation.columnOffset))) {
		return unsupported(formula, 'El desplazamiento de copia debe usar coordenadas enteras.');
	}
	try {
		const [ast, tokens] = await Promise.all([parser.parseFormula(formula), parser.tokenizeFormula(formula)]);
		if (containsUnsupportedAstError(ast)) {return unsupported(formula, 'El parser encontró una sintaxis de fórmula no compatible.');}
		const references: ReferenceSpan[] = [];
		collectReferences(ast, references);
		const rangeTokens = tokens.filter(token => token.tokenType.toLowerCase() === 'operand' && token.subtype.toLowerCase() === 'range');
		if (rangeTokens.length !== references.length) {
			return unsupported(formula, 'No se pudieron asociar todas las referencias a spans del parser.');
		}
		const patches: Array<{ start: number; end: number; value: string }> = [];
		for (const reference of references) {
			if (!Number.isInteger(reference.start) || !Number.isInteger(reference.end) || reference.start < 0 || reference.end <= reference.start || reference.end > formula.length) {
				return unsupported(formula, 'El parser devolvió una ubicación de referencia fuera de la fórmula.');
			}
			const token = rangeTokens.find(item => item.pos === reference.start && item.end === reference.end);
			if (!token || formula.slice(reference.start, reference.end) !== token.value) {
				return unsupported(formula, 'El texto original no coincide con el span de la referencia.');
			}
			const parsed = parseReferenceText(token.value);
			if (!parsed || !referenceCoordinatesMatch(reference.data, parsed)) {
				return unsupported(formula, `La referencia «${token.value}» está fuera del perfil A1 admitido.`);
			}
			if (operation.kind !== 'copy' && !referenceTargetsSheet(reference.data.sheet, operation)) {continue;}
			const transformed = transformParsedReference(parsed, operation);
			if (transformed !== token.value) {patches.push({ start: reference.start, end: reference.end, value: transformed });}
		}
		if (patches.length === 0) {return { status: 'unchanged', formula };}
		let result = formula;
		for (const patch of patches.sort((left, right) => right.start - left.start)) {
			result = result.slice(0, patch.start) + patch.value + result.slice(patch.end);
		}
		await parser.parseFormula(result);
		return { status: 'transformed', formula: result };
	} catch (error) {
		return unsupported(formula, error instanceof Error ? error.message : String(error));
	}
}

interface Coordinate { readonly columnText: string; readonly rowText: string; readonly columnAbsolute: boolean; readonly rowAbsolute: boolean; readonly column: number; readonly row: number; }
interface ParsedReference { readonly prefix: string; readonly first: Coordinate; readonly second?: Coordinate; }
interface ReferenceSpan { readonly start: number; readonly end: number; readonly data: NonNullable<ASTNodeData['reference']>; }

function collectReferences(node: ASTNodeData, output: ReferenceSpan[]): void {
	if (node.type === 'reference' && node.reference && node.sourceStart !== undefined && node.sourceEnd !== undefined) {
		output.push({ start: node.sourceStart, end: node.sourceEnd, data: node.reference });
	}
	if (node.left) {collectReferences(node.left, output);}
	if (node.right) {collectReferences(node.right, output);}
	if (node.operand) {collectReferences(node.operand, output);}
	for (const argument of node.args ?? []) {collectReferences(argument, output);}
	for (const row of node.elements ?? []) {for (const element of row) {collectReferences(element, output);}}
}

function containsUnsupportedAstError(node: ASTNodeData): boolean {
	return node.type === 'error' || Boolean(node.left && containsUnsupportedAstError(node.left))
		|| Boolean(node.right && containsUnsupportedAstError(node.right)) || Boolean(node.operand && containsUnsupportedAstError(node.operand))
		|| (node.args ?? []).some(containsUnsupportedAstError) || (node.elements ?? []).some(row => row.some(containsUnsupportedAstError));
}

function parseReferenceText(value: string): ParsedReference | undefined {
	const prefixMatch = SHEET_PREFIX.exec(value);
	const prefix = prefixMatch?.[0] ?? '';
	if (prefix.startsWith('[') || prefix.startsWith("'") && prefix.slice(1, prefix.lastIndexOf("'")).includes(':')) {return undefined;}
	const rangeText = value.slice(prefix.length);
	const parts = rangeText.split(':');
	if (parts.length < 1 || parts.length > 2) {return undefined;}
	const first = parseCoordinate(parts[0]!); const second = parts.length === 2 ? parseCoordinate(parts[1]!) : undefined;
	if (!first || parts.length === 2 && !second) {return undefined;}
	return { prefix, first, ...(second ? { second } : {}) };
}

function parseCoordinate(text: string): Coordinate | undefined {
	const match = CELL_COORDINATE.exec(text);
	if (!match) {return undefined;}
	const columnText = match[2]!; const rowText = match[4]!;
	let column = 0;
	for (const character of columnText.toUpperCase()) {column = column * 26 + character.charCodeAt(0) - 64;}
	const row = Number(rowText);
	if (column < 1 || column > MAX_COLUMN || row < 1 || row > MAX_ROW) {return undefined;}
	return { columnText, rowText, columnAbsolute: match[1] === '$', rowAbsolute: match[3] === '$', column, row };
}

function referenceCoordinatesMatch(data: NonNullable<ASTNodeData['reference']>, parsed: ParsedReference): boolean {
	const { first, second } = parsed;
	return data.rowStart === first.row && data.colStart === first.column
		&& data.rowAbsStart === first.rowAbsolute && data.colAbsStart === first.columnAbsolute
		&& data.rowEnd === (second?.row ?? first.row) && data.colEnd === (second?.column ?? first.column)
		&& data.rowAbsEnd === (second?.rowAbsolute ?? first.rowAbsolute)
		&& data.colAbsEnd === (second?.columnAbsolute ?? first.columnAbsolute);
}

function referenceTargetsSheet(referenceSheet: string | undefined, operation: Extract<ReferenceTransform, { kind: 'insert' | 'delete' }>): boolean {
	const target = operation.targetSheet.toLowerCase();
	return (referenceSheet ?? operation.formulaSheet).toLowerCase() === target;
}

function transformParsedReference(reference: ParsedReference, operation: ReferenceTransform): string {
	const first = { ...reference.first }; const second = reference.second ? { ...reference.second } : undefined;
	for (const coordinate of second ? [first, second] : [first]) {
		if (operation.kind === 'copy') {
			if (!coordinate.rowAbsolute) {coordinate.row += operation.rowOffset;}
			if (!coordinate.columnAbsolute) {coordinate.column += operation.columnOffset;}
		} else {
			const property = operation.axis === 'row' ? 'row' : 'column';
			const limit = operation.axis === 'row' ? MAX_ROW : MAX_COLUMN;
			const value = coordinate[property];
			if (operation.kind === 'insert' && value >= operation.index) {coordinate[property] += operation.count;}
			if (operation.kind === 'delete') {
				const deletedEnd = operation.index + operation.count - 1;
				if (!second && value >= operation.index && value <= deletedEnd) {return '#REF!';}
				if (second) {
					const start = first[property]; const end = second[property];
					const low = Math.min(start, end); const high = Math.max(start, end);
					if (low >= operation.index && high <= deletedEnd) {return '#REF!';}
					const nextLow = low > deletedEnd ? low - operation.count : low >= operation.index ? operation.index : low;
					const nextHigh = high > deletedEnd ? high - operation.count : high >= operation.index ? operation.index - 1 : high;
					if (nextLow > nextHigh) {return '#REF!';}
					const reverse = start > end;
					first[property] = reverse ? nextHigh : nextLow;
					second[property] = reverse ? nextLow : nextHigh;
					break;
				}
				if (value > deletedEnd) {coordinate[property] -= operation.count;}
			}
			if (coordinate[property] < 1) {return '#REF!';}
			if (coordinate[property] > limit) {return '#REF!';}
		}
		if (coordinate.row < 1 || coordinate.column < 1 || coordinate.row > MAX_ROW || coordinate.column > MAX_COLUMN) {return '#REF!';}
	}
	return reference.prefix + formatCoordinate(first) + (second ? `:${formatCoordinate(second)}` : '');
}

function formatCoordinate(coordinate: Coordinate): string {
	const column = columnName(coordinate.column);
	const columnText = coordinate.columnText === coordinate.columnText.toLowerCase() ? column.toLowerCase() : column;
	return `${coordinate.columnAbsolute ? '$' : ''}${columnText}${coordinate.rowAbsolute ? '$' : ''}${coordinate.row}`;
}

function columnName(column: number): string {let value = ''; while (column > 0) {column--; value = String.fromCharCode(65 + column % 26) + value; column = Math.floor(column / 26);} return value;}

function unsupported(formula: string, reason: string): FormulaTransformResult {return { status: 'unsupported', formula, reason };}

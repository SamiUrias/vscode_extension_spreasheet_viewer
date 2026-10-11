import { parseCsvBytes, serializeCsvEdits, serializeCsvRowOperation, type CsvRowOperation, type CsvTable } from './formats/csv';
import { parseXlsxBytes, serializeXlsxEdits, type XlsxCellEdit, type XlsxStoredType, type XlsxWorkbook } from './formats/xlsx';
import { applyXlsxStructureOperation, type XlsxStructureOperation } from './formats/xlsx-structure';
import { applyXlsxTableOperation, type XlsxTableOperation } from './formats/xlsx-tables';
import { validateFormulaExpression, type FormulaParserService } from './formula-reference';
import { serializeOdsEdits, type OdsWorkbook } from './formats/ods';
import { isCellCoveredByRange } from './cell-reference';

export type EditableCellType = 'string' | 'number' | 'boolean' | 'date' | 'formula';

export interface CellValue {
	readonly value: string;
	readonly type: EditableCellType;
	readonly storedType: XlsxStoredType | 'csv';
	readonly exists: boolean;
}

interface CellEdit extends CellValue {
	readonly sheetIndex: number;
	readonly row: number;
	readonly column: number;
}

export interface CellEditInput {
	readonly sheetIndex: number; readonly row: number; readonly column: number; readonly value: string; readonly targetType?: EditableCellType;
}
export interface FormulaEditInput { readonly sheetIndex: number; readonly row: number; readonly column: number; readonly formula: string; }
interface CellChange { readonly key: string; readonly before: CellEdit | undefined; readonly after: CellEdit | undefined; }
interface EditState { readonly csv: CsvTable; readonly edits: Map<string, CellEdit>; }
interface XlsxStructureState { readonly workbook: XlsxWorkbook; readonly bytes: Uint8Array; }
interface EditTransaction {
	readonly id: number; readonly changes?: readonly CellChange[]; readonly before?: EditState; readonly after?: EditState;
	readonly structureBefore?: XlsxStructureState; readonly structureAfter?: XlsxStructureState;
}

/** In-memory edit journal. Serialization always returns a new byte array. */
export class SpreadsheetEditSession {
	private readonly edits = new Map<string, CellEdit>();
	private readonly undoStack: EditTransaction[] = [];
	private readonly redoStack: EditTransaction[] = [];
	private nextTransactionId = 1;

	constructor(
		private csv?: CsvTable,
		private xlsx?: XlsxWorkbook,
		private xlsxBytes?: Uint8Array,
		private readonly ods?: OdsWorkbook,
		private readonly odsBytes?: Uint8Array,
	) {}

	get hasEdits(): boolean {
		return this.edits.size > 0 || this.undoStack.some(transaction => transaction.structureAfter !== undefined);
	}

	get csvTable(): CsvTable | undefined {return this.csv;}
	get xlsxWorkbook(): XlsxWorkbook | undefined {return this.xlsx;}

	async applyXlsxStructure(operation: XlsxStructureOperation, parser?: FormulaParserService): Promise<number> {
		if (!this.xlsx || !this.xlsxBytes) {throw new Error('La operación estructural solo está disponible para XLSX.');}
		if (this.edits.size) {throw new Error('Guarda o deshaz las ediciones de celdas antes de cambiar la estructura XLSX.');}
		const result = await applyXlsxStructureOperation(this.xlsxBytes, operation, parser);
		const before: XlsxStructureState = { workbook: this.xlsx, bytes: result.before };
		const after: XlsxStructureState = { workbook: parseXlsxBytes(result.after), bytes: result.after };
		this.restoreXlsxStructure(after);
		const id = this.nextTransactionId++;
		this.undoStack.push({ id, structureBefore: before, structureAfter: after });
		this.redoStack.length = 0;
		return id;
	}

	applyXlsxTable(operation: XlsxTableOperation): number {
		if (!this.xlsx || !this.xlsxBytes) {throw new Error('La creación de tablas solo está disponible para XLSX.');}
		if (this.edits.size) {throw new Error('Guarda o deshaz los cambios pendientes antes de crear una tabla XLSX.');}
		const result = applyXlsxTableOperation(this.xlsxBytes, operation);
		const before: XlsxStructureState = { workbook: this.xlsx, bytes: result.before };
		const after: XlsxStructureState = { workbook: parseXlsxBytes(result.after), bytes: result.after };
		this.restoreXlsxStructure(after);
		const id = this.nextTransactionId++;
		this.undoStack.push({ id, structureBefore: before, structureAfter: after });
		this.redoStack.length = 0;
		return id;
	}

	applyCsvRowOperation(operation: CsvRowOperation): number {
		if (!this.csv) {throw new Error('La operación de registros solo está disponible para documentos CSV.');}
		const currentBytes = serializeCsvEdits(this.csv, [...this.edits.values()].map(edit => ({ row: edit.row, column: edit.column, value: edit.value })));
		const current = parseCsvBytes(currentBytes, { delimiter: this.csv.delimiter, quoteChar: this.csv.quoteChar, quotes: this.csv.quotes, commentPrefix: this.csv.commentPrefix });
		const resultBytes = serializeCsvRowOperation(current, operation);
		const next = parseCsvBytes(resultBytes, { delimiter: current.delimiter, quoteChar: current.quoteChar, quotes: current.quotes, commentPrefix: current.commentPrefix });
		const before: EditState = { csv: this.csv, edits: new Map(this.edits) };
		this.csv = next;
		this.edits.clear();
		const after: EditState = { csv: next, edits: new Map() };
		const id = this.nextTransactionId++;
		this.undoStack.push({ id, before, after });
		this.redoStack.length = 0;
		return id;
	}

	getRows(sheetIndex: number): string[][] {
		return this.getSheetSnapshot(sheetIndex).rows;
	}

	getSheetSnapshot(sheetIndex: number): { rows: string[][]; cellKinds?: string[][]; cellTypes?: XlsxStoredType[][]; formulaCaches?: Record<string, string> } {
		const source = this.csv ? this.csv.rows : (this.xlsx ?? this.ods)?.sheets[sheetIndex]?.rows;
		if (!source) {throw new Error('La hoja solicitada no existe.');}
		const rows = source.map(row => [...row]);
		const sheet = (this.xlsx ?? this.ods)?.sheets[sheetIndex];
		const cellKinds = sheet?.cellKinds.map(row => [...row]);
		const cellTypes = sheet?.cellTypes.map(row => [...row]);
		const formulaCaches = sheet ? { ...sheet.formulaCaches } : undefined;
		for (const edit of this.edits.values()) {
			if (edit.sheetIndex !== sheetIndex || !rows[edit.row]) {continue;}
			rows[edit.row]![edit.column] = edit.value;
			if (cellKinds && cellTypes) {
				while (cellKinds[edit.row]!.length <= edit.column) {cellKinds[edit.row]!.push('missing');}
				while (cellTypes[edit.row]!.length <= edit.column) {cellTypes[edit.row]!.push('missing');}
				cellKinds[edit.row]![edit.column] = edit.type === 'formula' ? 'formula' : edit.value.length === 0 ? 'empty' : 'value';
				cellTypes[edit.row]![edit.column] = edit.type === 'formula' ? 'formula' : edit.storedType as XlsxStoredType;
				if (edit.type === 'formula') {formulaCaches![cellReference(edit.row, edit.column)] = '';}
			}
		}
		return { rows, ...(cellKinds ? { cellKinds } : {}), ...(cellTypes ? { cellTypes } : {}), ...(formulaCaches ? { formulaCaches } : {}) };
	}

	getCell(sheetIndex: number, row: number, column: number): CellValue {
		this.assertInRange(sheetIndex, row, column);
		const key = cellKey(sheetIndex, row, column);
		return this.edits.get(key) ?? this.original(sheetIndex, row, column);
	}

	editCell(sheetIndex: number, row: number, column: number, value: string, targetType?: EditableCellType): number | undefined {
		return this.editCells([{ sheetIndex, row, column, value, ...(targetType ? { targetType } : {}) }]);
	}

	/** Preflights every cell first, then records one reversible journal transaction. */
	editCells(inputs: readonly CellEditInput[]): number | undefined {
		if (inputs.length === 0) {return undefined;}
		const keys = new Set<string>();
		const changes: CellChange[] = [];
		for (const input of inputs) {
			const { sheetIndex, row, column, value, targetType } = input;
			if (this.ods?.sheets[sheetIndex]?.odsMetadata?.protected) {throw new Error('La hoja ODS está protegida y no se puede editar.');}
			const xlsxSheet = this.xlsx?.sheets[sheetIndex];
			if (xlsxSheet?.metadata?.protected) {throw new Error('La hoja XLSX está protegida y no se puede editar.');}
			if (xlsxSheet?.metadata?.mergedRanges.some(range => isCellCoveredByRange(range, row, column))
				|| this.ods?.sheets[sheetIndex]?.odsMetadata?.mergedRanges.some(range => isCellCoveredByRange(range, row, column))) {
				throw new Error('La celda está cubierta por una combinación y no se puede editar directamente.');
			}
			const beforeValue = this.getCell(sheetIndex, row, column);
			if (beforeValue.storedType === 'formula' || beforeValue.storedType === 'error' || beforeValue.storedType === 'unsupported' || beforeValue.storedType === 'duration') {
				throw new Error('Esta celda XLSX no se puede editar en esta etapa.');
			}
			if (this.csv && targetType !== undefined && targetType !== 'string') {throw new Error('Las celdas CSV se conservan como texto.');}
			const type = targetType ?? beforeValue.type;
			validateValue(type, value);
			const key = cellKey(sheetIndex, row, column);
			if (keys.has(key)) {throw new Error('La transacción contiene una celda repetida.');}
			keys.add(key);
			const after: CellEdit = { sheetIndex, row, column, value, type, storedType: type, exists: true };
			const normalized = equivalent(after, this.original(sheetIndex, row, column)) ? undefined : after;
			const before = this.edits.get(key);
			if (!sameEdit(before, normalized)) {changes.push({ key, before, after: normalized });}
		}
		if (changes.length === 0) {return undefined;}
		for (const change of changes) {this.assign(change.key, change.after);}
		const transaction = { id: this.nextTransactionId++, changes };
		this.undoStack.push(transaction);
		this.redoStack.length = 0;
		return transaction.id;
	}

	async editFormula(sheetIndex: number, row: number, column: number, formula: string, parser: FormulaParserService): Promise<number | undefined> {
		if (!this.xlsx || !this.xlsxBytes) {throw new Error('La edición de fórmulas solo está disponible en libros XLSX.');}
		if (this.xlsx.sheets[sheetIndex]?.metadata?.protected) {throw new Error('La hoja XLSX está protegida y no se puede editar.');}
		const sheet = this.xlsx.sheets[sheetIndex];
		if (!sheet || !Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0 || row >= sheet.rowCount || column >= sheet.columnCount) {
			throw new Error('La celda está fuera del rango actual.');
		}
		if (sheet.metadata?.mergedRanges.some(range => isCellCoveredByRange(range, row, column))) {
			throw new Error('La celda está cubierta por una combinación y no se puede editar directamente.');
		}
		await validateFormulaExpression(formula, parser);
		// Exercise ZIP/XML constraints before mutating the undo journal. This also blocks edits to
		// shared/array formulas and unsupported cell records that the writer cannot safely replace.
		serializeXlsxEdits(this.serializeCopy(), [{ sheetIndex, row, column, value: formula, type: 'formula' }]);
		const key = cellKey(sheetIndex, row, column);
		const before = this.edits.get(key);
		const original = this.original(sheetIndex, row, column);
		const after: CellEdit = { sheetIndex, row, column, value: formula, type: 'formula', storedType: 'formula', exists: true };
		const normalized = equivalent(after, original) ? undefined : after;
		if (sameEdit(before, normalized)) {return undefined;}
		this.assign(key, normalized);
		const transaction = { id: this.nextTransactionId++, changes: [{ key, before, after: normalized }] };
		this.undoStack.push(transaction);
		this.redoStack.length = 0;
		return transaction.id;
	}

	/** Validates and preflights the whole set before recording one undoable formula transaction. */
	async editFormulas(inputs: readonly FormulaEditInput[], parser: FormulaParserService): Promise<number | undefined> {
		await this.validateFormulaBatch(inputs, parser);
		if (!inputs.length) {return undefined;}
		const changes: CellChange[] = [];
		for (const input of inputs) {
			const key = cellKey(input.sheetIndex, input.row, input.column);
			const original = this.original(input.sheetIndex, input.row, input.column);
			const after: CellEdit = { sheetIndex: input.sheetIndex, row: input.row, column: input.column, value: input.formula, type: 'formula', storedType: 'formula', exists: true };
			const normalized = equivalent(after, original) ? undefined : after;
			const before = this.edits.get(key);
			if (!sameEdit(before, normalized)) {changes.push({ key, before, after: normalized });}
		}
		if (!changes.length) {return undefined;}
		for (const change of changes) {this.assign(change.key, change.after);}
		const transaction = { id: this.nextTransactionId++, changes };
		this.undoStack.push(transaction);
		this.redoStack.length = 0;
		return transaction.id;
	}

	async validateFormulaBatch(inputs: readonly FormulaEditInput[], parser: FormulaParserService): Promise<void> {
		if (!this.xlsx || !this.xlsxBytes) {throw new Error('La edición de fórmulas solo está disponible en libros XLSX.');}
		if (!inputs.length) {throw new Error('El rango no contiene fórmulas de destino.');}
		const keys = new Set<string>();
		for (const input of inputs) {
			const sheet = this.xlsx.sheets[input.sheetIndex];
			if (!sheet || !Number.isInteger(input.row) || !Number.isInteger(input.column) || input.row < 0 || input.column < 0
				|| input.row >= sheet.rowCount || input.column >= sheet.columnCount) {throw new Error('Una fórmula está fuera del rango actual.');}
			if (sheet.metadata?.protected || sheet.metadata?.mergedRanges.some(range => isCellCoveredByRange(range, input.row, input.column))) {throw new Error('El rango incluye una celda protegida o combinada.');}
			const key = cellKey(input.sheetIndex, input.row, input.column);
			if (keys.has(key)) {throw new Error('La transacción contiene una celda repetida.');}
			keys.add(key);
			await validateFormulaExpression(input.formula, parser);
		}
		const xlsxEdits: XlsxCellEdit[] = inputs.map(input => ({ sheetIndex: input.sheetIndex, row: input.row, column: input.column, value: input.formula, type: 'formula' }));
		serializeXlsxEdits(this.serializeCopy(), xlsxEdits);
	}

	undo(transactionId?: number): boolean {
		if (transactionId !== undefined && this.undoStack[this.undoStack.length - 1]?.id !== transactionId) {return false;}
		const transaction = this.undoStack.pop();
		if (!transaction) {return false;}
		if (transaction.structureBefore) {this.restoreXlsxStructure(transaction.structureBefore);}
		else if (transaction.before) {this.restoreState(transaction.before);}
		else {for (const change of [...transaction.changes ?? []].reverse()) {this.assign(change.key, change.before);}}
		this.redoStack.push(transaction);
		return true;
	}

	redo(transactionId?: number): boolean {
		if (transactionId !== undefined && this.redoStack[this.redoStack.length - 1]?.id !== transactionId) {return false;}
		const transaction = this.redoStack.pop();
		if (!transaction) {return false;}
		if (transaction.structureAfter) {this.restoreXlsxStructure(transaction.structureAfter);}
		else if (transaction.after) {this.restoreState(transaction.after);}
		else {for (const change of transaction.changes ?? []) {this.assign(change.key, change.after);}}
		this.undoStack.push(transaction);
		return true;
	}

	private restoreXlsxStructure(state: XlsxStructureState): void {
		this.xlsx = state.workbook;
		this.xlsxBytes = state.bytes.slice();
		this.edits.clear();
	}

	serializeCopy(): Uint8Array {
		if (this.csv) {
			return serializeCsvEdits(this.csv, [...this.edits.values()].map(edit => ({ row: edit.row, column: edit.column, value: edit.value })));
		}
		if (this.xlsx) {
			const edits: XlsxCellEdit[] = [...this.edits.values()].map(edit => ({
				sheetIndex: edit.sheetIndex, row: edit.row, column: edit.column, value: edit.value, type: edit.type,
			}));
			// XLSX coordinates are zero-based here and are bounded by the loaded sheet dimensions.
			if (!this.xlsxBytes) {
				throw new Error('No se conservaron los bytes de origen del XLSX.');
			}
			return serializeXlsxEdits(this.xlsxBytes, edits);
		}
		if (this.ods) {
			const edits: XlsxCellEdit[] = [...this.edits.values()].map(edit => ({
				sheetIndex: edit.sheetIndex, row: edit.row, column: edit.column, value: edit.value, type: edit.type,
			}));
			if (!this.odsBytes) {throw new Error('No se conservaron los bytes de origen del ODS.');}
			return serializeOdsEdits(this.odsBytes, edits);
		}
		throw new Error('No hay un documento tabular para serializar.');
	}

	private original(sheetIndex: number, row: number, column: number): CellValue {
		if (this.csv) {
			return { value: this.csv.rows[row]?.[column] ?? '', type: 'string', storedType: 'csv', exists: column < (this.csv.rows[row]?.length ?? 0) };
		}
		const sheet = (this.xlsx ?? this.ods)?.sheets[sheetIndex];
		const storedType = sheet?.cellTypes[row]?.[column] ?? 'missing';
		const type: EditableCellType = storedType === 'formula' ? 'formula' : storedType === 'number' ? 'number'
			: storedType === 'boolean' ? 'boolean' : storedType === 'date' ? 'date' : 'string';
		return { value: sheet?.rows[row]?.[column] ?? '', type, storedType, exists: storedType !== 'missing' };
	}

	private assertInRange(sheetIndex: number, row: number, column: number): void {
		if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || column < 0) {
			throw new Error('La celda está fuera del rango actual.');
		}
		if (this.csv) {
			if (sheetIndex !== 0 || row >= this.csv.rowCount || column >= this.csv.columnCount) {
				throw new Error('La celda está fuera del rango actual.');
			}
		} else {
			const sheet = (this.xlsx ?? this.ods)?.sheets[sheetIndex];
			if (!sheet || row >= sheet.rowCount || column >= sheet.columnCount) {
				throw new Error('La celda está fuera del rango actual.');
			}
		}
	}

	private assign(key: string, edit: CellEdit | undefined): void {
		if (edit) {
			this.edits.set(key, edit);
		} else {
			this.edits.delete(key);
		}
	}

	private restoreState(state: EditState): void {
		this.csv = state.csv;
		this.edits.clear();
		for (const [key, edit] of state.edits) {this.edits.set(key, edit);}
	}
}

function validateValue(type: EditableCellType, value: string): void {
	if (type === 'formula') {throw new Error('Las fórmulas requieren el flujo explícito de edición de fórmulas.');}
	if (type === 'number' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
		throw new Error('Número inválido.');
	}
	if (type === 'boolean' && value !== '0' && value !== '1') {
		throw new Error('Booleano inválido; usa 0 o 1.');
	}
	if (type === 'date' && !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
		throw new Error('Fecha inválida; usa el valor ISO sin conversión.');
	}
}

function cellReference(row: number, column: number): string {
	let name = '';
	for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {name = String.fromCharCode(65 + (value - 1) % 26) + name;}
	return `${name}${row + 1}`;
}

function equivalent(left: CellValue, right: CellValue): boolean {
	return left.value === right.value && left.type === right.type && left.exists === right.exists;
}

function sameEdit(left: CellEdit | undefined, right: CellEdit | undefined): boolean {
	return left === right || Boolean(left && right && left.value === right.value && left.type === right.type
		&& left.storedType === right.storedType && left.exists === right.exists
		&& left.sheetIndex === right.sheetIndex && left.row === right.row && left.column === right.column);
}

function cellKey(sheet: number, row: number, column: number): string {
	return `${sheet}:${row}:${column}`;
}

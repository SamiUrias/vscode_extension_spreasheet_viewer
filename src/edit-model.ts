import { serializeCsvEdits, type CsvTable } from './formats/csv';
import { serializeXlsxEdits, type XlsxCellEdit, type XlsxStoredType, type XlsxWorkbook } from './formats/xlsx';
import { serializeOdsEdits, type OdsWorkbook } from './formats/ods';

export type EditableCellType = 'string' | 'number' | 'boolean' | 'date';

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
interface CellChange { readonly key: string; readonly before: CellEdit | undefined; readonly after: CellEdit | undefined; }
interface EditTransaction { readonly id: number; readonly changes: readonly CellChange[]; }

/** In-memory edit journal. Serialization always returns a new byte array. */
export class SpreadsheetEditSession {
	private readonly edits = new Map<string, CellEdit>();
	private readonly undoStack: EditTransaction[] = [];
	private readonly redoStack: EditTransaction[] = [];
	private nextTransactionId = 1;

	constructor(
		private readonly csv?: CsvTable,
		private readonly xlsx?: XlsxWorkbook,
		private readonly xlsxBytes?: Uint8Array,
		private readonly ods?: OdsWorkbook,
		private readonly odsBytes?: Uint8Array,
	) {}

	get hasEdits(): boolean {
		return this.edits.size > 0;
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
		for (const edit of this.edits.values()) {
			if (edit.sheetIndex !== sheetIndex || !rows[edit.row]) {continue;}
			rows[edit.row]![edit.column] = edit.value;
			if (cellKinds && cellTypes) {
				while (cellKinds[edit.row]!.length <= edit.column) {cellKinds[edit.row]!.push('missing');}
				while (cellTypes[edit.row]!.length <= edit.column) {cellTypes[edit.row]!.push('missing');}
				cellKinds[edit.row]![edit.column] = edit.value.length === 0 ? 'empty' : 'value';
				cellTypes[edit.row]![edit.column] = edit.storedType as XlsxStoredType;
			}
		}
		return { rows, ...(cellKinds ? { cellKinds } : {}), ...(cellTypes ? { cellTypes } : {}), ...(sheet ? { formulaCaches: { ...sheet.formulaCaches } } : {}) };
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
			const beforeValue = this.getCell(sheetIndex, row, column);
			if (beforeValue.storedType === 'formula' || beforeValue.storedType === 'error' || beforeValue.storedType === 'unsupported') {
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

	undo(transactionId?: number): boolean {
		if (transactionId !== undefined && this.undoStack[this.undoStack.length - 1]?.id !== transactionId) {return false;}
		const transaction = this.undoStack.pop();
		if (!transaction) {return false;}
		for (const change of [...transaction.changes].reverse()) {this.assign(change.key, change.before);}
		this.redoStack.push(transaction);
		return true;
	}

	redo(transactionId?: number): boolean {
		if (transactionId !== undefined && this.redoStack[this.redoStack.length - 1]?.id !== transactionId) {return false;}
		const transaction = this.redoStack.pop();
		if (!transaction) {return false;}
		for (const change of transaction.changes) {this.assign(change.key, change.after);}
		this.undoStack.push(transaction);
		return true;
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
		const type: EditableCellType = storedType === 'number' ? 'number'
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
}

function validateValue(type: EditableCellType, value: string): void {
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

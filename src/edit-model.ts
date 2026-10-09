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

/** In-memory edit journal. Serialization always returns a new byte array. */
export class SpreadsheetEditSession {
	private readonly edits = new Map<string, CellEdit>();
	private readonly undoStack: Array<{ key: string; before: CellEdit | undefined; after: CellEdit | undefined }> = [];
	private readonly redoStack: Array<{ key: string; before: CellEdit | undefined; after: CellEdit | undefined }> = [];

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
		const source = this.csv ? this.csv.rows : (this.xlsx ?? this.ods)?.sheets[sheetIndex]?.rows;
		if (!source) {throw new Error('La hoja solicitada no existe.');}
		const rows = source.map(row => [...row]);
		for (const edit of this.edits.values()) {
			if (edit.sheetIndex === sheetIndex && rows[edit.row]) {rows[edit.row][edit.column] = edit.value;}
		}
		return rows;
	}

	getCell(sheetIndex: number, row: number, column: number): CellValue {
		this.assertInRange(sheetIndex, row, column);
		const key = cellKey(sheetIndex, row, column);
		return this.edits.get(key) ?? this.original(sheetIndex, row, column);
	}

	editCell(sheetIndex: number, row: number, column: number, value: string, targetType?: EditableCellType): void {
		const before = this.getCell(sheetIndex, row, column);
		if (before.storedType === 'formula' || before.storedType === 'error' || before.storedType === 'unsupported') {
			throw new Error('Esta celda XLSX no se puede editar en esta etapa.');
		}
		if (this.csv && targetType !== undefined && targetType !== 'string') {
			throw new Error('Las celdas CSV se conservan como texto.');
		}
		const type = targetType ?? before.type;
		if (type !== before.type && targetType === undefined) {
			throw new Error('El cambio de tipo requiere una elección explícita.');
		}
		validateValue(type, value);
		const key = cellKey(sheetIndex, row, column);
		// An explicit edit of an absent cell, including an empty string, materializes that cell.
		const after: CellEdit = { sheetIndex, row, column, value, type, storedType: type, exists: true };
		const original = this.original(sheetIndex, row, column);
		const normalized = equivalent(after, original) ? undefined : after;
		const prior = this.edits.get(key);
		this.assign(key, normalized);
		this.undoStack.push({ key, before: prior, after: normalized });
		this.redoStack.length = 0;
	}

	undo(): boolean {
		const change = this.undoStack.pop();
		if (!change) {
			return false;
		}
		this.assign(change.key, change.before);
		this.redoStack.push(change);
		return true;
	}

	redo(): boolean {
		const change = this.redoStack.pop();
		if (!change) {
			return false;
		}
		this.assign(change.key, change.after);
		this.undoStack.push(change);
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

function cellKey(sheet: number, row: number, column: number): string {
	return `${sheet}:${row}:${column}`;
}

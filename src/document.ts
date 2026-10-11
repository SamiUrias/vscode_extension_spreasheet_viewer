import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpreadsheetEditSession, type CellEditInput } from './edit-model';
import type { RecoveryDraft, RecoveryEnvelopeV1 } from './recovery';
import { MAX_CSV_BYTES, parseCsvBytes, type CsvParseOptions, type CsvRowOperation, type CsvTable } from './formats/csv';
import { MAX_XLSX_BYTES, parseXlsxBytes, type XlsxWorkbook } from './formats/xlsx';
import { getXlsxStructureCapability, type XlsxStructureCapability, type XlsxStructureOperation } from './formats/xlsx-structure';
import type { FormulaParserService } from './formula-reference';
import { MAX_ODS_BYTES, parseOdsBytes, type OdsWorkbook } from './formats/ods';

export class SpreadsheetDocument implements vscode.CustomDocument {
	readonly documentId = randomUUID();
	csv: CsvTable | undefined;
	xlsx: XlsxWorkbook | undefined;
	xlsxStructureCapability: XlsxStructureCapability = { allowed: false, reason: 'El documento no es XLSX.' };
	ods: OdsWorkbook | undefined;
	sourceBytes: Uint8Array;
	editSession: SpreadsheetEditSession;
	revision = 0;
	recoveryConflict = false;
	private recoveredDraft: RecoveryDraft | undefined;
	private disposed = false;
	private csvOptions: CsvParseOptions;

	sheetId(sheetIndex: number): string { return `${this.uri.toString()}:sheet:${sheetIndex}`; }

	private constructor(readonly uri: vscode.Uri, bytes: Uint8Array, baselineBytes = bytes, csvOptions: CsvParseOptions = optionsForUri(uri)) {
		this.csvOptions = csvOptions;
		this.sourceBytes = baselineBytes.slice();
		({ csv: this.csv, xlsx: this.xlsx, ods: this.ods } = parseDocument(uri, bytes, this.csvOptions));
		if (this.xlsx) {this.xlsxStructureCapability = getXlsxStructureCapability(bytes);}
		this.editSession = new SpreadsheetEditSession(this.csv, this.xlsx, this.xlsx ? bytes : undefined, this.ods, this.ods ? bytes : undefined);
	}

	static async open(uri: vscode.Uri, backupBytes?: Uint8Array, csvOptions?: CsvParseOptions): Promise<SpreadsheetDocument> {
		if (backupBytes) {
			let baseline: Uint8Array;
			try {
				baseline = await vscode.workspace.fs.readFile(uri);
			} catch {
				baseline = new Uint8Array();
			}
			return new SpreadsheetDocument(uri, backupBytes, baseline, csvOptions ?? optionsForUri(uri));
		}
		return new SpreadsheetDocument(uri, await SpreadsheetDocument.readBytes(uri), undefined, csvOptions ?? optionsForUri(uri));
	}

	static async restoreRecovery(uri: vscode.Uri, backup: RecoveryEnvelopeV1, csvOptions?: CsvParseOptions): Promise<SpreadsheetDocument> {
		if (backup.uri !== uri.toString()) {throw new Error('La copia de recuperación pertenece a otro archivo.');}
		const document = new SpreadsheetDocument(uri, backup.baselineBytes, backup.baselineBytes, csvOptions ?? optionsForUri(uri));
		document.restoreWorkingBytes(backup.workingBytes);
		document.recoveredDraft = backup.draft;
		try {
			document.recoveryConflict = !equalBytes(await SpreadsheetDocument.readBytes(uri), backup.baselineBytes);
		} catch {document.recoveryConflict = true;}
		return document;
	}

	takeRecoveredDraft(): RecoveryDraft | undefined {
		const draft = this.recoveredDraft;
		this.recoveredDraft = undefined;
		return draft;
	}

	static fromBytes(uri: vscode.Uri, bytes: Uint8Array, csvOptions?: CsvParseOptions): SpreadsheetDocument {
		return new SpreadsheetDocument(uri, bytes, bytes, csvOptions ?? optionsForUri(uri));
	}

	private restoreWorkingBytes(workingBytes: Uint8Array): void {
		const working = parseDocument(this.uri, workingBytes, this.csvOptions);
		const edits: CellEditInput[] = [];
		if (this.csv && working.csv) {
			if (this.csv.rowCount !== working.csv.rowCount || this.csv.columnCount !== working.csv.columnCount) {throw new Error('La copia contiene cambios estructurales CSV que esta versión no puede recuperar.');}
			for (let row = 0; row < this.csv.rowCount; row++) {
				for (let column = 0; column < this.csv.columnCount; column++) {
					const before = this.editSession.getCell(0, row, column), after = working.csv.rows[row]?.[column];
					const exists = column < (working.csv.rows[row]?.length ?? 0);
					if (before.value !== (after ?? '') || before.exists !== exists) {
						if (!exists) {throw new Error('La copia contiene una eliminación de campo CSV no recuperable.');}
						edits.push({ sheetIndex: 0, row, column, value: after ?? '' });
					}
				}
			}
		} else {
			const baseline = this.xlsx ?? this.ods, current = working.xlsx ?? working.ods;
			if (!baseline || !current || baseline.sheets.length !== current.sheets.length) {throw new Error('La copia de recuperación no corresponde al formato del archivo.');}
			if (this.xlsx && working.xlsx && baseline.sheets.some((sheet, index) => sheet.name !== current.sheets[index]?.name)) {
				throw new Error('La copia de recuperación pertenece a otro conjunto de hojas.');
			}
			if (this.xlsx && working.xlsx && baseline.sheets.some((sheet, index) => sheet.rowCount !== current.sheets[index]?.rowCount || sheet.columnCount !== current.sheets[index]?.columnCount)) {
				this.xlsx = working.xlsx;
				this.xlsxStructureCapability = getXlsxStructureCapability(workingBytes);
				this.editSession = new SpreadsheetEditSession(undefined, working.xlsx, workingBytes);
				return;
			}
			const workingSession = new SpreadsheetEditSession(working.csv, working.xlsx, working.xlsx ? workingBytes : undefined, working.ods, working.ods ? workingBytes : undefined);
			for (let sheetIndex = 0; sheetIndex < baseline.sheets.length; sheetIndex++) {
				const beforeSheet = baseline.sheets[sheetIndex]!, afterSheet = current.sheets[sheetIndex]!;
				if (beforeSheet.name !== afterSheet.name || beforeSheet.rowCount !== afterSheet.rowCount || beforeSheet.columnCount !== afterSheet.columnCount) {throw new Error('La copia contiene cambios estructurales de hoja que esta versión no puede recuperar.');}
				for (let row = 0; row < beforeSheet.rowCount; row++) {
					for (let column = 0; column < beforeSheet.columnCount; column++) {
						const before = this.editSession.getCell(sheetIndex, row, column), after = workingSession.getCell(sheetIndex, row, column);
						if (before.value !== after.value || before.type !== after.type || before.exists !== after.exists) {
							if (!after.exists || ['formula', 'error', 'unsupported'].includes(after.storedType)) {throw new Error('La copia contiene un cambio de celda que esta versión no puede recuperar.');}
							edits.push({ sheetIndex, row, column, value: after.value, targetType: after.type });
						}
					}
				}
			}
		}
		if (edits.length) {this.editSession.editCells(edits); this.revision++;}
	}

	static async readBytes(uri: vscode.Uri): Promise<Uint8Array> {
		const stat = await vscode.workspace.fs.stat(uri);
		if ((stat.type & vscode.FileType.File) === 0) {
			throw new Error('El recurso seleccionado no es un archivo.');
		}
		const extension = path.posix.extname(uri.path).toLowerCase();
		const limit = ['.csv', '.tsv', '.tab'].includes(extension) ? MAX_CSV_BYTES : extension === '.xlsx' ? MAX_XLSX_BYTES : MAX_ODS_BYTES;
		if (!['.csv', '.tsv', '.tab', '.xlsx', '.ods'].includes(extension)) {
			throw new Error('Solo se admiten archivos .csv, .tsv, .tab, .xlsx y .ods.');
		}
		if (stat.size > limit) {
			throw new Error(`El archivo excede el límite de ${limit / (1024 * 1024)} MiB.`);
		}
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes.byteLength > limit) {
			throw new Error(`El archivo excede el límite de ${limit / (1024 * 1024)} MiB.`);
		}
		return bytes;
	}

	editCell(sheetIndex: number, row: number, column: number, value: string): number | undefined {
		return this.editCells([{ sheetIndex, row, column, value }]);
	}

	editCells(edits: readonly CellEditInput[]): number | undefined {
		const transactionId = this.editSession.editCells(edits);
		if (transactionId !== undefined) {this.revision++;}
		return transactionId;
	}

	applyCsvRowOperation(operation: CsvRowOperation): number {
		const transactionId = this.editSession.applyCsvRowOperation(operation);
		this.csv = this.editSession.csvTable;
		this.revision++;
		return transactionId;
	}

	async applyXlsxStructure(operation: XlsxStructureOperation, parser?: FormulaParserService): Promise<number> {
		const transactionId = await this.editSession.applyXlsxStructure(operation, parser);
		this.xlsx = this.editSession.xlsxWorkbook;
		this.revision++;
		return transactionId;
	}

	undo(transactionId?: number): boolean {
		if (this.editSession.undo(transactionId)) {this.csv = this.editSession.csvTable; this.xlsx = this.editSession.xlsxWorkbook; this.revision++; return true;}
		return false;
	}

	redo(transactionId?: number): boolean {
		if (this.editSession.redo(transactionId)) {this.csv = this.editSession.csvTable; this.xlsx = this.editSession.xlsxWorkbook; this.revision++; return true;}
		return false;
	}

	replaceSavedBytes(bytes: Uint8Array, csvOptions?: CsvParseOptions): void {
		if (csvOptions) {this.csvOptions = { ...csvOptions };}
		({ csv: this.csv, xlsx: this.xlsx, ods: this.ods } = parseDocument(this.uri, bytes, this.csvOptions));
		this.xlsxStructureCapability = this.xlsx ? getXlsxStructureCapability(bytes) : { allowed: false, reason: 'El documento no es XLSX.' };
		this.sourceBytes = bytes.slice();
		this.editSession = new SpreadsheetEditSession(this.csv, this.xlsx, this.xlsx ? bytes : undefined, this.ods, this.ods ? bytes : undefined);
		this.revision++;
	}

	serializeCopy(): Uint8Array {
		return this.editSession.serializeCopy();
	}

	validateCopy(bytes: Uint8Array): void {
		parseDocument(this.uri, bytes, this.csvOptions);
	}

	get hasUnsavedChanges(): boolean {
		const current = this.serializeCopy();
		if (current.byteLength !== this.sourceBytes.byteLength) {return true;}
		return current.some((byte, index) => byte !== this.sourceBytes[index]);
	}

	get isDisposed(): boolean { return this.disposed; }
	get currentCsvOptions(): CsvParseOptions { return { ...this.csvOptions }; }
	updateCsvOptions(options: CsvParseOptions): void { this.csvOptions = { ...options }; }

	dispose(): void { this.disposed = true; }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function optionsForUri(uri: vscode.Uri): CsvParseOptions {
	const extension = path.posix.extname(uri.path).toLowerCase();
	const configuration = vscode.workspace.getConfiguration('spreadsheet-viewer.csv');
	const commentPrefix = configuration.get<string>('commentPrefix', '#');
	return { ...(['.tsv', '.tab'].includes(extension) ? { delimiter: '\t' } : {}), commentPrefix: commentPrefix || undefined };
}

function parseDocument(uri: vscode.Uri, bytes: Uint8Array, csvOptions: CsvParseOptions = optionsForUri(uri)): { csv: CsvTable | undefined; xlsx: XlsxWorkbook | undefined; ods: OdsWorkbook | undefined } {
	const extension = path.posix.extname(uri.path).toLowerCase();
	if (['.csv', '.tsv', '.tab'].includes(extension)) {return { csv: parseCsvBytes(bytes, csvOptions), xlsx: undefined, ods: undefined };}
	if (extension === '.xlsx') {return { csv: undefined, xlsx: parseXlsxBytes(bytes), ods: undefined };}
	if (extension === '.ods') {return { csv: undefined, xlsx: undefined, ods: parseOdsBytes(bytes) };}
	throw new Error('Solo se admiten archivos .csv, .xlsx y .ods.');
}

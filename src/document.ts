import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpreadsheetEditSession, type CellEditInput } from './edit-model';
import { MAX_CSV_BYTES, parseCsvBytes, type CsvParseOptions, type CsvTable } from './formats/csv';
import { MAX_XLSX_BYTES, parseXlsxBytes, type XlsxWorkbook } from './formats/xlsx';
import { MAX_ODS_BYTES, parseOdsBytes, type OdsWorkbook } from './formats/ods';

export class SpreadsheetDocument implements vscode.CustomDocument {
	readonly documentId = randomUUID();
	csv: CsvTable | undefined;
	xlsx: XlsxWorkbook | undefined;
	ods: OdsWorkbook | undefined;
	sourceBytes: Uint8Array;
	editSession: SpreadsheetEditSession;
	revision = 0;
	private disposed = false;
	private csvOptions: CsvParseOptions;

	sheetId(sheetIndex: number): string { return `${this.uri.toString()}:sheet:${sheetIndex}`; }

	private constructor(readonly uri: vscode.Uri, bytes: Uint8Array, baselineBytes = bytes, csvOptions: CsvParseOptions = optionsForUri(uri)) {
		this.csvOptions = csvOptions;
		this.sourceBytes = baselineBytes.slice();
		({ csv: this.csv, xlsx: this.xlsx, ods: this.ods } = parseDocument(uri, bytes, this.csvOptions));
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

	static fromBytes(uri: vscode.Uri, bytes: Uint8Array, csvOptions?: CsvParseOptions): SpreadsheetDocument {
		return new SpreadsheetDocument(uri, bytes, bytes, csvOptions ?? optionsForUri(uri));
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

	undo(transactionId?: number): boolean {
		if (this.editSession.undo(transactionId)) {this.revision++; return true;}
		return false;
	}

	redo(transactionId?: number): boolean {
		if (this.editSession.redo(transactionId)) {this.revision++; return true;}
		return false;
	}

	replaceSavedBytes(bytes: Uint8Array, csvOptions?: CsvParseOptions): void {
		if (csvOptions) {this.csvOptions = { ...csvOptions };}
		({ csv: this.csv, xlsx: this.xlsx, ods: this.ods } = parseDocument(this.uri, bytes, this.csvOptions));
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

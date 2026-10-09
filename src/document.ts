import * as vscode from 'vscode';
import * as path from 'node:path';
import { SpreadsheetEditSession } from './edit-model';
import { MAX_CSV_BYTES, parseCsvBytes, type CsvTable } from './formats/csv';
import { MAX_XLSX_BYTES, parseXlsxBytes, type XlsxWorkbook } from './formats/xlsx';
import { MAX_ODS_BYTES, parseOdsBytes, type OdsWorkbook } from './formats/ods';

export class SpreadsheetDocument implements vscode.CustomDocument {
	csv: CsvTable | undefined;
	xlsx: XlsxWorkbook | undefined;
	ods: OdsWorkbook | undefined;
	sourceBytes: Uint8Array;
	editSession: SpreadsheetEditSession;
	revision = 0;

	private constructor(readonly uri: vscode.Uri, bytes: Uint8Array, baselineBytes = bytes) {
		this.sourceBytes = baselineBytes.slice();
		({ csv: this.csv, xlsx: this.xlsx, ods: this.ods } = parseDocument(uri, bytes));
		this.editSession = new SpreadsheetEditSession(this.csv, this.xlsx, this.xlsx ? bytes : undefined, this.ods, this.ods ? bytes : undefined);
	}

	static async open(uri: vscode.Uri, backupBytes?: Uint8Array): Promise<SpreadsheetDocument> {
		if (backupBytes) {
			let baseline: Uint8Array;
			try {
				baseline = await vscode.workspace.fs.readFile(uri);
			} catch {
				baseline = new Uint8Array();
			}
			return new SpreadsheetDocument(uri, backupBytes, baseline);
		}
		return new SpreadsheetDocument(uri, await SpreadsheetDocument.readBytes(uri));
	}

	static async readBytes(uri: vscode.Uri): Promise<Uint8Array> {
		const stat = await vscode.workspace.fs.stat(uri);
		if ((stat.type & vscode.FileType.File) === 0) {
			throw new Error('El recurso seleccionado no es un archivo.');
		}
		const extension = path.posix.extname(uri.path).toLowerCase();
		const limit = extension === '.csv' ? MAX_CSV_BYTES : extension === '.xlsx' ? MAX_XLSX_BYTES : MAX_ODS_BYTES;
		if (extension !== '.csv' && extension !== '.xlsx' && extension !== '.ods') {
			throw new Error('Solo se admiten archivos .csv, .xlsx y .ods.');
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

	editCell(sheetIndex: number, row: number, column: number, value: string): void {
		this.editSession.editCell(sheetIndex, row, column, value);
		this.revision++;
	}

	undo(): void {
		if (this.editSession.undo()) {this.revision++;}
	}

	redo(): void {
		if (this.editSession.redo()) {this.revision++;}
	}

	replaceSavedBytes(bytes: Uint8Array): void {
		({ csv: this.csv, xlsx: this.xlsx, ods: this.ods } = parseDocument(this.uri, bytes));
		this.sourceBytes = bytes.slice();
		this.editSession = new SpreadsheetEditSession(this.csv, this.xlsx, this.xlsx ? bytes : undefined, this.ods, this.ods ? bytes : undefined);
		this.revision++;
	}

	serializeCopy(): Uint8Array {
		return this.editSession.serializeCopy();
	}

	validateCopy(bytes: Uint8Array): void {
		parseDocument(this.uri, bytes);
	}

	get hasUnsavedChanges(): boolean {
		const current = this.serializeCopy();
		if (current.byteLength !== this.sourceBytes.byteLength) {return true;}
		return current.some((byte, index) => byte !== this.sourceBytes[index]);
	}

	dispose(): void {}
}

function parseDocument(uri: vscode.Uri, bytes: Uint8Array): { csv: CsvTable | undefined; xlsx: XlsxWorkbook | undefined; ods: OdsWorkbook | undefined } {
	const extension = path.posix.extname(uri.path).toLowerCase();
	if (extension === '.csv') {return { csv: parseCsvBytes(bytes), xlsx: undefined, ods: undefined };}
	if (extension === '.xlsx') {return { csv: undefined, xlsx: parseXlsxBytes(bytes), ods: undefined };}
	if (extension === '.ods') {return { csv: undefined, xlsx: undefined, ods: parseOdsBytes(bytes) };}
	throw new Error('Solo se admiten archivos .csv, .xlsx y .ods.');
}

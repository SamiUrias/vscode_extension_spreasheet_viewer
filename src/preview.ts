import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpreadsheetDocument } from './document';
import { CsvDelimiterAmbiguityError, MAX_CSV_BYTES, parseCsvBytes, type CsvParseOptions, type CsvTable } from './formats/csv';
import type { CsvDataMessage, ExtensionToWebviewMessage, SelectSheetMessage, WebviewToExtensionMessage, XlsxDataMessage } from './protocol';
import { createHeaderSignature, ViewStateRepository, type ViewStateV1 } from './view-state';

type PreviewMode = 'disk' | 'buffer' | 'csv-text';
type HtmlFactory = (uri: vscode.Uri, webview: vscode.Webview, title?: string) => string;

interface PreviewSession {
	readonly key: string;
	readonly uri: vscode.Uri;
	readonly mode: PreviewMode;
	readonly panel: vscode.WebviewPanel;
	readonly documentId: string;
	textDocument?: vscode.TextDocument;
	csv?: CsvTable;
	spreadsheet?: SpreadsheetDocument;
	bytes?: Uint8Array;
	csvOptions: CsvParseOptions;
	revision: number;
	activeSheetIndex: number;
	ready: boolean;
	updateTimer?: ReturnType<typeof setTimeout>;
}

/** Read-only previews are separate panels; only their selected worksheet is mutable view state. */
export class SpreadsheetPreviewProvider implements vscode.Disposable {
	private readonly sessions = new Map<string, PreviewSession>();
	private readonly pendingOpens = new Map<string, Promise<void>>();
	private readonly changeListener: vscode.Disposable;
	private readonly saveListener: vscode.Disposable;
	private readonly configurationListener: vscode.Disposable;
	private readonly viewStates: ViewStateRepository | undefined;

	constructor(private readonly extensionUri: vscode.Uri, private readonly htmlFactory: HtmlFactory, workspaceState?: vscode.Memento) {
		this.viewStates = workspaceState ? new ViewStateRepository(workspaceState) : undefined;
		this.changeListener = vscode.workspace.onDidChangeTextDocument(event => this.onTextDocumentChanged(event.document));
		this.saveListener = vscode.workspace.onDidSaveTextDocument(document => {
			for (const session of this.sessions.values()) {if (session.textDocument === document) {this.postSnapshot(session);}}
		});
		this.configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
			for (const session of this.sessions.values()) {
				if (event.affectsConfiguration('spreadsheet-viewer.view.showResetButton', session.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.view', session.uri).get<boolean>('showResetButton', true);
					void session.panel.webview.postMessage({ type: 'resetViewButtonVisibility', visible });
				}
				const visualChanged = event.affectsConfiguration('spreadsheet-viewer.csv.firstRowHeader', session.uri)
					|| event.affectsConfiguration('spreadsheet-viewer.csv.headerCase', session.uri);
				if (visualChanged) {this.postSnapshot(session);}
				if (session.csv && event.affectsConfiguration('spreadsheet-viewer.csv.commentPrefix', session.uri)) {
					const prefix = vscode.workspace.getConfiguration('spreadsheet-viewer.csv', session.uri).get<string>('commentPrefix', '#');
					session.csvOptions.commentPrefix = prefix || undefined;
					void this.reparseCsv(session);
				}
			}
		});
	}

	dispose(): void {
		this.changeListener.dispose();
		this.saveListener.dispose();
		this.configurationListener.dispose();
		for (const session of this.sessions.values()) {
			if (session.updateTimer) {clearTimeout(session.updateTimer);}
			session.panel.dispose();
		}
		this.sessions.clear();
	}

	async openDisk(uri: vscode.Uri): Promise<void> {
		return this.openDeduplicated(uri, 'disk', () => this.open(uri, 'disk'));
	}

	async openBuffer(uri: vscode.Uri, csvOnly = false): Promise<void> {
		const key = sessionKey(uri, csvOnly ? 'csv-text' : 'buffer');
		const existing = this.sessions.get(key);
		if (existing) {existing.panel.reveal(vscode.ViewColumn.Beside); return;}
		return this.openDeduplicated(uri, csvOnly ? 'csv-text' : 'buffer', async () => {
			const textDocument = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString())
				?? await vscode.workspace.openTextDocument(uri);
			const options = optionsForUri(uri);
			const table = await this.parseTextWithPrompt(uri, textDocument.getText(), options);
			await this.createSession(uri, csvOnly ? 'csv-text' : 'buffer', { textDocument, csv: table, csvOptions: options });
		});
	}

	private async openDeduplicated(uri: vscode.Uri, mode: PreviewMode, open: () => Promise<void>): Promise<void> {
		const key = sessionKey(uri, mode);
		const existing = this.sessions.get(key);
		if (existing) {existing.panel.reveal(vscode.ViewColumn.Beside); return;}
		const pending = this.pendingOpens.get(key);
		if (pending) {await pending; this.sessions.get(key)?.panel.reveal(vscode.ViewColumn.Beside); return;}
		const opening = open();
		this.pendingOpens.set(key, opening);
		try { await opening; }
		finally {if (this.pendingOpens.get(key) === opening) {this.pendingOpens.delete(key);}}
	}

	private async open(uri: vscode.Uri, mode: PreviewMode): Promise<void> {
		const key = sessionKey(uri, mode);
		const existing = this.sessions.get(key);
		if (existing) {existing.panel.reveal(vscode.ViewColumn.Beside); return;}
		const bytes = await SpreadsheetDocument.readBytes(uri);
		if (isCsvUri(uri)) {
			const options = optionsForUri(uri);
			const table = await this.parseBytesWithPrompt(uri, bytes, options);
			await this.createSession(uri, mode, { bytes, csv: table, csvOptions: options });
			return;
		}
		const spreadsheet = SpreadsheetDocument.fromBytes(uri, bytes);
		await this.createSession(uri, mode, { bytes, spreadsheet, csvOptions: optionsForUri(uri) });
	}

	private async createSession(
		uri: vscode.Uri,
		mode: PreviewMode,
		state: Pick<PreviewSession, 'textDocument' | 'csv' | 'spreadsheet' | 'bytes' | 'csvOptions'>,
	): Promise<void> {
		const key = sessionKey(uri, mode);
		const panel = vscode.window.createWebviewPanel('spreadsheet-viewer.preview',
			`${path.posix.basename(uri.path) || 'CSV'} · Vista previa`, vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] });
		const session: PreviewSession = {
			key, uri, mode, panel, documentId: randomUUID(),
			revision: 0, activeSheetIndex: 0, ready: false, ...state,
		};
		this.sessions.set(key, session);
		panel.onDidDispose(() => {
			if (session.updateTimer) {clearTimeout(session.updateTimer);}
			if (this.sessions.get(key) === session) {this.sessions.delete(key);}
		});
		panel.webview.onDidReceiveMessage((message: unknown) => {
			if (isReadyMessage(message)) {
				session.ready = true;
				const restored = this.readViewState(session);
				const workbook = session.spreadsheet?.xlsx ?? session.spreadsheet?.ods;
				const restoredIndex = workbook?.sheets.findIndex((_, index) => previewSheetId(session, index) === restored?.activeSheetId) ?? -1;
				if (restoredIndex >= 0) {session.activeSheetIndex = restoredIndex;}
				void panel.webview.postMessage({ type: 'restoreViewState', mode: 'preview', state: restored });
				this.postSnapshot(session);
				return;
			}
			if (isReloadMessage(message)) {void this.refresh(session); return;}
			if (isSelectSheetMessage(message) && this.isCurrentSheetRequest(session, message)) {
				session.activeSheetIndex = message.sheetIndex;
				void panel.webview.postMessage({ type: 'restoreViewState', mode: 'preview', state: this.readViewState(session) });
				this.postSnapshot(session, message.requestId);
				return;
			}
			if (isPersistViewStateMessage(message) && message.mode === 'preview') {
				if (!vscode.workspace.getConfiguration('spreadsheet-viewer.view', session.uri).get<boolean>('restoreState', true)) {return;}
				const state: ViewStateV1 = { ...message.state, version: 1, uri: session.uri.toString(), mode: 'preview', updatedAt: Date.now() };
				this.viewStates?.write(state, session.uri.toString(), 'preview');
				return;
			}
			if (isResetViewMessage(message) && message.mode === 'preview') {
				this.viewStates?.remove(session.uri.toString(), 'preview');
			}
		});
		panel.webview.html = this.htmlFactory(uri, panel.webview, 'Vista previa');
	}

	resetView(uri: vscode.Uri): void {
		this.viewStates?.remove(uri.toString(), 'preview');
		for (const session of this.sessions.values()) {
			if (session.uri.toString() === uri.toString()) {void session.panel.webview.postMessage({ type: 'restoreViewState', mode: 'preview', reset: true });}
		}
	}

	private readViewState(session: PreviewSession): ViewStateV1 | undefined {
		if (!vscode.workspace.getConfiguration('spreadsheet-viewer.view', session.uri).get<boolean>('restoreState', true)) {return undefined;}
		const state = this.viewStates?.read(session.uri.toString(), 'preview');
		if (state?.corrupted) {void vscode.window.showWarningMessage('Se ignoró un estado de vista dañado; se abrió la vista previa predeterminada.');}
		return state?.state;
	}

	private isCurrentSheetRequest(session: PreviewSession, message: SelectSheetMessage): boolean {
		const workbook = session.spreadsheet?.xlsx ?? session.spreadsheet?.ods;
		return Boolean(workbook && message.documentId === session.documentId && message.revision === session.revision
			&& message.sheetId === previewSheetId(session, message.sheetIndex)
			&& message.sheetIndex >= 0 && message.sheetIndex < workbook.sheets.length);
	}

	private postSnapshot(session: PreviewSession, requestId?: number): void {
		if (!session.ready) {return;}
		const sourceStatus = session.textDocument?.isDirty ? 'Cambios sin guardar en el buffer.'
			: session.mode === 'disk' ? 'Datos leídos desde disco.' : 'Vista previa del buffer actual.';
		let message: CsvDataMessage | XlsxDataMessage;
		if (session.csv) {
			const csvSettings = vscode.workspace.getConfiguration('spreadsheet-viewer.csv');
			const headerRow = csvSettings.get<boolean>('firstRowHeader', true) ? session.csv.rowKinds.findIndex(kind => kind === 'data') : -1;
			const caseMode = csvSettings.get<'none' | 'upper' | 'lower'>('headerCase', 'none');
			const headerLabels = headerRow < 0 ? undefined : Array.from({ length: session.csv.columnCount }, (_, column) => {
				const label = session.csv!.rows[headerRow]?.[column] ?? '';
				return caseMode === 'upper' ? label.toUpperCase() : caseMode === 'lower' ? label.toLowerCase() : label;
			});
			message = {
				type: 'csvData', documentId: session.documentId, sheetId: previewSheetId(session, 0),
				revision: session.revision, fileName: path.posix.basename(session.uri.path) || 'CSV',
				rows: session.csv.rows.map(row => [...row]), rowCount: session.csv.rowCount,
				columnCount: session.csv.columnCount, readonly: true, sourceMode: session.mode, sourceStatus,
				rowKinds: session.csv.rowKinds, physicalLines: session.csv.physicalLines, headerLabels,
				rowComments: session.csv.rowComments,
				formatSchema: `csv:${session.csv.delimiter}:${session.csv.quoteChar}:${session.csv.quotes ? 1 : 0}:${session.csv.commentPrefix ?? 'no-comments'}:${headerRow < 0 ? 'none' : createHeaderSignature(session.csv.rows[headerRow] ?? [])}`,
			};
		} else {
			const document = session.spreadsheet;
			const workbook = document?.xlsx ?? document?.ods;
			if (!document || !workbook) {return;}
			const index = Math.min(session.activeSheetIndex, workbook.sheets.length - 1);
			const sheet = workbook.sheets[index];
			if (!sheet) {return;}
			message = {
				type: 'xlsxData', fileFormat: document.ods ? 'ods' : 'xlsx', revision: session.revision,
				documentId: session.documentId, sheetId: previewSheetId(session, index),
				sheetIds: workbook.sheets.map((_, sheetIndex) => previewSheetId(session, sheetIndex)),
				fileName: path.posix.basename(session.uri.path), sheetName: sheet.name,
				sheetNames: workbook.sheets.map(item => item.name), activeSheetIndex: index,
				...(requestId === undefined ? {} : { requestId }),
				rows: sheet.rows.map(row => [...row]), cellKinds: sheet.cellKinds, cellTypes: sheet.cellTypes,
				cellCapabilities: sheet.cellTypes.map(row => row.map(storedType => {
					const editable = storedType !== 'formula' && storedType !== 'error' && storedType !== 'unsupported';
					return { storedType, editable, ...(!editable ? { reason: `Tipo ${storedType} protegido en esta etapa.` } : {}) };
				})),
				formulaCaches: sheet.formulaCaches,
				...(document.xlsx && session.bytes ? { workbookBase64: Buffer.from(session.bytes).toString('base64') } : {}),
				rowCount: sheet.rowCount, columnCount: sheet.columnCount, warnings: workbook.warnings,
				readonly: true, sourceMode: session.mode, sourceStatus,
			};
		}
		void session.panel.webview.postMessage(message satisfies ExtensionToWebviewMessage);
	}

	private onTextDocumentChanged(document: vscode.TextDocument): void {
		for (const session of this.sessions.values()) {
			if (session.textDocument !== document) {continue;}
			if (session.updateTimer) {clearTimeout(session.updateTimer);}
			session.updateTimer = setTimeout(() => {
				session.updateTimer = undefined;
				void this.updateBuffer(session);
			}, 180);
		}
	}

	private async updateBuffer(session: PreviewSession): Promise<void> {
		if (!session.textDocument) {return;}
		try {
			session.csv = await this.parseTextWithPrompt(session.uri, session.textDocument.getText(), session.csvOptions);
			session.revision++;
			this.postSnapshot(session);
		} catch (error) {
			void session.panel.webview.postMessage({ type: 'reloadState', state: 'error', message: errorMessage(error) });
		}
	}

	private async reparseCsv(session: PreviewSession): Promise<void> {
		try {
			if (session.textDocument) {
				session.csv = await this.parseTextWithPrompt(session.uri, session.textDocument.getText(), session.csvOptions);
			} else {
				session.bytes ??= await SpreadsheetDocument.readBytes(session.uri);
				session.csv = await this.parseBytesWithPrompt(session.uri, session.bytes, session.csvOptions);
			}
			session.revision++;
			this.postSnapshot(session);
		} catch (error) {
			void session.panel.webview.postMessage({ type: 'reloadState', state: 'error', message: errorMessage(error) });
		}
	}

	private async refresh(session: PreviewSession): Promise<void> {
		try {
			if (session.textDocument) {
				session.csv = await this.parseTextWithPrompt(session.uri, session.textDocument.getText(), session.csvOptions);
			} else {
				const bytes = await SpreadsheetDocument.readBytes(session.uri);
				session.bytes = bytes;
				if (isCsvUri(session.uri)) {session.csv = await this.parseBytesWithPrompt(session.uri, bytes, session.csvOptions);}
				else {session.spreadsheet = SpreadsheetDocument.fromBytes(session.uri, bytes);}
			}
			session.revision++;
			session.activeSheetIndex = 0;
			void session.panel.webview.postMessage({ type: 'reloadState', state: 'done' });
			this.postSnapshot(session);
		} catch (error) {
			void session.panel.webview.postMessage({ type: 'reloadState', state: 'error', message: errorMessage(error) });
		}
	}

	private async parseTextWithPrompt(uri: vscode.Uri, text: string, options: CsvParseOptions): Promise<CsvTable> {
		return this.parseBytesWithPrompt(uri, new TextEncoder().encode(text), options);
	}

	private async parseBytesWithPrompt(uri: vscode.Uri, bytes: Uint8Array, options: CsvParseOptions): Promise<CsvTable> {
		if (bytes.byteLength > MAX_CSV_BYTES) {throw new Error('El archivo excede el límite de 10 MiB para CSV.');}
		try {
			const table = parseCsvBytes(bytes, options);
			options.delimiter ??= table.delimiter;
			return table;
		}
		catch (error) {
			if (!(error instanceof CsvDelimiterAmbiguityError)) {throw error;}
			const delimiter = await vscode.window.showQuickPick(error.delimiters.map(value => ({
				label: value === '\t' ? 'Tabulador (TAB)' : value,
				description: `Separador ${JSON.stringify(value)}`, value,
			})), { title: `Elige el separador para ${path.posix.basename(uri.path) || 'CSV'}` });
			if (!delimiter) {throw new Error('Se canceló la selección del dialecto CSV.');}
			options.delimiter = delimiter.value;
			const table = parseCsvBytes(bytes, options);
			options.delimiter ??= table.delimiter;
			return table;
		}
	}
}

function optionsForUri(uri: vscode.Uri): CsvParseOptions {
	const commentPrefix = vscode.workspace.getConfiguration('spreadsheet-viewer.csv').get<string>('commentPrefix', '#');
	return { ...(/\.(tsv|tab)$/i.test(uri.path) ? { delimiter: '\t' } : {}), commentPrefix: commentPrefix || undefined };
}

function previewSheetId(session: PreviewSession, sheetIndex: number): string {
	return `${session.uri.toString()}:preview:${session.mode}:sheet:${sheetIndex}`;
}

function isCsvUri(uri: vscode.Uri): boolean { return /\.(csv|tsv|tab)$/i.test(uri.path); }
function sessionKey(uri: vscode.Uri, mode: PreviewMode): string { return `${uri.toString()}::${mode}`; }
function isReadyMessage(value: unknown): boolean { return isMessageType(value, 'ready'); }
function isReloadMessage(value: unknown): boolean { return isMessageType(value, 'reloadFile'); }
function isMessageType(value: unknown, type: string): boolean {
	return typeof value === 'object' && value !== null && 'type' in value && value.type === type;
}
function isSelectSheetMessage(value: unknown): value is SelectSheetMessage {
	if (typeof value !== 'object' || value === null || !('type' in value) || value.type !== 'selectSheet') {return false;}
	const message = value as Record<string, unknown>;
	return typeof message.documentId === 'string' && typeof message.sheetId === 'string'
		&& Number.isInteger(message.revision) && Number.isInteger(message.sheetIndex) && Number.isInteger(message.requestId);
}
function isPersistViewStateMessage(value: unknown): value is Extract<WebviewToExtensionMessage, { type: 'persistViewState' }> {
	return typeof value === 'object' && value !== null && 'type' in value && value.type === 'persistViewState'
		&& 'mode' in value && (value.mode === 'edit' || value.mode === 'preview')
		&& 'state' in value && typeof value.state === 'object' && value.state !== null;
}
function isResetViewMessage(value: unknown): value is Extract<WebviewToExtensionMessage, { type: 'resetView' }> {
	return typeof value === 'object' && value !== null && 'type' in value && value.type === 'resetView'
		&& 'mode' in value && (value.mode === 'edit' || value.mode === 'preview');
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

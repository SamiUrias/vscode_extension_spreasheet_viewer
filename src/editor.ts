import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpreadsheetDocument } from './document';
import { CsvDelimiterAmbiguityError } from './formats/csv';
import { deleteBackup, readBackup, replaceFile, writeBackup } from './storage';
import type { CsvDataMessage, ReloadStateMessage, SaveStateMessage, SortStateMessage, WebviewToExtensionMessage, XlsxDataMessage } from './protocol';
import { createHeaderSignature, ViewStateRepository, type ViewMode, type ViewStateV1 } from './view-state';

export class SpreadsheetEditorProvider implements vscode.CustomEditorProvider<SpreadsheetDocument> {
	static readonly viewType = 'spreadsheet-viewer.editor';

	private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();
	private readonly pendingOpens = new Map<string, Thenable<void>>();
	private readonly emitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SpreadsheetDocument>>();
	readonly onDidChangeCustomDocument = this.emitter.event;
	private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly saveQueues = new WeakMap<SpreadsheetDocument, Promise<void>>();
	private readonly automaticSaveInFlight = new Set<string>();
	private readonly automaticSaveQueued = new Set<string>();
	private readonly automaticSaveCallbacks = new Map<string, () => void>();
	private readonly activeSheets = new WeakMap<vscode.WebviewPanel, number>();
	private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
	private readonly externalTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly externalConflicts = new Map<string, { deleted: boolean; allowReload: boolean }>();
	private readonly conflictPrompts = new Set<string>();
	private readonly ownWrites = new WeakMap<SpreadsheetDocument, Uint8Array[]>();
	private readonly formulaSnapshots = new WeakMap<SpreadsheetDocument, { revision: number; base64: string }>();
	private readonly panelDrafts = new Map<vscode.WebviewPanel, Extract<WebviewToExtensionMessage, { type: 'draftState' }>>();
	private readonly panelListeners = new Map<vscode.WebviewPanel, vscode.Disposable[]>();
	private readonly watcherListeners = new Map<string, vscode.Disposable[]>();
	private readonly documents = new Map<string, SpreadsheetDocument>();
	private readonly configurationListener: vscode.Disposable;
	private readonly output = vscode.window.createOutputChannel('Spreadsheet Viewer');
	private readonly viewStates: ViewStateRepository;
	private lastViewStateWasCorrupt = false;
	private warnedCorruptViewState = false;

	constructor(private readonly extensionUri: vscode.Uri, private readonly workspaceState: vscode.Memento) {
		this.viewStates = new ViewStateRepository(workspaceState);
		this.configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
			for (const document of this.documents.values()) {
				if (event.affectsConfiguration('spreadsheet-viewer.view.showResetButton', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('showResetButton', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {
						void panel.webview.postMessage({ type: 'resetViewButtonVisibility', visible });
					}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.view.showClearSortButton', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('showClearSortButton', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {
						void panel.webview.postMessage({ type: 'clearSortButtonVisibility', visible });
					}
				}
				const visualChanged = event.affectsConfiguration('spreadsheet-viewer.csv.firstRowHeader', document.uri)
					|| event.affectsConfiguration('spreadsheet-viewer.csv.headerCase', document.uri);
				if (visualChanged) {this.postDocument(document);}
				if (document.csv && event.affectsConfiguration('spreadsheet-viewer.csv.commentPrefix', document.uri)) {
					const prefix = vscode.workspace.getConfiguration('spreadsheet-viewer.csv', document.uri).get<string>('commentPrefix', '#');
					document.updateCsvOptions({ ...document.currentCsvOptions, commentPrefix: prefix || undefined });
					void this.reloadFromDisk(document);
				}
			}
		});
	}

	dispose(): void {
		for (const timer of this.saveTimers.values()) {clearTimeout(timer);}
		for (const timer of this.externalTimers.values()) {clearTimeout(timer);}
		for (const watcher of this.watchers.values()) {watcher.dispose();}
		for (const list of [...this.watcherListeners.values(), ...this.panelListeners.values()]) {for (const item of list) {item.dispose();}}
		this.saveTimers.clear(); this.externalTimers.clear(); this.watchers.clear(); this.watcherListeners.clear(); this.panelListeners.clear();
		this.automaticSaveInFlight.clear(); this.automaticSaveQueued.clear();
		this.automaticSaveCallbacks.clear();
		this.configurationListener.dispose();
		this.documents.clear();
		this.emitter.dispose(); this.output.dispose();
	}

	async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<SpreadsheetDocument> {
		if (!await resolveDirtyTextBuffer(uri)) {throw new Error('Se canceló la apertura para conservar los cambios de texto sin guardar.');}
		const backup = openContext.backupId ? await readBackup(openContext.backupId) : undefined;
		try { return await SpreadsheetDocument.open(uri, backup); }
		catch (error) {
			if (!(error instanceof CsvDelimiterAmbiguityError)) {throw error;}
			const delimiter = await vscode.window.showQuickPick(error.delimiters.map(value => ({
				label: value === '\t' ? 'Tabulador (TAB)' : value === '|' ? 'Barra vertical (|)' : value,
				description: `Separador ${JSON.stringify(value)}`, value,
			})), { title: 'Elige el separador del archivo', placeHolder: 'El archivo admite más de una interpretación.' });
			if (!delimiter) {throw new Error('Se canceló la selección del dialecto CSV.');}
			const commentPrefix = vscode.workspace.getConfiguration('spreadsheet-viewer.csv', uri).get<string>('commentPrefix', '#');
			return SpreadsheetDocument.open(uri, backup, { delimiter: delimiter.value, persistDelimiter: true, commentPrefix: commentPrefix || undefined });
		}
	}

	resolveCustomEditor(document: SpreadsheetDocument, panel: vscode.WebviewPanel): void {
		const key = document.uri.toString();
		this.documents.set(key, document);
		const documentPanels = this.panels.get(key) ?? new Set<vscode.WebviewPanel>();
		documentPanels.add(panel);
		this.panels.set(key, documentPanels);
		const listeners: vscode.Disposable[] = [];
		this.panelListeners.set(panel, listeners);
		listeners.push(panel.onDidDispose(() => {
			documentPanels.delete(panel);
			this.panelDrafts.delete(panel);
			if (documentPanels.size === 0) {this.panels.delete(key); this.documents.delete(key);}
			if (documentPanels.size === 0) {this.disposeWatcher(key);}
			if (documentPanels.size === 0) {
				const timer = this.saveTimers.get(key);
				if (timer) {clearTimeout(timer);}
				this.saveTimers.delete(key);
			}
			for (const listener of listeners) {listener.dispose();}
			this.panelListeners.delete(panel);
		}));
		this.watchDocument(document);
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
		};
		listeners.push(panel.webview.onDidReceiveMessage((message: unknown) => {
			if (document.isDisposed) {return;}
			if (isReloadFileMessage(message)) {
				void vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: 'Recargando' },
						() => this.reloadFromDisk(document),
					);
				return;
			}
			if (isWebviewReadyMessage(message)) {
				const restored = this.readViewState(document.uri, 'edit');
				const workbook = document.xlsx ?? document.ods;
				const restoredIndex = workbook?.sheets.findIndex((_, index) => document.sheetId(index) === restored?.activeSheetId) ?? -1;
				const activeIndex = restoredIndex >= 0 ? restoredIndex : 0;
				this.activeSheets.set(panel, activeIndex);
				try {
					void panel.webview.postMessage({ type: 'restoreViewState', mode: 'edit', state: restored, corrupted: this.lastViewStateWasCorrupt });
					if (!restored && workbook && vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('restoreState', true)) {
						void panel.webview.postMessage({ type: 'sortState', criteria: this.getSortState(document.uri, activeIndex) } satisfies SortStateMessage);
					}
					this.postDocument(document, panel);
					this.postSaveState(document, { type: 'saveState', state: document.hasUnsavedChanges ? 'pending' : 'clean' }, panel);
					if (document.hasUnsavedChanges) {this.scheduleSave(document);}
				} catch (error) {
					const detail = errorMessage(error);
					this.output.appendLine(`No se pudo enviar el documento a la vista: ${detail}`);
					void panel.webview.postMessage({ type: 'reloadState', state: 'error', message: detail } satisfies ReloadStateMessage);
					void panel.webview.postMessage({ type: 'saveState', state: 'error', message: `No se pudieron cargar los datos: ${detail}` } satisfies SaveStateMessage);
				}
				return;
			}
			if (isSelectSheetMessage(message) && (document.xlsx || document.ods)) {
				if (message.documentId !== document.documentId || message.revision !== document.revision || message.sheetId !== document.sheetId(message.sheetIndex)) {return;}
				this.activeSheets.set(panel, message.sheetIndex);
				void panel.webview.postMessage({ type: 'restoreViewState', mode: 'edit', state: this.readViewState(document.uri, 'edit') });
				this.postXlsxSheet(document, panel, message.sheetIndex, message.requestId);
				return;
			}
			if (isInvalidCellMessage(message)) {
				void vscode.window.showErrorMessage('Celda inválida');
				return;
			}
			if (isEditCellMessage(message)) {
				this.applyEdit(document, message);
				return;
			}
			if (isDraftStateMessage(message)) {
				if (message.documentId !== document.documentId || message.revision !== document.revision || message.sheetId !== document.sheetId(message.sheetIndex)) {return;}
				if (message.dirty) {this.panelDrafts.set(panel, message);}
				else {this.panelDrafts.delete(panel);}
				return;
			}
			if (isHistoryMessage(message)) {
				void vscode.commands.executeCommand(message.direction);
			}
			if (isSetSortMessage(message) && message.documentId === document.documentId) {
				const sheetIndex = this.activeSheets.get(panel) ?? 0;
				if (message.sheetId !== document.sheetId(sheetIndex) || !isValidSortCriteria(message.criteria, getColumnCount(document, sheetIndex))) {return;}
				if (vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('restoreState', true)) {
					void this.workspaceState.update(sortStateKey(document.uri, sheetIndex), message.criteria);
				}
				return;
			}
			if (isPersistViewStateMessage(message)) {
				if (message.mode !== 'edit') {return;}
				if (!vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('restoreState', true)) {return;}
				const state: ViewStateV1 = { ...message.state, version: 1, uri: document.uri.toString(), mode: 'edit', updatedAt: Date.now() };
				if (!this.viewStates.write(state, document.uri.toString(), 'edit')) {
					this.output.appendLine(`Se ignoró el estado de vista inválido o demasiado grande: ${document.uri.toString()}`);
				}
				return;
			}
			if (isResetViewMessage(message)) {
				if (message.mode !== 'edit') {return;}
				this.viewStates.remove(document.uri.toString(), 'edit');
				void panel.webview.postMessage({ type: 'restoreViewState', mode: 'edit' });
			}
		}));
		panel.webview.html = this.getHtml(document.uri, panel.webview);
	}

	private postXlsxSheet(
		document: SpreadsheetDocument,
		panel: vscode.WebviewPanel,
		sheetIndex: number,
		requestId?: number,
	): void {
		const workbook = document.xlsx ?? document.ods;
		if (!workbook || !Number.isInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= workbook.sheets.length) {
			return;
		}
		const sheet = workbook.sheets[sheetIndex];
		const data: XlsxDataMessage = {
			type: 'xlsxData',
			fileFormat: document.ods ? 'ods' : 'xlsx',
			fileName: document.uri.path.split('/').pop() || document.uri.toString(),
			revision: document.revision,
			documentId: document.documentId,
			sheetId: document.sheetId(sheetIndex),
			sheetIds: workbook.sheets.map((_, index) => document.sheetId(index)),
			sheetName: sheet.name,
			sheetNames: workbook.sheets.map(item => item.name),
			activeSheetIndex: sheetIndex,
			...(requestId === undefined ? {} : { requestId }),
			rows: document.editSession.getRows(sheetIndex),
			cellKinds: sheet.cellKinds,
			cellTypes: sheet.cellTypes,
			cellCapabilities: sheet.cellTypes.map((row, r) => row.map((storedType, c) => {
				const editable = storedType !== 'formula' && storedType !== 'error' && storedType !== 'unsupported';
				return { storedType, editable, ...(!editable ? { reason: `Tipo ${storedType} protegido en esta etapa.` } : {}) };
			})),
			formulaCaches: sheet.formulaCaches,
			...(document.xlsx ? { workbookBase64: this.getFormulaSnapshot(document) } : {}),
			rowCount: sheet.rowCount,
			columnCount: sheet.columnCount,
			warnings: workbook.warnings,
		};
		void panel.webview.postMessage(data);
	}

	private getFormulaSnapshot(document: SpreadsheetDocument): string {
		const cached = this.formulaSnapshots.get(document);
		if (cached?.revision === document.revision) {return cached.base64;}
		const entry = { revision: document.revision, base64: Buffer.from(document.serializeCopy()).toString('base64') };
		this.formulaSnapshots.set(document, entry);
		return entry.base64;
	}

	async open(uri: vscode.Uri): Promise<void> {
		const extension = path.posix.extname(uri.path).toLowerCase();
		if (!['.csv', '.tsv', '.tab', '.xlsx', '.ods'].includes(extension)) {
			throw new Error('Solo se admiten archivos .csv, .tsv, .tab, .xlsx y .ods.');
		}

		const key = uri.toString();
		const existing = this.panels.get(key);
		if (existing?.size) {
			existing.values().next().value?.reveal();
			return;
		}

		const pending = this.pendingOpens.get(key);
		if (pending) {
			await pending;
			this.panels.get(key)?.values().next().value?.reveal();
			return;
		}

		const opening = vscode.commands.executeCommand<void>(
			'vscode.openWith',
			uri,
			SpreadsheetEditorProvider.viewType,
		).then(() => undefined);
		this.pendingOpens.set(key, opening);
		try {
			await opening;
		} finally {
			if (this.pendingOpens.get(key) === opening) {
				this.pendingOpens.delete(key);
			}
		}
	}

	resetView(uri: vscode.Uri): void {
		this.viewStates.remove(uri.toString(), 'edit');
		const legacyPrefix = `spreadsheet-viewer.view-state.v1:${uri.toString()}:`;
		for (const key of this.workspaceState.keys()) {if (key.startsWith(legacyPrefix)) {void this.workspaceState.update(key, undefined);}}
		for (const panel of this.panels.get(uri.toString()) ?? []) {
			void panel.webview.postMessage({ type: 'restoreViewState', mode: 'edit', reset: true });
		}
	}

	async saveCustomDocument(document: SpreadsheetDocument, cancellation: vscode.CancellationToken): Promise<void> {
		const previous = this.saveQueues.get(document) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(async () => {
			if (document.isDisposed) {throw new vscode.CancellationError();}
			if (cancellation.isCancellationRequested) {
				if (!this.externalConflicts.has(document.uri.toString())) {this.scheduleSave(document);}
				throw new vscode.CancellationError();
			}
			const revision = document.revision;
			const bytes = document.serializeCopy();
			const conflict = this.externalConflicts.get(document.uri.toString());
			if (conflict) {
				throw new Error(conflict.deleted
					? 'El archivo original fue eliminado; usa Save As para conservar el borrador.'
				: 'El archivo cambió en disco; recarga o guarda una copia antes de continuar.');
			}
			if (equalBytes(bytes, document.sourceBytes)) {
				this.postSaveState(document, { type: 'saveState', state: 'saved' });
				return;
			}
			this.postSaveState(document, { type: 'saveState', state: 'saving' });
			const ownWrites = this.ownWrites.get(document) ?? [];
			ownWrites.push(bytes);
			this.ownWrites.set(document, ownWrites);
			try {
				document.validateCopy(bytes);
				await replaceFile(document.uri, bytes, document.sourceBytes, () => cancellation.isCancellationRequested);
				document.sourceBytes = bytes.slice();
				if (document.revision === revision) {
					this.postSaveState(document, { type: 'saveState', state: 'saved' });
				} else {
					this.scheduleSave(document);
				}
			} catch (error) {
				if (isCancellationError(error)) {
					// VS Code may cancel an in-flight save when a newer autosave request
					// supersedes it. Retry quietly even if the bytes reached disk: VS Code
					// still needs one successful save completion to clear the tab marker.
					if (!this.externalConflicts.has(document.uri.toString())) {this.scheduleSave(document);}
					throw error;
				}
				const message = errorMessage(error);
				this.postSaveState(document, { type: 'saveState', state: 'error', message });
				void vscode.window.showErrorMessage(`No se pudo guardar ${path.posix.basename(document.uri.path)}: ${message}`);
				if (message.includes('cambió en disco')) {this.scheduleExternalCheck(document);}
				throw error;
			} finally {
				const index = ownWrites.indexOf(bytes);
				if (index >= 0) {ownWrites.splice(index, 1);}
			}
		});
		this.saveQueues.set(document, current);
		try { await current; }
		finally {
			const key = document.uri.toString();
			const completeAutomaticSave = this.automaticSaveCallbacks.get(key);
			if (completeAutomaticSave) {
				this.automaticSaveCallbacks.delete(key);
				completeAutomaticSave();
			}
		}
	}

	async saveCustomDocumentAs(document: SpreadsheetDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
		if (path.posix.extname(destination.path).toLowerCase() !== path.posix.extname(document.uri.path).toLowerCase()) {
			throw new Error('Save As debe conservar la extensión del formato actual.');
		}
		const bytes = document.serializeCopy();
		document.validateCopy(bytes);
		await replaceFile(destination, bytes);
	}

	async revertCustomDocument(document: SpreadsheetDocument, cancellation: vscode.CancellationToken): Promise<void> {
		const key = document.uri.toString();
		const timer = this.saveTimers.get(key);
		if (timer) {clearTimeout(timer);}
		this.saveTimers.delete(key);
		await this.saveQueues.get(document)?.catch(() => undefined);
		if (cancellation.isCancellationRequested) {throw new vscode.CancellationError();}
		const bytes = await SpreadsheetDocument.readBytes(document.uri);
		if (cancellation.isCancellationRequested) {throw new vscode.CancellationError();}
		document.replaceSavedBytes(bytes);
		this.externalConflicts.delete(key);
		this.conflictPrompts.delete(key);
		for (const panel of this.panels.get(key) ?? []) {this.panelDrafts.delete(panel);}
		this.postDocument(document);
		this.postSaveState(document, { type: 'saveState', state: 'clean' });
	}

	private async reloadFromDisk(document: SpreadsheetDocument): Promise<void> {
		this.postReloadState(document, { type: 'reloadState', state: 'loading' });
		const hasPendingChanges = document.hasUnsavedChanges || this.hasPendingDraft(document);
		if (hasPendingChanges) {
			const choice = await vscode.window.showWarningMessage(
				'Recargar desde disco descartará las ediciones locales pendientes. ¿Deseas continuar?',
				{ modal: true },
				'Recargar archivo',
			);
			if (choice !== 'Recargar archivo') {
				this.postReloadState(document, { type: 'reloadState', state: 'cancelled' });
				this.postSaveState(document, { type: 'saveState', state: 'pending' });
				return;
			}
		}

		const key = document.uri.toString();
		const timer = this.saveTimers.get(key);
		if (timer) {clearTimeout(timer);}
		this.saveTimers.delete(key);
		try {
			await this.saveQueues.get(document)?.catch(() => undefined);
			const bytes = await SpreadsheetDocument.readBytes(document.uri);
			document.replaceSavedBytes(bytes);
			this.externalConflicts.delete(key);
			this.conflictPrompts.delete(key);
			for (const panel of this.panels.get(key) ?? []) {this.panelDrafts.delete(panel);}
			this.postDocument(document);
			this.postSaveState(document, { type: 'saveState', state: 'clean' });
			this.postReloadState(document, { type: 'reloadState', state: 'done' });
		} catch (error) {
			const message = errorMessage(error);
			this.output.appendLine(`No se pudo recargar ${document.uri.toString()}: ${message}`);
			this.postReloadState(document, { type: 'reloadState', state: 'error', message });
			this.postSaveState(document, { type: 'saveState', state: 'error', message });
			void vscode.window.showErrorMessage(`No se pudo recargar ${path.posix.basename(document.uri.path)}: ${message}`);
		}
	}

	private postReloadState(document: SpreadsheetDocument, message: ReloadStateMessage): void {
		for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage(message);}
	}

	private applyEdit(document: SpreadsheetDocument, message: Extract<WebviewToExtensionMessage, { type: 'editCell' }>, scheduleSave = true): void {
		if (document.isDisposed) {return;}
		try {
			if (message.documentId !== document.documentId || message.revision !== document.revision
				|| message.sheetId !== document.sheetId(message.sheetIndex)) {
				throw new Error('La edición quedó desactualizada; se recargaron los datos actuales.');
			}
			if (document.csv?.rowKinds[message.row] === 'comment') {throw new Error('Los registros de comentario CSV no se pueden editar como celdas.');}
			const before = document.editSession.getCell(message.sheetIndex, message.row, message.column);
			if (before.value === message.value && before.exists) {return;}
			document.editCell(message.sheetIndex, message.row, message.column, message.value);
			const event: vscode.CustomDocumentEditEvent<SpreadsheetDocument> = {
				document,
				label: `Editar ${columnName(message.column + 1)}${message.row + 1}`,
				undo: () => { document.undo(); this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document); },
				redo: () => { document.redo(); this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document); },
			};
			this.emitter.fire(event);
			this.postDocument(document);
			this.postSaveState(document, { type: 'saveState', state: 'pending' });
			if (scheduleSave) {this.scheduleSave(document);}
		} catch (error) {
			const messageText = errorMessage(error);
			this.postSaveState(document, { type: 'saveState', state: 'error', message: messageText });
			void vscode.window.showErrorMessage(`No se pudo aplicar la edición: ${messageText}`);
		}
	}

	private watchDocument(document: SpreadsheetDocument): void {
		const key = document.uri.toString();
		if (this.watchers.has(key)) {return;}
		const directory = document.uri.with({ path: path.posix.dirname(document.uri.path) });
		try {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(directory, path.posix.basename(document.uri.path)),
			);
			this.watcherListeners.set(key, [
				watcher.onDidChange(() => this.scheduleExternalCheck(document)),
				watcher.onDidCreate(() => this.scheduleExternalCheck(document)),
				watcher.onDidDelete(() => this.scheduleExternalCheck(document)),
			]);
			this.watchers.set(key, watcher);
		} catch (error) {
			void vscode.window.showWarningMessage(`No se pudo observar cambios externos de ${path.posix.basename(document.uri.path)}: ${errorMessage(error)}. El guardado aún comprobará la versión en disco.`);
		}
	}

	private disposeWatcher(key: string): void {
		this.watchers.get(key)?.dispose();
		this.watchers.delete(key);
		for (const listener of this.watcherListeners.get(key) ?? []) {listener.dispose();}
		this.watcherListeners.delete(key);
		const timer = this.externalTimers.get(key);
		if (timer) {clearTimeout(timer);}
		this.externalTimers.delete(key);
	}

	private scheduleExternalCheck(document: SpreadsheetDocument): void {
		const key = document.uri.toString();
		const previous = this.externalTimers.get(key);
		if (previous) {clearTimeout(previous);}
		this.externalTimers.set(key, setTimeout(() => {
			this.externalTimers.delete(key);
			void this.checkExternalChange(document);
		}, 250));
	}

	private async checkExternalChange(document: SpreadsheetDocument): Promise<void> {
		const key = document.uri.toString();
		let bytes: Uint8Array;
		try {
			bytes = await SpreadsheetDocument.readBytes(document.uri);
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
				this.handleExternalConflict(document, true);
				return;
			}
			const message = errorMessage(error);
			if (document.hasUnsavedChanges || this.hasPendingDraft(document)) {
				this.handleExternalConflict(document, false, false, `No se pudo leer ${path.posix.basename(document.uri.path)} tras un cambio externo: ${message} El borrador se conserva.`);
				return;
			}
			this.postSaveState(document, { type: 'saveState', state: 'error', message });
			void vscode.window.showErrorMessage(`No se pudo recargar ${path.posix.basename(document.uri.path)}: ${message}`);
			return;
		}

		if (equalBytes(bytes, document.sourceBytes)) {
			this.externalConflicts.delete(key);
			this.conflictPrompts.delete(key);
			this.postSaveState(document, { type: 'saveState', state: document.hasUnsavedChanges || this.hasPendingDraft(document) ? 'pending' : 'clean' });
			return;
		}
		if ((this.ownWrites.get(document) ?? []).some(own => equalBytes(bytes, own))) {
			document.sourceBytes = bytes.slice();
			return;
		}
		const workingCopy = document.serializeCopy();
		if (equalBytes(bytes, workingCopy)) {
			document.sourceBytes = bytes.slice();
			this.externalConflicts.delete(key);
			this.conflictPrompts.delete(key);
			this.postSaveState(document, { type: 'saveState', state: this.hasPendingDraft(document) ? 'pending' : 'saved' });
			return;
		}
		if (!document.hasUnsavedChanges && !this.hasPendingDraft(document)) {
			try {
				document.replaceSavedBytes(bytes);
				this.externalConflicts.delete(key);
				this.conflictPrompts.delete(key);
				this.postDocument(document);
				this.postSaveState(document, { type: 'saveState', state: 'clean' });
				void vscode.window.showInformationMessage(`${path.posix.basename(document.uri.path)} cambió en disco y se recargó.`);
			} catch (error) {
				const message = errorMessage(error);
				this.postSaveState(document, { type: 'saveState', state: 'error', message });
				void vscode.window.showErrorMessage(`No se pudo recargar el archivo modificado: ${message}`);
			}
			return;
		}
		this.handleExternalConflict(document, false);
	}

	private handleExternalConflict(document: SpreadsheetDocument, deleted: boolean, allowReload = !deleted, messageOverride?: string): void {
		const key = document.uri.toString();
		this.externalConflicts.set(key, { deleted, allowReload });
		const timer = this.saveTimers.get(key);
		if (timer) {clearTimeout(timer);}
		this.saveTimers.delete(key);
		const message = messageOverride ?? (deleted
			? `Se eliminó ${path.posix.basename(document.uri.path)} en disco. El borrador se conserva.`
			: `${path.posix.basename(document.uri.path)} cambió en disco mientras tenías cambios pendientes. No se sobrescribirá.`);
		this.postSaveState(document, { type: 'saveState', state: 'error', message });
		if (this.conflictPrompts.has(key)) {return;}
		this.conflictPrompts.add(key);
		const actions = allowReload ? ['Recargar descartando cambios', 'Guardar copia…'] : ['Guardar copia…'];
		void vscode.window.showWarningMessage(message, ...actions).then(async action => {
			this.conflictPrompts.delete(key);
			if (action === 'Recargar descartando cambios') {
				try {
					await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
				} catch (error) {
					void vscode.window.showErrorMessage(`No se pudo recargar el archivo: ${errorMessage(error)}`);
				}
			} else if (action === 'Guardar copia…') {
				await this.saveConflictCopy(document);
			}
		});
	}

	private async saveConflictCopy(document: SpreadsheetDocument): Promise<void> {
		for (const panel of this.panels.get(document.uri.toString()) ?? []) {
			const draft = this.panelDrafts.get(panel);
			if (draft) {
				this.panelDrafts.delete(panel);
				this.applyEdit(document, { type: 'editCell', documentId: draft.documentId, revision: document.revision,
					sheetIndex: draft.sheetIndex, sheetId: draft.sheetId, row: draft.row, column: draft.column, value: draft.value }, false);
			}
		}
		const extension = path.posix.extname(document.uri.path);
		const baseName = path.posix.basename(document.uri.path, extension);
		const destination = await vscode.window.showSaveDialog({
			defaultUri: document.uri.with({ path: path.posix.join(path.posix.dirname(document.uri.path), `${baseName}.conflict${extension}`) }),
		});
		if (!destination) {return;}
		try {
			await this.saveCustomDocumentAs(document, destination, new vscode.CancellationTokenSource().token);
			void vscode.window.showInformationMessage(`Se guardó una copia del borrador en ${destination.fsPath || destination.toString()}.`);
		} catch (error) {
			void vscode.window.showErrorMessage(`No se pudo guardar la copia: ${errorMessage(error)}`);
		}
	}

	private hasPendingDraft(document: SpreadsheetDocument): boolean {
		const panels = this.panels.get(document.uri.toString()) ?? [];
		for (const panel of panels) {if (this.panelDrafts.has(panel)) {return true;}}
		return false;
	}

	private scheduleSave(document: SpreadsheetDocument): void {
		if (document.isDisposed) {return;}
		const key = document.uri.toString();
		const previous = this.saveTimers.get(key);
		if (previous) {clearTimeout(previous);}
		this.postSaveState(document, { type: 'saveState', state: 'pending' });
		this.saveTimers.set(key, setTimeout(() => {
			this.saveTimers.delete(key);
			if (document.isDisposed || !this.panels.get(key)?.size) {return;}
			// Route through the workbench's Save action so the custom editor's
			// saveCustomDocument lifecycle completes and clears the tab's dirty marker.
			// Avoid overlapping requests: VS Code cancels an older save when a new
			// one starts, so edits made during a save are queued for its completion.
			if (this.automaticSaveInFlight.has(key)) {
				this.automaticSaveQueued.add(key);
				return;
			}
			this.automaticSaveInFlight.add(key);
			let retryToClearHostState = false;
			let didFinish = false;
			const finishAutomaticSave = (): void => {
				if (didFinish) {return;}
				didFinish = true;
				clearTimeout(watchdog);
				this.automaticSaveCallbacks.delete(key);
				this.automaticSaveInFlight.delete(key);
				const queued = this.automaticSaveQueued.delete(key);
				if ((queued || retryToClearHostState) && !this.externalConflicts.has(key)) {this.scheduleSave(document);}
			};
			const watchdog = setTimeout(() => {
				if (!document.isDisposed && document.hasUnsavedChanges) {
					const message = 'El editor no terminó el guardado automático. Puedes volver a intentar con Ctrl/Cmd+S.';
					this.postSaveState(document, { type: 'saveState', state: 'error', message });
					this.output.appendLine(`${message} ${document.uri.toString()}`);
				}
				finishAutomaticSave();
			}, 30_000);
			this.automaticSaveCallbacks.set(key, finishAutomaticSave);
			void vscode.commands.executeCommand('workbench.action.files.save', { resource: document.uri }).then(() => {
				// The command can resolve before the custom editor finishes writing.
				// saveCustomDocument calls finishAutomaticSave when that write settles.
			}, (error: unknown) => {
				if (document.isDisposed) {finishAutomaticSave(); return;}
				retryToClearHostState = isCancellationError(error);
				if (!retryToClearHostState) {
					this.output.appendLine(`Falló el guardado automático de VS Code: ${errorMessage(error)}`);
					this.postSaveState(document, { type: 'saveState', state: 'error', message: errorMessage(error) });
					finishAutomaticSave();
				}
			});
		}, 300));
	}

	private postDocument(document: SpreadsheetDocument, onlyPanel?: vscode.WebviewPanel): void {
		const panels = onlyPanel ? [onlyPanel] : [...(this.panels.get(document.uri.toString()) ?? [])];
		for (const panel of panels) {
			if (document.csv) {
				const csvRows = document.editSession.getRows(0);
				const csvSettings = vscode.workspace.getConfiguration('spreadsheet-viewer.csv');
				const headerRow = csvSettings.get<boolean>('firstRowHeader', true)
					? document.csv.rowKinds.findIndex(kind => kind === 'data') : -1;
				const caseMode = csvSettings.get<'none' | 'upper' | 'lower'>('headerCase', 'none');
				const headerLabels = headerRow < 0 ? undefined : Array.from({ length: document.csv.columnCount }, (_, column) => {
					const label = csvRows[headerRow]?.[column] ?? '';
					return caseMode === 'upper' ? label.toUpperCase() : caseMode === 'lower' ? label.toLowerCase() : label;
				});
				const data: CsvDataMessage = {
					type: 'csvData', revision: document.revision, documentId: document.documentId, sheetId: document.sheetId(0), fileName: path.posix.basename(document.uri.path), rows: csvRows,
					rowCount: document.csv.rowCount, columnCount: document.csv.columnCount,
					rowKinds: document.csv.rowKinds, physicalLines: document.csv.physicalLines,
					rowComments: document.csv.rowComments,
					headerLabels,
					formatSchema: `csv:${document.csv.delimiter}:${document.csv.quoteChar}:${document.csv.quotes ? 1 : 0}:${document.csv.commentPrefix ?? 'no-comments'}:${headerRow < 0 ? 'none' : createHeaderSignature(csvRows[headerRow] ?? [])}`,
				};
				void panel.webview.postMessage(data);
			} else if (document.xlsx || document.ods) {
				const workbook = document.xlsx ?? document.ods;
				if (!workbook) {continue;}
				const index = Math.min(this.activeSheets.get(panel) ?? 0, Math.max(0, workbook.sheets.length - 1));
				this.activeSheets.set(panel, index);
				this.postXlsxSheet(document, panel, index);
			}
		}
	}

	private getSortState(uri: vscode.Uri, sheetIndex: number): SortStateMessage['criteria'] {
		const value: unknown = this.workspaceState.get(sortStateKey(uri, sheetIndex));
		return Array.isArray(value) && isValidSortCriteria(value, 256) ? value : [];
	}

	private readViewState(uri: vscode.Uri, mode: ViewMode): ViewStateV1 | undefined {
		this.lastViewStateWasCorrupt = false;
		if (!vscode.workspace.getConfiguration('spreadsheet-viewer.view', uri).get<boolean>('restoreState', true)) {return undefined;}
		const result = this.viewStates.read(uri.toString(), mode);
		this.lastViewStateWasCorrupt = result.corrupted;
		if (result.corrupted && !this.warnedCorruptViewState) {
			this.warnedCorruptViewState = true;
			void vscode.window.showWarningMessage('Se ignoró un estado de vista guardado porque estaba dañado o excedía sus límites.');
		}
		return result.state;
	}

	private postSaveState(document: SpreadsheetDocument, message: SaveStateMessage, onlyPanel?: vscode.WebviewPanel): void {
		const panels = onlyPanel ? [onlyPanel] : [...(this.panels.get(document.uri.toString()) ?? [])];
		for (const panel of panels) {void panel.webview.postMessage(message);}
	}

	async backupCustomDocument(
		document: SpreadsheetDocument,
		context: vscode.CustomDocumentBackupContext,
		_cancellation: vscode.CancellationToken,
	): Promise<vscode.CustomDocumentBackup> {
		const id = context.destination.toString();
		const bytes = document.serializeCopy();
		document.validateCopy(bytes);
		await writeBackup(context.destination, bytes);
		return { id, delete: () => { void deleteBackup(id); } };
	}

	getHtml(uri: vscode.Uri, webview: vscode.Webview, modeLabel?: string): string {
		const fileName = uri.path.split('/').pop() || uri.toString();
		const showResetButton = vscode.workspace.getConfiguration('spreadsheet-viewer.view', uri).get<boolean>('showResetButton', true);
		const showClearSortButton = vscode.workspace.getConfiguration('spreadsheet-viewer.view', uri).get<boolean>('showClearSortButton', true);
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
		const stylesheetUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'));
		const nonce = randomBytes(16).toString('base64');

		return `<!DOCTYPE html>
<html lang="es">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval';">
	<link rel="stylesheet" href="${stylesheetUri}">
	<title>${escapeHtml(modeLabel ? `${fileName} · ${modeLabel}` : fileName)}</title>
</head>
<body>
	<main>
		<header id="file-summary">
			<div id="file-heading-row">
				<div id="file-heading">
					<h1>${escapeHtml(fileName)}${modeLabel ? ` · ${escapeHtml(modeLabel)}` : ''}</h1>
					<p id="dimensions" role="status">Cargando archivo…</p>
				</div>
				<div id="header-actions">
					<button id="toggle-comments" type="button" hidden>Mostrar comentarios</button>
					<button id="clear-sort" type="button" title="Quita todos los criterios de orden activos. No modifica los datos del archivo." data-setting-enabled="${showClearSortButton}" hidden>Limpiar orden</button>
					<span id="reset-view-control">
						<button id="reset-view" type="button"${showResetButton ? '' : ' hidden'} aria-describedby="reset-view-tooltip">Restablecer vista</button>
						<span id="reset-view-tooltip" role="tooltip">Borra búsqueda, orden y filtros, y restaura selección y tamaños. No modifica el archivo ni descarta el borrador.</span>
					</span>
					<p id="save-status" role="status" aria-live="polite">Sin cambios</p>
					<button id="reload-file" type="button" title="Volver a leer el archivo desde disco">↻ Recargar</button>
				</div>
			</div>
			<p id="format-note" role="status"></p>
				<p id="sort-warning" role="status" aria-live="polite"></p>
		</header>
		<nav id="navigation-bar" aria-label="Navegación de hoja y celda">
			<label id="sheet-control" class="navigation-group" hidden>
				<span class="control-label">Hoja</span>
				<select id="sheet-selector" aria-label="Hoja activa"></select>
			</label>
			<div id="cell-navigation" class="navigation-group">
				<label class="control-label" for="cell-reference-input">Ir a celda</label>
				<div class="control-row">
					<input id="cell-reference-input" type="text" placeholder="B54" autocomplete="off" spellcheck="false">
					<button id="go-to-cell" type="button">Ir</button>
				</div>
			</div>
			<div id="search-navigation" class="navigation-group">
				<label class="control-label" for="search-input">Buscar en la hoja</label>
				<div class="control-row">
					<input id="search-input" type="search" autocomplete="off" placeholder="Texto o valor">
					<button id="previous-match" type="button" aria-label="Coincidencia anterior" title="Coincidencia anterior">↑</button>
					<button id="next-match" type="button" aria-label="Coincidencia siguiente" title="Coincidencia siguiente">↓</button>
					<output id="search-status" aria-live="polite">Escribe para buscar</output>
				</div>
				<div class="control-row search-options">
					<label><input id="search-all-rows" type="checkbox"> Toda la hoja</label>
					<button id="reveal-hidden-match" type="button" hidden>Mostrar coincidencia</button>
				</div>
			</div>
		</nav>
		<div id="projection-toolbar">
			<div id="filter-chips" aria-label="Filtros activos"></div>
			<output id="projection-count" aria-live="polite"></output>
			<output id="filter-status" aria-live="polite"></output>
			<div id="view-tools" aria-label="Ajustes de vista">
				<label>Autoajuste
					<select id="auto-fit-mode" aria-label="Columnas para autoajustar">
						<option value="none">Desactivado</option><option value="first">Primera columna</option><option value="all" selected>Todas las columnas</option>
					</select>
				</label>
				<span id="auto-fit-control">
					<button id="auto-fit-columns" type="button" aria-describedby="auto-fit-tooltip">Autoajustar</button>
					<span id="auto-fit-tooltip" role="tooltip">Ajusta el ancho de la primera columna o de todas, según la opción elegida. Con Desactivado no cambia los anchos.</span>
				</span>
				<label><input id="wrap-cells" type="checkbox"> Ajustar texto</label>
				<label>Filas fijas <input id="freeze-rows" type="number" min="0" max="50" value="0" aria-label="Cantidad de filas fijas"></label>
				<label>Columnas fijas <input id="freeze-columns" type="number" min="0" max="256" value="0" aria-label="Cantidad de columnas fijas"></label>
			</div>
		</div>
		<section id="filter-popover" role="dialog" aria-label="Filtrar columna" hidden></section>
		<section id="selection" aria-live="polite">
			<div id="selection-meta">
				<strong id="cell-reference">Sin selección</strong>
				<p id="cell-state" data-state="empty">Selecciona una celda para ver su contenido.</p>
			</div>
			<div id="selection-value">
				<span class="control-label">Valor de la celda</span>
				<pre id="cell-value"></pre>
			</div>
			<div id="cell-editor-group">
				<label id="cell-edit-label" class="control-label" for="cell-editor">Editar valor crudo</label>
				<textarea id="cell-editor" rows="2" spellcheck="false" aria-label="Editar valor crudo" disabled></textarea>
				<button id="apply-cell-edit" type="button" disabled>Aplicar</button>
			</div>
		</section>
		<div id="grid-scroll" aria-label="Vista de tabla" tabindex="0">
			<div id="grid-root"></div>
		</div>
	</main>
	<script nonce="${nonce}">
		window.addEventListener('error', event => {
			if (!(event.target instanceof HTMLScriptElement)) {return;}
			const dimensions = document.getElementById('dimensions');
			const status = document.getElementById('save-status');
			if (dimensions) {dimensions.textContent = 'No se pudo iniciar la tabla.';}
			if (status) {status.textContent = 'No se pudo cargar la interfaz: ' + event.target.src; status.classList.add('save-error');}
		}, true);
	</script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}


function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => {
		switch (character) {
			case '&': return '&amp;';
			case '<': return '&lt;';
			case '>': return '&gt;';
			case '"': return '&quot;';
			case "'": return '&#39;';
			default: return character;
		}
	});
}

function isWebviewReadyMessage(message: unknown): message is WebviewToExtensionMessage {
	return typeof message === 'object'
		&& message !== null
		&& 'type' in message
		&& message.type === 'ready';
}

function isReloadFileMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'reloadFile' }> {
	return typeof message === 'object' && message !== null && 'type' in message && message.type === 'reloadFile';
}

function isSelectSheetMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'selectSheet' }> {
	return typeof message === 'object'
		&& message !== null
		&& 'type' in message
		&& message.type === 'selectSheet'
		&& 'documentId' in message && typeof message.documentId === 'string'
		&& 'revision' in message && Number.isInteger(message.revision)
		&& 'sheetId' in message && typeof message.sheetId === 'string'
		&& 'sheetIndex' in message
		&& Number.isInteger(message.sheetIndex)
		&& 'requestId' in message
		&& Number.isInteger(message.requestId);
}

function isInvalidCellMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'invalidCell' }> {
	return typeof message === 'object'
		&& message !== null
		&& 'type' in message
		&& message.type === 'invalidCell';
}

function isEditCellMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'editCell' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'editCell') {return false;}
	const candidate = message as Record<string, unknown>;
	return typeof candidate.documentId === 'string' && Number.isInteger(candidate.revision) && typeof candidate.sheetId === 'string'
		&& Number.isInteger(candidate.sheetIndex) && Number.isInteger(candidate.row)
		&& Number.isInteger(candidate.column) && typeof candidate.value === 'string';
}

function isHistoryMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'history' }> {
	return typeof message === 'object' && message !== null && 'type' in message
		&& message.type === 'history' && 'direction' in message
		&& (message.direction === 'undo' || message.direction === 'redo');
}

function isDraftStateMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'draftState' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'draftState') {return false;}
	const candidate = message as Record<string, unknown>;
	return typeof candidate.dirty === 'boolean' && typeof candidate.documentId === 'string' && Number.isInteger(candidate.revision)
		&& typeof candidate.sheetId === 'string' && Number.isInteger(candidate.sheetIndex)
		&& Number.isInteger(candidate.row) && Number.isInteger(candidate.column) && typeof candidate.value === 'string';
}

function isSetSortMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'setSort' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'setSort') {return false;}
	const candidate = message as Record<string, unknown>;
	return typeof candidate.documentId === 'string' && typeof candidate.sheetId === 'string' && Array.isArray(candidate.criteria)
		&& candidate.criteria.every(item => typeof item === 'object' && item !== null
			&& Number.isInteger((item as Record<string, unknown>).column)
			&& ['asc', 'desc'].includes(String((item as Record<string, unknown>).direction))
			&& ['text', 'number'].includes(String((item as Record<string, unknown>).mode)));
}

function isPersistViewStateMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'persistViewState' }> {
	return typeof message === 'object' && message !== null && 'type' in message && message.type === 'persistViewState'
		&& 'mode' in message && (message.mode === 'edit' || message.mode === 'preview')
		&& 'state' in message && typeof message.state === 'object' && message.state !== null;
}

function isResetViewMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'resetView' }> {
	return typeof message === 'object' && message !== null && 'type' in message && message.type === 'resetView'
		&& 'mode' in message && (message.mode === 'edit' || message.mode === 'preview');
}

function isValidSortCriteria(criteria: unknown[], columnCount: number): boolean {
	return criteria.length <= Math.min(columnCount, 32) && new Set(criteria.map(item => (item as { column: number }).column)).size === criteria.length
		&& criteria.every(item => typeof item === 'object' && item !== null && Number.isInteger((item as { column: number }).column)
			&& (item as { column: number }).column >= 0 && (item as { column: number }).column < columnCount
			&& ['asc', 'desc'].includes((item as { direction: string }).direction)
			&& ['text', 'number'].includes((item as { mode: string }).mode));
}

function getColumnCount(document: SpreadsheetDocument, sheetIndex: number): number {
	return document.csv?.columnCount ?? (document.xlsx ?? document.ods)?.sheets[sheetIndex]?.columnCount ?? 0;
}

function sortStateKey(uri: vscode.Uri, sheetIndex: number): string {
	return `spreadsheet-viewer.view-state.v1:${uri.toString()}:${sheetIndex}`;
}

function columnName(column: number): string {
	let name = '';
	for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) {
		name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
	}
	return name;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isCancellationError(error: unknown): boolean {
	return error instanceof vscode.CancellationError
		|| (typeof error === 'object' && error !== null && 'name' in error && error.name === 'CancellationError')
		|| (typeof error === 'object' && error !== null && 'code' in error && error.code === 'Canceled')
		|| /^(canceled|cancelled)$/i.test(errorMessage(error).trim());
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {return false;}
	for (let index = 0; index < left.byteLength; index++) {if (left[index] !== right[index]) {return false;}}
	return true;
}

export async function resolveDirtyTextBuffer(uri: vscode.Uri): Promise<boolean> {
	const textDocument = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
	if (!textDocument?.isDirty) {return true;}
	const action = await vscode.window.showWarningMessage(
		'Hay cambios de texto sin guardar. Resuélvelos antes de abrir el archivo en el editor de hojas.',
		'Guardar y abrir', 'Descartar y abrir', 'Cancelar',
	);
	if (action === 'Guardar y abrir') {return textDocument.save();}
	if (action === 'Descartar y abrir') {
		await vscode.commands.executeCommand('workbench.action.files.revert', uri);
		return !textDocument.isDirty;
	}
	return false;
}

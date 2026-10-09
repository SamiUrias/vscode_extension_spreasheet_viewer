import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SpreadsheetDocument } from './document';
import { deleteBackup, readBackup, replaceFile, writeBackup } from './storage';
import type { CsvDataMessage, ReloadStateMessage, SaveStateMessage, WebviewToExtensionMessage, XlsxDataMessage } from './protocol';

export class SpreadsheetEditorProvider implements vscode.CustomEditorProvider<SpreadsheetDocument> {
	static readonly viewType = 'spreadsheet-viewer.editor';

	private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();
	private readonly pendingOpens = new Map<string, Thenable<void>>();
	private readonly emitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SpreadsheetDocument>>();
	readonly onDidChangeCustomDocument = this.emitter.event;
	private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly saveQueues = new WeakMap<SpreadsheetDocument, Promise<void>>();
	private readonly activeSheets = new WeakMap<vscode.WebviewPanel, number>();
	private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
	private readonly externalTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly externalConflicts = new Map<string, { deleted: boolean; allowReload: boolean }>();
	private readonly conflictPrompts = new Set<string>();
	private readonly ownWrites = new WeakMap<SpreadsheetDocument, Uint8Array[]>();
	private readonly formulaSnapshots = new WeakMap<SpreadsheetDocument, { revision: number; base64: string }>();
	private readonly panelDrafts = new Map<vscode.WebviewPanel, Extract<WebviewToExtensionMessage, { type: 'draftState' }>>();

	constructor(private readonly extensionUri: vscode.Uri) {}

	async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<SpreadsheetDocument> {
		const backup = openContext.backupId ? await readBackup(openContext.backupId) : undefined;
		return SpreadsheetDocument.open(uri, backup);
	}

	resolveCustomEditor(document: SpreadsheetDocument, panel: vscode.WebviewPanel): void {
		const key = document.uri.toString();
		const documentPanels = this.panels.get(key) ?? new Set<vscode.WebviewPanel>();
		documentPanels.add(panel);
		this.panels.set(key, documentPanels);
		panel.onDidDispose(() => {
			const draft = this.panelDrafts.get(panel);
			if (draft) {
				this.applyEdit(document, { type: 'editCell', sheetIndex: draft.sheetIndex, row: draft.row, column: draft.column, value: draft.value });
			}
			documentPanels.delete(panel);
			this.panelDrafts.delete(panel);
			if (documentPanels.size === 0) {this.panels.delete(key);}
			if (documentPanels.size === 0) {this.disposeWatcher(key);}
		});
		this.watchDocument(document);
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')],
		};
		panel.webview.onDidReceiveMessage((message: unknown) => {
			if (isReloadFileMessage(message)) {
				const debugLog = this.createReloadDebugLog(document);
				void vscode.window.showInformationMessage('Recargando');
				void debugLog('El clic de Recargar llegó al extension host.')
					.then(() => vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: 'Recargando' },
						() => this.reloadFromDisk(document, debugLog),
					));
				return;
			}
			if (isWebviewReadyMessage(message)) {
				this.activeSheets.set(panel, 0);
				try {
					this.postDocument(document, panel);
					this.postSaveState(document, { type: 'saveState', state: document.hasUnsavedChanges ? 'pending' : 'clean' }, panel);
					if (document.hasUnsavedChanges) {this.scheduleSave(document);}
				} catch (error) {
					const detail = errorMessage(error);
					console.error('Spreadsheet Viewer: failed to send the document to its webview', error);
					void panel.webview.postMessage({ type: 'reloadState', state: 'error', message: detail } satisfies ReloadStateMessage);
					void panel.webview.postMessage({ type: 'saveState', state: 'error', message: `No se pudieron cargar los datos: ${detail}` } satisfies SaveStateMessage);
				}
				return;
			}
			if (isSelectSheetMessage(message) && (document.xlsx || document.ods)) {
				this.activeSheets.set(panel, message.sheetIndex);
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
				if (message.dirty) {this.panelDrafts.set(panel, message);}
				else {this.panelDrafts.delete(panel);}
				return;
			}
			if (isHistoryMessage(message)) {
				void vscode.commands.executeCommand(message.direction);
			}
		});
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
			sheetName: sheet.name,
			sheetNames: workbook.sheets.map(item => item.name),
			activeSheetIndex: sheetIndex,
			...(requestId === undefined ? {} : { requestId }),
			rows: document.editSession.getRows(sheetIndex),
			cellKinds: sheet.cellKinds,
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
		if (extension !== '.csv' && extension !== '.xlsx' && extension !== '.ods') {
			throw new Error('Solo se admiten archivos .csv, .xlsx y .ods.');
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

	async saveCustomDocument(document: SpreadsheetDocument, _cancellation: vscode.CancellationToken): Promise<void> {
		const previous = this.saveQueues.get(document) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(async () => {
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
				await replaceFile(document.uri, bytes, document.sourceBytes);
				document.sourceBytes = bytes.slice();
				if (document.revision === revision) {
					this.postSaveState(document, { type: 'saveState', state: 'saved' });
				} else {
					this.scheduleSave(document);
				}
			} catch (error) {
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
		return current;
	}

	async saveCustomDocumentAs(document: SpreadsheetDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
		if (path.posix.extname(destination.path).toLowerCase() !== path.posix.extname(document.uri.path).toLowerCase()) {
			throw new Error('Save As debe conservar la extensión del formato actual (.csv, .xlsx u .ods).');
		}
		const bytes = document.serializeCopy();
		document.validateCopy(bytes);
		await replaceFile(destination, bytes);
	}

	async revertCustomDocument(document: SpreadsheetDocument, _cancellation: vscode.CancellationToken): Promise<void> {
		const timer = this.saveTimers.get(document.uri.toString());
		if (timer) {clearTimeout(timer);}
		this.saveTimers.delete(document.uri.toString());
		const bytes = await SpreadsheetDocument.readBytes(document.uri);
		document.replaceSavedBytes(bytes);
		this.externalConflicts.delete(document.uri.toString());
		this.conflictPrompts.delete(document.uri.toString());
		for (const panel of this.panels.get(document.uri.toString()) ?? []) {this.panelDrafts.delete(panel);}
		this.postDocument(document);
		this.postSaveState(document, { type: 'saveState', state: 'clean' });
	}

	private createReloadDebugLog(document: SpreadsheetDocument): (phase: string) => Promise<void> {
		const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri
			?? vscode.workspace.workspaceFolders?.[0]?.uri
			?? document.uri.with({ path: path.posix.dirname(document.uri.path) });
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const uri = vscode.Uri.joinPath(root, `debug_spreadsheetviewer_${timestamp}.txt`);
		let writes = Promise.resolve();
		let initialized = false;
		return (phase: string): Promise<void> => {
			writes = writes.then(async () => {
				const line = `${new Date().toISOString()} | ${phase}\n`;
				let previous: Uint8Array<ArrayBufferLike> = new Uint8Array();
				if (initialized) {
					try {previous = await vscode.workspace.fs.readFile(uri);} catch {}
				}
				const addition = new TextEncoder().encode(line);
				const contents = new Uint8Array(previous.length + addition.length);
				contents.set(previous);
				contents.set(addition, previous.length);
				await vscode.workspace.fs.writeFile(uri, contents);
				initialized = true;
			}).catch(error => {
				console.error('Spreadsheet Viewer: no se pudo escribir el log de depuración', error);
			});
			return writes;
		};
	}

	private async reloadFromDisk(document: SpreadsheetDocument, debugLog: (phase: string) => Promise<void>): Promise<void> {
		await debugLog('Inicia la rutina de recarga.');
		this.postReloadState(document, { type: 'reloadState', state: 'loading' });
		await debugLog('Estado "loading" enviado a la vista.');
		const hasPendingChanges = document.hasUnsavedChanges || this.hasPendingDraft(document);
		await debugLog(`Comprobadas ediciones pendientes: ${hasPendingChanges ? 'sí' : 'no'}.`);
		if (hasPendingChanges) {
			await debugLog('Esperando decisión del usuario sobre descartar ediciones locales.');
			const choice = await vscode.window.showWarningMessage(
				'Recargar desde disco descartará las ediciones locales pendientes. ¿Deseas continuar?',
				{ modal: true },
				'Recargar archivo',
			);
			if (choice !== 'Recargar archivo') {
				await debugLog('Recarga cancelada por el usuario.');
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
			await debugLog('Esperando a que termine cualquier guardado en curso.');
			await this.saveQueues.get(document)?.catch(() => undefined);
			await debugLog('Guardado en curso finalizado; leyendo bytes desde disco.');
			const bytes = await SpreadsheetDocument.readBytes(document.uri);
			await debugLog(`Archivo leído (${bytes.byteLength} bytes); reemplazando el modelo del documento.`);
			document.replaceSavedBytes(bytes);
			await debugLog('Modelo reemplazado y contenido parseado correctamente.');
			this.externalConflicts.delete(key);
			this.conflictPrompts.delete(key);
			for (const panel of this.panels.get(key) ?? []) {this.panelDrafts.delete(panel);}
			await debugLog('Enviando los datos recargados a las vistas abiertas.');
			this.postDocument(document);
			this.postSaveState(document, { type: 'saveState', state: 'clean' });
			this.postReloadState(document, { type: 'reloadState', state: 'done' });
			await debugLog('Mensajes de datos y estado "done" enviados. Recarga terminada.');
		} catch (error) {
			const message = errorMessage(error);
			await debugLog(`ERROR durante la recarga: ${message}`);
			this.postReloadState(document, { type: 'reloadState', state: 'error', message });
			this.postSaveState(document, { type: 'saveState', state: 'error', message });
			void vscode.window.showErrorMessage(`No se pudo recargar ${path.posix.basename(document.uri.path)}: ${message}`);
		}
	}

	private postReloadState(document: SpreadsheetDocument, message: ReloadStateMessage): void {
		for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage(message);}
	}

	private applyEdit(document: SpreadsheetDocument, message: Extract<WebviewToExtensionMessage, { type: 'editCell' }>, scheduleSave = true): void {
		try {
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
			watcher.onDidChange(() => this.scheduleExternalCheck(document));
			watcher.onDidCreate(() => this.scheduleExternalCheck(document));
			watcher.onDidDelete(() => this.scheduleExternalCheck(document));
			this.watchers.set(key, watcher);
		} catch (error) {
			void vscode.window.showWarningMessage(`No se pudo observar cambios externos de ${path.posix.basename(document.uri.path)}: ${errorMessage(error)}. El guardado aún comprobará la versión en disco.`);
		}
	}

	private disposeWatcher(key: string): void {
		this.watchers.get(key)?.dispose();
		this.watchers.delete(key);
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
				this.applyEdit(document, { type: 'editCell', sheetIndex: draft.sheetIndex, row: draft.row, column: draft.column, value: draft.value }, false);
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
		const key = document.uri.toString();
		const previous = this.saveTimers.get(key);
		if (previous) {clearTimeout(previous);}
		this.postSaveState(document, { type: 'saveState', state: 'pending' });
		this.saveTimers.set(key, setTimeout(() => {
			this.saveTimers.delete(key);
			// Let VS Code own the save lifecycle: besides persisting through
			// saveCustomDocument, this clears the custom editor's dirty tab indicator.
			void vscode.workspace.save(document.uri).then(savedUri => {
				if (!savedUri && document.hasUnsavedChanges) {
					const message = 'VS Code no encontró una pestaña abierta para guardar este archivo.';
					this.postSaveState(document, { type: 'saveState', state: 'error', message });
					void vscode.window.showErrorMessage(`No se pudo guardar ${path.posix.basename(document.uri.path)}: ${message}`);
				}
			}, (error: unknown) => {
				// saveCustomDocument already reports persistence errors and updates the
				// webview status; this handler prevents an unhandled rejection here.
				console.error('Spreadsheet Viewer: VS Code save request failed', error);
			});
		}, 300));
	}

	private postDocument(document: SpreadsheetDocument, onlyPanel?: vscode.WebviewPanel): void {
		const panels = onlyPanel ? [onlyPanel] : [...(this.panels.get(document.uri.toString()) ?? [])];
		for (const panel of panels) {
			if (document.csv) {
				const data: CsvDataMessage = {
					type: 'csvData', revision: document.revision, fileName: path.posix.basename(document.uri.path), rows: document.editSession.getRows(0),
					rowCount: document.csv.rowCount, columnCount: document.csv.columnCount,
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

	private getHtml(uri: vscode.Uri, webview: vscode.Webview): string {
		const fileName = uri.path.split('/').pop() || uri.toString();
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
	<title>${escapeHtml(fileName)}</title>
</head>
<body>
	<main>
		<header id="file-summary">
			<div id="file-heading-row">
				<div id="file-heading">
					<h1>${escapeHtml(fileName)}</h1>
					<p id="dimensions" role="status">Cargando archivo…</p>
				</div>
				<div id="header-actions">
					<p id="save-status" role="status" aria-live="polite">Sin cambios</p>
					<button id="reload-file" type="button" title="Volver a leer el archivo desde disco">↻ Recargar</button>
				</div>
			</div>
			<p id="format-note" role="status"></p>
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
			</div>
		</nav>
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
	return Number.isInteger(candidate.sheetIndex) && Number.isInteger(candidate.row)
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
	return typeof candidate.dirty === 'boolean' && Number.isInteger(candidate.sheetIndex)
		&& Number.isInteger(candidate.row) && Number.isInteger(candidate.column) && typeof candidate.value === 'string';
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {return false;}
	for (let index = 0; index < left.byteLength; index++) {if (left[index] !== right[index]) {return false;}}
	return true;
}

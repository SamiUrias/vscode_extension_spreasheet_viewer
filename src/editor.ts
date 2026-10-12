import * as vscode from 'vscode';
import { SpreadsheetDocument } from './document';
import { loadFormulaParserService } from './formula-parser-loader';
import { CsvDelimiterAmbiguityError, type CsvParseOptions } from './formats/csv';
import { delimiterForCsvResource } from './csv-dialect';
import { isDocumentMutationMessageType } from './filesystem-capability';
import { bytesToBase64, randomBase64 } from './runtime';
import { uriBasename, uriDirname, uriExtname, uriJoin } from './uri-path';
import { deleteBackup, readBackup, replaceFile, writeBackup } from './storage';
import { ExternalFileConflictError, isExternalFileConflictError } from './user-errors';
import type { CsvDataMessage, ReloadStateMessage, SaveStateMessage, SortStateMessage, WebviewToExtensionMessage, XlsxDataMessage } from './protocol';
import { createHeaderSignature, ViewStateRepository, type ViewMode, type ViewStateV1 } from './view-state';
import { parseRecoveryEnvelope, serializeRecoveryEnvelope } from './recovery';
import type { RecoveryDraft } from './recovery';
import { isCellCoveredByRange } from './cell-reference';
import { createMoveRangeEdits } from './move-range';
import { transformFormulaReferences, validateFormulaExpression } from './formula-reference';
import { serializeXlsxEdits } from './formats/xlsx';
import { odsColumnDimensions, odsRowDimensions, xlsxColumnDimensions, xlsxRowDimensions } from './formats/view-metadata';
import type { CellEditDeltaMessage, WorkbookCellEditDeltaMessage } from './protocol';

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
	private readonly formulaSnapshotsSent = new WeakMap<vscode.WebviewPanel, { documentId: string; revision: number }>();
	private formulaWasmBase64: Promise<string> | undefined;
	private readonly panelDrafts = new Map<vscode.WebviewPanel, Extract<WebviewToExtensionMessage, { type: 'draftState' }>>();
	private readonly draftTransactions = new Map<vscode.WebviewPanel, { current: Extract<WebviewToExtensionMessage, { type: 'draftState' }>; active: boolean }>();
	private readonly draftCaptureWaiters = new Map<number, { panel: vscode.WebviewPanel; timer: ReturnType<typeof setTimeout>; resolve: (ok: boolean) => void }>();
	private nextDraftCaptureId = 1;
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
				if (event.affectsConfiguration('spreadsheet-viewer.view.showCopyButtons', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('showCopyButtons', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {
						void panel.webview.postMessage({ type: 'copyButtonVisibility', visible });
					}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.view.showMoveActions', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('showMoveActions', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'moveActionsVisibility', visible });}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.view.showDisplayModeButton', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('showDisplayModeButton', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'displayModeButtonVisibility', visible });}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.xlsx.showStructureActions', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('showStructureActions', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'xlsxStructureActionsVisibility', visible });}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.xlsx.allowFormulaEditing', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('allowFormulaEditing', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'formulaEditingVisibility', visible });}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.xlsx.showFormulaAssistance', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('showFormulaAssistance', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'formulaAssistanceVisibility', visible });}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.xlsx.showFormulaFillActions', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('showFormulaFillActions', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'formulaFillActionsVisibility', visible });}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.xlsx.showTableActions', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('showTableActions', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'tableActionsVisibility', visible });}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.xlsx.showSheetActions', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('showSheetActions', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'sheetActionsVisibility', visible });}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.xlsx.showStyleActions', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('showStyleActions', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'xlsxStyleActionsVisibility', visible });}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.view.showWorkbookAppearance', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('showWorkbookAppearance', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'workbookAppearanceVisibility', visible });}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.csv.showRowActions', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.csv', document.uri).get<boolean>('showRowActions', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'csvRowActionsVisibility', visible });}
				}
				if (event.affectsConfiguration('spreadsheet-viewer.view.showFillActions', document.uri)) {
					const visible = vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('showFillActions', true);
					for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage({ type: 'fillActionsVisibility', visible });}
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
		for (const waiter of this.draftCaptureWaiters.values()) {clearTimeout(waiter.timer); waiter.resolve(false);}
		this.draftCaptureWaiters.clear();
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
		const backupBytes = openContext.backupId ? await readBackup(openContext.backupId) : undefined;
		const recovery = backupBytes ? await parseRecoveryEnvelope(backupBytes) : undefined;
		const open = async (options?: CsvParseOptions): Promise<SpreadsheetDocument> => {
			if (recovery) {return SpreadsheetDocument.restoreRecovery(uri, recovery, options);}
			const document = await SpreadsheetDocument.open(uri, backupBytes, options);
			if (backupBytes) {document.recoveryConflict = true;}
			return document;
		};
		const textDocument = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
		const dialectDelimiter = delimiterForCsvResource(uri.path, textDocument?.languageId);
		const commentPrefix = vscode.workspace.getConfiguration('spreadsheet-viewer.csv', uri).get<string>('commentPrefix', '#');
		try { return await open({ delimiter: dialectDelimiter, commentPrefix: commentPrefix || undefined }); }
		catch (error) {
			if (!(error instanceof CsvDelimiterAmbiguityError)) {throw error;}
			const delimiter = await vscode.window.showQuickPick(error.delimiters.map(value => ({
				label: value === '\t' ? 'Tabulador (TAB)' : value === '|' ? 'Barra vertical (|)' : value,
				description: `Separador ${JSON.stringify(value)}`, value,
			})), { title: 'Elige el separador del archivo', placeHolder: 'El archivo admite más de una interpretación.' });
			if (!delimiter) {throw new Error('Se canceló la selección del dialecto CSV.');}
			return open({ delimiter: delimiter.value, persistDelimiter: true, commentPrefix: commentPrefix || undefined });
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
					this.draftTransactions.delete(panel);
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
			if (isRequestFormulaWasmMessage(message)) {
				void this.postFormulaWasm(panel, message.requestId);
				return;
			}
			if (isRequestSnapshotMessage(message)) {
				if (message.documentId === document.documentId) {this.postDocument(document, panel);}
				return;
			}
			if (isReloadFileMessage(message)) {
				void vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: 'Recargando' },
						() => this.reloadFromDisk(document),
					);
				return;
			}
			if (isWebviewReadyMessage(message)) {
				this.formulaSnapshotsSent.delete(panel);
				const restored = this.readViewState(document.uri, 'edit');
				const workbook = document.xlsx ?? document.ods;
				const recoveredDraft = document.takeRecoveredDraft();
				const restoredIndex = workbook?.sheets.findIndex((_, index) => document.sheetId(index) === restored?.activeSheetId) ?? -1;
				const activeIndex = recoveredDraft?.sheetIndex ?? (restoredIndex >= 0 ? restoredIndex : 0);
				this.activeSheets.set(panel, activeIndex);
				try {
					void panel.webview.postMessage({ type: 'restoreViewState', mode: 'edit', state: restored, corrupted: this.lastViewStateWasCorrupt });
					if (!restored && workbook && vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('restoreState', true)) {
						void panel.webview.postMessage({ type: 'sortState', criteria: this.getSortState(document.uri, activeIndex) } satisfies SortStateMessage);
					}
					this.postDocument(document, panel, recoveredDraft);
					this.postSaveState(document, { type: 'saveState', state: document.hasUnsavedChanges ? 'pending' : 'clean' }, panel);
					if (document.recoveryConflict) {
						this.handleExternalConflict(document, false, false, 'Se recuperó un respaldo cuya versión base no coincide con el archivo actual. El borrador se conserva; guarda una copia para evitar sobrescribir cambios externos.');
					} else if (document.hasUnsavedChanges && this.saveOnCommit(document)) {this.scheduleSave(document);}
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
			if (isCopyToClipboardMessage(message)) {
				if (message.text.length > 5 * 1024 * 1024) {
					void vscode.window.showWarningMessage('El texto copiado supera 5 MiB y puede ser demasiado grande para el portapapeles.', { id: 'copy', title: 'Copiar de todos modos' })
						.then(choice => choice?.id === 'copy' ? writeClipboard(message.text) : undefined);
				} else {
					void writeClipboard(message.text);
				}
				return;
			}
			if (document.isReadOnly && isMutationMessage(message)) {
				this.postSaveState(document, { type: 'saveState', state: 'error', message: 'El proveedor de archivos no permite modificar este recurso; no se aplicaron cambios.' }, panel);
				return;
			}
			if (isEditCellMessage(message)) {
				this.applyEdit(document, message);
				return;
			}
			if (isEditFormulaMessage(message)) {
				void this.applyFormulaEdit(document, message);
				return;
			}
			if (isEditCellsMessage(message)) {
				this.applyEditBatch(document, message, message.edits.map(edit => ({ ...edit, sheetIndex: message.sheetIndex })));
				return;
			}
			if (isCsvRowOperationMessage(message)) {
				void this.applyCsvRowOperation(document, panel, message);
				return;
			}
			if (isXlsxStructureOperationMessage(message)) {
				void this.applyXlsxStructureOperation(document, panel, message);
				return;
			}
			if (isFillFormulaRangeMessage(message)) {
				void this.applyFormulaFill(document, panel, message);
				return;
			}
			if (isCreateXlsxTableMessage(message)) {
				void this.createXlsxTable(document, panel, message);
				return;
			}
			if (isXlsxSheetOperationMessage(message)) {
				void this.applyXlsxSheetOperation(document, panel, message);
				return;
			}
			if (isMoveCellsMessage(message)) {
				void this.moveCells(document, panel, message);
				return;
			}
			if (isXlsxStyleOperationMessage(message)) {
				this.applyXlsxStyleOperation(document, panel, message);
				return;
			}
			if (isDraftStateMessage(message)) {
				if (message.documentId !== document.documentId || message.revision !== document.revision || message.sheetId !== document.sheetId(message.sheetIndex)) {return;}
				let transaction = this.draftTransactions.get(panel);
				if (message.dirty) {
					this.panelDrafts.set(panel, message);
					if (!transaction || !transaction.active) {
						transaction = { current: message, active: true };
						this.draftTransactions.set(panel, transaction);
						this.emitDraftTransaction(document, panel, transaction);
					} else {transaction.current = message;}
				} else {
					this.panelDrafts.delete(panel);
					if (transaction) {transaction.active = false;}
				}
				this.postSaveState(document, { type: 'saveState', state: 'pending' });
				return;
			}
			if (isDraftCaptureResultMessage(message)) {
				const waiter = this.draftCaptureWaiters.get(message.requestId);
				if (!waiter || waiter.panel !== panel) {return;}
				clearTimeout(waiter.timer);
				this.draftCaptureWaiters.delete(message.requestId);
				const draftSheet = (document.xlsx ?? document.ods)?.sheets[message.draft?.sheetIndex ?? -1];
				const draftRowCount = document.csv?.rowCount ?? draftSheet?.rowCount ?? 0;
				if (message.draft && message.draft.row < draftRowCount && message.draft.column < getColumnCount(document, message.draft.sheetIndex)) {
					const state = { type: 'draftState' as const, dirty: true, documentId: document.documentId, revision: document.revision,
						sheetId: document.sheetId(message.draft.sheetIndex), ...message.draft };
					this.panelDrafts.set(panel, state);
					const transaction = this.draftTransactions.get(panel);
					if (transaction?.active) {transaction.current = state;}
					else {
						const next = { current: state, active: true };
						this.draftTransactions.set(panel, next);
						this.emitDraftTransaction(document, panel, next);
					}
				} else {
					this.panelDrafts.delete(panel);
					const transaction = this.draftTransactions.get(panel);
					if (transaction) {transaction.active = false;}
				}
				waiter.resolve(true);
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

	private async postFormulaWasm(panel: vscode.WebviewPanel, requestId: number): Promise<void> {
		try {
			this.formulaWasmBase64 ??= Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'dist', 'formualizer.wasm')))
				.then(bytesToBase64)
				.catch(error => { this.formulaWasmBase64 = undefined; throw error; });
			const wasmBase64 = await this.formulaWasmBase64;
			await panel.webview.postMessage({ type: 'formulaWasmData', requestId, wasmBase64 });
		} catch (error) {
			await panel.webview.postMessage({ type: 'formulaWasmData', requestId, error: errorMessage(error) });
		}
	}

	private postXlsxSheet(
		document: SpreadsheetDocument,
		panel: vscode.WebviewPanel,
		sheetIndex: number,
		requestId?: number,
		recoveredDraft?: RecoveryDraft,
	): void {
		const workbook = document.xlsx ?? document.ods;
		if (!workbook || !Number.isInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= workbook.sheets.length) {
			return;
		}
		const sheet = workbook.sheets[sheetIndex];
		const snapshot = document.editSession.getSheetSnapshot(sheetIndex);
		const workbookHasFormulas = document.xlsx?.sheets.some((_, index) => document.editSession.getSheetSnapshot(index).cellTypes?.some(row => row.includes('formula'))) ?? false;
		const formulaSnapshot = workbookHasFormulas && document.supportsFormulaCalculation ? this.getFormulaSnapshot(document) : undefined;
		const sentSnapshot = this.formulaSnapshotsSent.get(panel);
		const workbookBase64 = formulaSnapshot && (sentSnapshot?.documentId !== document.documentId || sentSnapshot.revision !== document.revision)
			? formulaSnapshot : undefined;
		const workbookMatchesSavedBytes = formulaSnapshot === undefined || formulaSnapshot === bytesToBase64(document.sourceBytes);
		const sheetProtected = document.ods?.sheets[sheetIndex]?.odsMetadata?.protected === true;
		const formulaEditingAllowed = Boolean(document.xlsx) && !document.isReadOnly && vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('allowFormulaEditing', true);
		const mergedRanges = document.xlsx?.sheets[sheetIndex]?.metadata?.mergedRanges ?? document.ods?.sheets[sheetIndex]?.odsMetadata?.mergedRanges ?? [];
		const data: XlsxDataMessage = {
			type: 'xlsxData',
			fileFormat: document.hasMacroWorkbook ? 'xlsm' : document.isXlsm ? 'xlsm' : document.ods ? 'ods' : 'xlsx',
			fileName: document.uri.path.split('/').pop() || document.uri.toString(),
			revision: document.revision,
			documentId: document.documentId,
			sheetId: document.sheetId(sheetIndex),
			sheetIds: workbook.sheets.map((_, index) => document.sheetId(index)),
			sheetName: sheet.name,
			sheetNames: workbook.sheets.map(item => item.name),
			sheetStates: workbook.sheets.map((item, index) => item.state ?? document.ods?.sheets[index]?.odsMetadata?.state ?? 'visible'),
			activeSheetIndex: sheetIndex,
			...(document.xlsx?.sheets[sheetIndex]?.metadata ? {
				columnDimensions: xlsxColumnDimensions(document.xlsx.sheets[sheetIndex]!.metadata!),
				rowDimensions: xlsxRowDimensions(document.xlsx.sheets[sheetIndex]!.metadata!),
				frozenPane: document.xlsx.sheets[sheetIndex]!.metadata!.frozenPane
					&& ['frozen', 'frozenSplit'].includes(document.xlsx.sheets[sheetIndex]!.metadata!.frozenPane!.state ?? '')
					? { xSplit: document.xlsx.sheets[sheetIndex]!.metadata!.frozenPane!.xSplit, ySplit: document.xlsx.sheets[sheetIndex]!.metadata!.frozenPane!.ySplit } : undefined,
				mergedRanges: document.xlsx.sheets[sheetIndex]!.metadata!.mergedRanges,
				cellNotes: document.xlsx.sheets[sheetIndex]!.metadata!.notes,
				cellHyperlinks: document.xlsx.sheets[sheetIndex]!.metadata!.hyperlinks,
			} : document.ods?.sheets[sheetIndex]?.odsMetadata ? {
				columnDimensions: odsColumnDimensions(document.ods.sheets[sheetIndex]!.odsMetadata!, sheet.columnCount),
				rowDimensions: odsRowDimensions(document.ods.sheets[sheetIndex]!.odsMetadata!, sheet.rowCount),
				mergedRanges: document.ods.sheets[sheetIndex]!.odsMetadata!.mergedRanges,
			} : {}),
			...(requestId === undefined ? {} : { requestId }),
			...(recoveredDraft ? { recoveredDraft } : {}),
			readonly: document.isReadOnly,
			rows: snapshot.rows,
			cellKinds: snapshot.cellKinds ?? sheet.cellKinds,
			cellTypes: snapshot.cellTypes ?? sheet.cellTypes,
			cellCapabilities: (snapshot.cellTypes ?? sheet.cellTypes).map((row, rowIndex) => row.map((storedType, columnIndex) => {
				const protectedSheet = sheetProtected || document.xlsx?.sheets[sheetIndex]?.metadata?.protected === true;
				const covered = mergedRanges.some(range => isCellCoveredByRange(range, rowIndex, columnIndex));
				const editable = !document.isReadOnly && !protectedSheet && !covered && storedType !== 'formula' && storedType !== 'error' && storedType !== 'unsupported' && storedType !== 'duration';
				const formulaEditable = formulaEditingAllowed && !protectedSheet && !covered && storedType !== 'error' && storedType !== 'unsupported' && storedType !== 'duration';
				const reason = document.isReadOnly ? 'El proveedor de archivos no permite escribir este recurso.' : protectedSheet ? 'La hoja está protegida.' : covered ? 'Celda cubierta por una combinación.' : `Tipo ${storedType} protegido en esta etapa.`;
				return { storedType, editable, formulaEditable, ...(!editable ? { reason } : {}) };
			})),
			formulaCaches: snapshot.formulaCaches ?? sheet.formulaCaches,
			...(document.xlsx ? {
				structureCapability: document.isReadOnly
					? { allowed: false, reason: 'El proveedor de archivos no permite escribir este recurso.' }
					: !workbookMatchesSavedBytes
					? { allowed: false, reasonCode: 'pending-changes', reason: 'Guarda o deshaz los cambios pendientes antes de cambiar la estructura.' }
					: document.xlsxStructureCapability,
				cellStyleIndexes: document.xlsx.sheets[sheetIndex]?.cellStyleIndexes,
				cellNumberFormats: document.xlsx.styles?.cellFormats.map(style => {
					const custom = document.xlsx!.styles?.customNumberFormats.find(item => item.id === style.numberFormatId);
					return { numberFormatId: style.numberFormatId, ...(custom ? { formatCode: custom.formatCode } : {}) };
				}),
				cellVisualStyles: document.xlsx.styles?.cellVisualStyles,
				date1904: document.xlsx.date1904,
			} : {}),
			...(workbookBase64 ? { workbookBase64 } : {}),
			rowCount: sheet.rowCount,
			columnCount: sheet.columnCount,
			warnings: workbook.warnings,
		};
		void panel.webview.postMessage(data).then(sent => {
			if (sent && workbookBase64) {this.formulaSnapshotsSent.set(panel, { documentId: document.documentId, revision: document.revision });}
		});
	}

	private getFormulaSnapshot(document: SpreadsheetDocument): string {
		const cached = this.formulaSnapshots.get(document);
		if (cached?.revision === document.revision) {return cached.base64;}
		const entry = { revision: document.revision, base64: bytesToBase64(document.serializeCopy()) };
		this.formulaSnapshots.set(document, entry);
		return entry.base64;
	}

	async open(uri: vscode.Uri): Promise<void> {
		const extension = uriExtname(uri.path).toLowerCase();
		if (!['.csv', '.tsv', '.tab', '.xlsx', '.xlsm', '.ods'].includes(extension)) {
			throw new Error('Solo se admiten archivos .csv, .tsv, .tab, .xlsx, .xlsm y .ods.');
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
			if (document.isReadOnly && document.hasUnsavedChanges) {
				throw new Error('El proveedor de archivos no permite escribir este recurso. El borrador se conserva; elige un destino escribible con Guardar como.');
			}
			const automaticSave = this.automaticSaveInFlight.has(document.uri.toString());
			if (!automaticSave) {await this.confirmDraftsBeforeSave(document);}
			const revision = document.revision;
			const bytes = document.serializeCopy();
			const conflict = this.externalConflicts.get(document.uri.toString());
			if (conflict) {
				if (conflict.deleted) {throw new Error('El archivo original fue eliminado; usa Save As para conservar el borrador.');}
				throw new ExternalFileConflictError('El archivo cambió en disco; recarga o guarda una copia antes de continuar.');
			}
			if (equalBytes(bytes, document.sourceBytes)) {
				this.postSaveState(document, { type: 'saveState', state: this.hasPendingDraft(document) ? 'pending' : 'saved' });
				if (this.hasPendingDraft(document)) {this.markPendingDraftsDirty(document);}
				return;
			}
			if (document.isReadOnly) {throw new Error('El proveedor de archivos dejó de confirmar permisos de escritura. El borrador se conserva.');}
			this.postSaveState(document, { type: 'saveState', state: 'saving' });
			const ownWrites = this.ownWrites.get(document) ?? [];
			ownWrites.push(bytes);
			this.ownWrites.set(document, ownWrites);
			try {
				document.validateCopy(bytes);
				await replaceFile(document.uri, bytes, document.sourceBytes, () => cancellation.isCancellationRequested);
				document.sourceBytes = bytes.slice();
				if (document.revision === revision) {
					this.postSaveState(document, { type: 'saveState', state: this.hasPendingDraft(document) ? 'pending' : 'saved' });
				} else {
					this.scheduleSave(document);
				}
				if (this.hasPendingDraft(document)) {this.markPendingDraftsDirty(document);}
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
				void vscode.window.showErrorMessage(`No se pudo guardar ${uriBasename(document.uri.path)}: ${message}`);
				if (isExternalFileConflictError(error)) {this.scheduleExternalCheck(document);}
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
		if (document.hasProtectedPackage) {throw new Error('Guardar como está desactivado para XLSM y libros firmados para proteger macros y firmas digitales.');}
		await this.confirmDraftsBeforeSave(document);
		if (uriExtname(destination.path).toLowerCase() !== uriExtname(document.uri.path).toLowerCase()) {
			throw new Error('Save As debe conservar la extensión del formato actual.');
		}
		const bytes = document.serializeCopy();
		document.validateCopy(bytes);
		if (!vscode.workspace.fs.isWritableFileSystem(destination.scheme)) {
			throw new Error('El destino no pertenece a un proveedor que confirme permisos de escritura.');
		}
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
				{ id: 'apply', title: 'Recargar archivo' },
			);
			if (choice?.id !== 'apply') {
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
			void vscode.window.showErrorMessage(`No se pudo recargar ${uriBasename(document.uri.path)}: ${message}`);
		}
	}

	private postReloadState(document: SpreadsheetDocument, message: ReloadStateMessage): void {
		for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage(message);}
	}

	private applyEdit(document: SpreadsheetDocument, message: Extract<WebviewToExtensionMessage, { type: 'editCell' }>, scheduleSave = true): void {
		if (document.isDisposed) {return;}
		try {
			if (document.isReadOnly) {throw new Error('El documento está en modo de solo lectura.');}
			if (message.documentId !== document.documentId || message.revision !== document.revision
				|| message.sheetId !== document.sheetId(message.sheetIndex)) {
				throw new Error('La edición quedó desactualizada; se recargaron los datos actuales.');
			}
			if (document.csv?.rowKinds[message.row] === 'comment') {throw new Error('Los registros de comentario CSV no se pueden editar como celdas.');}
			const baseRevision = document.revision;
			const before = document.editSession.getCell(message.sheetIndex, message.row, message.column);
			if (before.value === message.value && before.exists) {return;}
			const transactionId = document.editCell(message.sheetIndex, message.row, message.column, message.value);
			if (transactionId === undefined) {return;}
			const event: vscode.CustomDocumentEditEvent<SpreadsheetDocument> = {
				document,
				label: `Editar ${columnName(message.column + 1)}${message.row + 1}`,
				undo: () => { if (document.undo(transactionId)) {this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document);} },
				redo: () => { if (document.redo(transactionId)) {this.clearPendingDraftsForCells(document, [{ sheetIndex: message.sheetIndex, row: message.row, column: message.column, value: message.value }]); this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document);} },
			};
			this.emitter.fire(event);
			if (!this.postCellEditDelta(document, baseRevision, [{ sheetIndex: message.sheetIndex, row: message.row, column: message.column }])) {this.postDocument(document);}
			this.postSaveState(document, { type: 'saveState', state: 'pending' });
			if (scheduleSave && this.saveOnCommit(document)) {this.scheduleSave(document);}
		} catch (error) {
			const messageText = errorMessage(error);
			this.postSaveState(document, { type: 'saveState', state: 'error', message: messageText });
			void vscode.window.showErrorMessage(`No se pudo aplicar la edición: ${messageText}`);
		}
	}

	private async applyFormulaEdit(document: SpreadsheetDocument, message: Extract<WebviewToExtensionMessage, { type: 'editFormula' }>, scheduleSave = true): Promise<boolean> {
		if (document.isDisposed) {return false;}
		try {
			if (document.isReadOnly) {throw new Error('El documento está en modo de solo lectura.');}
			if (!document.xlsx || message.documentId !== document.documentId || message.revision !== document.revision
				|| message.sheetId !== document.sheetId(message.sheetIndex)) {throw new Error('La edición de fórmula quedó desactualizada; se recargaron los datos actuales.');}
			if (!vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('allowFormulaEditing', true)) {
				throw new Error('La edición de fórmulas XLSX está desactivada en Settings.');
			}
			const initialRevision = document.revision;
			const parser = await loadFormulaParserService(this.extensionUri);
			if (document.isDisposed || initialRevision !== document.revision || message.sheetId !== document.sheetId(message.sheetIndex)) {
				throw new Error('El libro cambió mientras se validaba la fórmula; vuelve a intentarlo.');
			}
			const before = document.editSession.getCell(message.sheetIndex, message.row, message.column);
			if (before.value === message.formula && before.type === 'formula') {return true;}
			const transactionId = await document.editFormula(message.sheetIndex, message.row, message.column, message.formula, parser);
			if (transactionId === undefined) {return true;}
			const editedCell = { sheetIndex: message.sheetIndex, row: message.row, column: message.column, value: message.formula };
			const update = () => {this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document);};
			this.emitter.fire({
				document,
				label: `Editar fórmula ${columnName(message.column + 1)}${message.row + 1}`,
				undo: () => {if (document.undo(transactionId)) {update();}},
				redo: () => {if (document.redo(transactionId)) {this.clearPendingDraftsForCells(document, [editedCell]); update();}},
			});
			this.clearPendingDraftsForCells(document, [editedCell]);
			this.postDocument(document);
			this.postSaveState(document, { type: 'saveState', state: 'pending' });
			if (scheduleSave && this.saveOnCommit(document)) {this.scheduleSave(document);}
			return true;
		} catch (error) {
			const messageText = errorMessage(error);
			this.postSaveState(document, { type: 'saveState', state: 'error', message: messageText });
			void vscode.window.showErrorMessage(`No se pudo aplicar la fórmula: ${messageText}`);
			return false;
		}
	}

	private async applyFormulaFill(document: SpreadsheetDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToExtensionMessage, { type: 'fillFormulaRange' }>): Promise<void> {
		try {
			if (document.isReadOnly || !document.xlsx || message.documentId !== document.documentId || message.revision !== document.revision
				|| message.sheetId !== document.sheetId(message.sheetIndex)) {throw new Error('El rango de fórmulas quedó desactualizado o no es editable.');}
			if (!vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('allowFormulaEditing', true)) {
				throw new Error('La edición de fórmulas XLSX está desactivada en Settings.');
			}
			const { startRow, startColumn, endRow, endColumn, direction } = message;
			const sheet = document.xlsx.sheets[message.sheetIndex];
			if (!sheet || ![startRow, startColumn, endRow, endColumn].every(Number.isInteger)
				|| startRow < 0 || startColumn < 0 || endRow < startRow || endColumn < startColumn
				|| endRow >= sheet.rowCount || endColumn >= sheet.columnCount) {throw new Error('El rango seleccionado está fuera de la hoja.');}
			const height = endRow - startRow + 1, width = endColumn - startColumn + 1;
			if (height * width > 100_000 || direction === 'down' && height < 2 || direction === 'right' && width < 2) {throw new Error('El rango no es válido o excede el límite de 100,000 celdas.');}
			const parser = await loadFormulaParserService(this.extensionUri);
			if (message.revision !== document.revision || document.isDisposed) {throw new Error('El libro cambió mientras se preparaban las fórmulas; vuelve a intentarlo.');}
			const formulas: Array<{ sheetIndex: number; row: number; column: number; formula: string }> = [];
			const sourceCells = direction === 'down'
				? Array.from({ length: width }, (_, index) => ({ row: startRow, column: startColumn + index }))
				: Array.from({ length: height }, (_, index) => ({ row: startRow + index, column: startColumn }));
			for (const source of sourceCells) {
				const cell = document.editSession.getCell(message.sheetIndex, source.row, source.column);
				if (cell.storedType !== 'formula' || !cell.value.startsWith('=')) {throw new Error(`La celda ${columnName(source.column + 1)}${source.row + 1} del origen no contiene una fórmula normal.`);}
				const destinations = direction === 'down'
					? Array.from({ length: height - 1 }, (_, index) => ({ row: startRow + index + 1, column: source.column }))
					: Array.from({ length: width - 1 }, (_, index) => ({ row: source.row, column: startColumn + index + 1 }));
				for (const destination of destinations) {
					const transformed = await transformFormulaReferences(cell.value, { kind: 'copy', rowOffset: destination.row - source.row, columnOffset: destination.column - source.column }, parser);
					if (transformed.status === 'unsupported') {throw new Error(`No se pudo transformar ${columnName(source.column + 1)}${source.row + 1}: ${transformed.reason}`);}
					if (!cell.value.includes('#REF!') && transformed.formula.includes('#REF!')) {throw new Error(`La copia desde ${columnName(source.column + 1)}${source.row + 1} produciría una referencia fuera del límite de Excel.`);}
					formulas.push({ sheetIndex: message.sheetIndex, ...destination, formula: transformed.formula });
				}
			}
			if (!formulas.length) {throw new Error('El rango no contiene destinos de fórmula.');}
			await document.editSession.validateFormulaBatch(formulas, parser);
			const preview = formulas.slice(0, 8).map(edit => `${columnName(edit.column + 1)}${edit.row + 1} = ${edit.formula}`).join('\n');
			const suffix = formulas.length > 8 ? `\n… y ${formulas.length - 8} fórmulas más.` : '';
			const answer = await vscode.window.showWarningMessage(`Vista previa de ${formulas.length} fórmulas:\n${preview}${suffix}`, { modal: true }, 'Aplicar');
			if (answer !== 'Aplicar') {return;}
			if (message.revision !== document.revision || document.isDisposed || this.hasPendingDraft(document)) {throw new Error('El documento cambió o tiene un borrador sin confirmar; vuelve a preparar el relleno.');}
			const transactionId = await document.editFormulas(formulas, parser);
			if (transactionId === undefined) {return;}
			const update = () => {this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document);};
			this.emitter.fire({ document, label: `Rellenar ${formulas.length} fórmulas`, undo: () => {if (document.undo(transactionId)) {update();}}, redo: () => {if (document.redo(transactionId)) {update();}} });
			this.postDocument(document);
			this.postSaveState(document, { type: 'saveState', state: 'pending' });
			if (this.saveOnCommit(document)) {this.scheduleSave(document);}
		} catch (error) {
			const messageText = errorMessage(error);
			this.postSaveState(document, { type: 'saveState', state: 'error', message: messageText }, panel);
			void vscode.window.showErrorMessage(`No se pudieron rellenar las fórmulas: ${messageText}`);
		}
	}

	private async createXlsxTable(document: SpreadsheetDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToExtensionMessage, { type: 'createXlsxTable' }>): Promise<void> {
		try {
			if (document.isReadOnly || !document.xlsx || message.documentId !== document.documentId || message.revision !== document.revision
				|| message.sheetId !== document.sheetId(message.sheetIndex)) {throw new Error('La selección XLSX quedó desactualizada o no es editable.');}
			if (!vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('showTableActions', true)) {return;}
			if (document.hasUnsavedChanges || this.hasPendingDraft(document)) {throw new Error('Guarda o deshaz los cambios pendientes antes de crear una tabla.');}
			const name = await vscode.window.showInputBox({
				prompt: 'Nombre único de la tabla de Excel (sin espacios; por ejemplo, SalesData).',
				value: 'Table1',
				validateInput: value => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value) && !/^[A-Za-z]{1,3}\d+$/.test(value) && !/^R\d+C\d+$/i.test(value) ? undefined : 'Usa letras, números, guion bajo o punto; no empieces con una referencia A1 o R1C1.',
			});
			if (!name) {return;}
			if (message.revision !== document.revision || document.isDisposed || document.hasUnsavedChanges) {throw new Error('El archivo cambió mientras se ingresaba el nombre; vuelve a seleccionar el rango.');}
			const transactionId = document.applyXlsxTable({ sheetIndex: message.sheetIndex, startRow: message.startRow, startColumn: message.startColumn,
				endRow: message.endRow, endColumn: message.endColumn, name });
			const update = () => {this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document);};
			this.emitter.fire({ document, label: `Crear tabla ${name}`, undo: () => {if (document.undo(transactionId)) {update();}}, redo: () => {if (document.redo(transactionId)) {update();}} });
			this.postDocument(document);
			this.postSaveState(document, { type: 'saveState', state: 'pending' });
			if (this.saveOnCommit(document)) {this.scheduleSave(document);}
		} catch (error) {
			const messageText = errorMessage(error);
			this.postSaveState(document, { type: 'saveState', state: 'error', message: messageText }, panel);
			void vscode.window.showErrorMessage(`No se pudo crear la tabla XLSX: ${messageText}`);
		}
	}

	private async applyXlsxSheetOperation(document: SpreadsheetDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToExtensionMessage, { type: 'xlsxSheetOperation' }>): Promise<void> {
		try {
			if (document.isReadOnly || !document.xlsx || message.documentId !== document.documentId || message.revision !== document.revision
				|| message.sheetId !== document.sheetId(message.sheetIndex)) {throw new Error('La selección de hoja quedó desactualizada o no es editable.');}
			if (!vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('showSheetActions', true)) {return;}
			if (document.hasUnsavedChanges || this.hasPendingDraft(document)) {throw new Error('Guarda o deshaz los cambios pendientes antes de cambiar hojas.');}
			let name: string | undefined;
			if (message.kind === 'add' || message.kind === 'rename') {
				name = await vscode.window.showInputBox({
					prompt: message.kind === 'add' ? 'Nombre de la hoja nueva (1–31 caracteres).' : 'Nuevo nombre de la hoja seleccionada (1–31 caracteres).',
					value: message.kind === 'rename' ? document.xlsx.sheets[message.sheetIndex]?.name : 'Hoja nueva',
					validateInput: value => value.length > 0 && value.length <= 31 && !Array.from('[]:*?/\\\\').some(character => value.includes(character)) && !value.startsWith("'") && !value.endsWith("'")
						? undefined : 'Usa entre 1 y 31 caracteres; no uses []:*?/\\ ni apóstrofos al inicio o al final.',
				});
				if (!name) {return;}
			} else {
				const answer = await vscode.window.showWarningMessage(`¿Eliminar la hoja «${document.xlsx.sheets[message.sheetIndex]?.name ?? ''}»?`, { modal: true }, 'Eliminar');
				if (answer !== 'Eliminar') {return;}
			}
			if (message.revision !== document.revision || document.isDisposed || document.hasUnsavedChanges || this.hasPendingDraft(document)) {
				throw new Error('El libro cambió mientras se confirmaba; vuelve a iniciar la operación.');
			}
			const oldActive = this.activeSheets.get(panel) ?? 0;
			const transactionId = document.applyXlsxSheet(message.kind === 'add' ? { kind: 'add', name: name! }
				: message.kind === 'rename' ? { kind: 'rename', sheetIndex: message.sheetIndex, name: name! }
				: { kind: 'delete', sheetIndex: message.sheetIndex });
			for (const targetPanel of this.panels.get(document.uri.toString()) ?? []) {
				const current = this.activeSheets.get(targetPanel) ?? 0;
				this.activeSheets.set(targetPanel, message.kind === 'add' && targetPanel === panel ? document.xlsx!.sheets.length - 1
					: message.kind === 'delete' ? current === message.sheetIndex ? Math.min(message.sheetIndex, document.xlsx!.sheets.length - 1)
						: current > message.sheetIndex ? current - 1 : current
					: current);
			}
			if (message.kind === 'add') {this.activeSheets.set(panel, document.xlsx.sheets.length - 1);}
			const update = () => {this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document);};
			this.emitter.fire({ document, label: message.kind === 'add' ? `Añadir hoja ${name}` : message.kind === 'rename' ? `Renombrar hoja ${name}` : 'Eliminar hoja XLSX', undo: () => {if (document.undo(transactionId)) {this.restoreSheetIndexAfterHistory(document, message, oldActive, panel); update();}}, redo: () => {if (document.redo(transactionId)) {this.restoreSheetIndexAfterHistory(document, message, oldActive, panel, true); update();}} });
			this.postDocument(document);
			this.postSaveState(document, { type: 'saveState', state: 'pending' });
			if (this.saveOnCommit(document)) {this.scheduleSave(document);}
		} catch (error) {
			const messageText = errorMessage(error);
			this.postSaveState(document, { type: 'saveState', state: 'error', message: messageText }, panel);
			void vscode.window.showErrorMessage(`No se pudo gestionar la hoja XLSX: ${messageText}`);
		}
	}

	private async moveCells(document: SpreadsheetDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToExtensionMessage, { type: 'moveCells' }>): Promise<void> {
		try {
			if (document.isReadOnly || message.documentId !== document.documentId || message.revision !== document.revision
				|| message.sheetId !== document.sheetId(message.sheetIndex) || !message.token) {throw new Error('El movimiento quedó desactualizado o el documento no es editable.');}
			if (!vscode.workspace.getConfiguration('spreadsheet-viewer.view', document.uri).get<boolean>('showMoveActions', true)) {return;}
			if (document.hasUnsavedChanges || this.hasPendingDraft(document)) {throw new Error('Guarda o deshaz los cambios pendientes antes de mover celdas.');}
			if (document.xlsx) {
				if (document.isXlsm || document.xlsx.sheets.some(sheet => sheet.cellTypes.some(row => row.includes('formula')))) {throw new Error('Mover valores XLSX requiere un libro sin fórmulas ni macros en esta etapa.');}
				if (!document.xlsxStructureCapability.allowed) {throw new Error(`El libro XLSX no cumple el perfil seguro: ${document.xlsxStructureCapability.reason ?? 'estructura no compatible'}`);}
			}
			if (document.ods?.sheets.some(sheet => sheet.cellTypes.some(row => row.includes('formula')))) {throw new Error('Mover valores ODS requiere un libro sin fórmulas en esta etapa.');}
			if (!document.xlsx && !document.ods && !document.csv || document.csv && message.sheetIndex !== 0) {throw new Error('El movimiento requiere una hoja CSV, XLSX u ODS válida.');}
			const sheet = document.xlsx?.sheets[message.sheetIndex] ?? document.ods?.sheets[message.sheetIndex];
			if (sheet?.metadata?.protected || document.ods?.sheets[message.sheetIndex]?.odsMetadata?.protected) {throw new Error('La hoja está protegida.');}
			const { row, column, height, width } = message.source;
			const rows = sheet?.rowCount ?? document.csv?.rowCount ?? 0;
			const columns = sheet?.columnCount ?? document.csv?.columnCount ?? 0;
			if (!Number.isSafeInteger(height * width) || height * width > 100_000 || row + height > rows || column + width > columns
				|| message.destination.row + height > rows || message.destination.column + width > columns) {throw new Error('El movimiento sale de la hoja o supera el límite de 100 000 celdas.');}
			if ((sheet?.metadata?.mergedRanges.length ?? 0) > 0 || (document.ods?.sheets[message.sheetIndex]?.odsMetadata?.mergedRanges.length ?? 0) > 0) {throw new Error('Esta etapa no mueve rangos en hojas con celdas combinadas.');}
			if (document.csv && (row < 0 || column < 0 || row + height > rows || document.csv.rowKinds.slice(row, row + height).includes('comment'))) {throw new Error('El rango de origen no es editable.');}
			const values = Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => {
				const sourceRow = row + r, sourceColumn = column + c;
				if (sheet?.metadata?.mergedRanges.some(range => isCellCoveredByRange(range, sourceRow, sourceColumn))
					|| document.ods?.sheets[message.sheetIndex]?.odsMetadata?.mergedRanges.some(range => isCellCoveredByRange(range, sourceRow, sourceColumn))) {throw new Error('El rango cruza celdas combinadas.');}
				const cell = document.editSession.getCell(message.sheetIndex, sourceRow, sourceColumn);
				if (['formula', 'error', 'unsupported', 'duration'].includes(cell.storedType)) {throw new Error('El rango contiene fórmulas u otras celdas no compatibles.');}
				return { value: cell.value, type: cell.type === 'formula' ? 'string' as const : cell.type };
			}));
			const edits = createMoveRangeEdits(values, { row, column }, message.destination, height, width, rows, columns);
			for (const edit of edits) {
				if (document.csv?.rowKinds[edit.row] === 'comment') {throw new Error('El rango de destino incluye un comentario CSV.');}
				if (sheet?.metadata?.mergedRanges.some(range => isCellCoveredByRange(range, edit.row, edit.column))
					|| document.ods?.sheets[message.sheetIndex]?.odsMetadata?.mergedRanges.some(range => isCellCoveredByRange(range, edit.row, edit.column))) {throw new Error('El rango de destino cruza celdas combinadas.');}
			}
			const answer = await vscode.window.showWarningMessage(`Mover ${height} × ${width} valores dentro de la misma hoja. Esta acción se puede deshacer.`, { modal: true }, 'Mover');
			if (answer !== 'Mover') {void panel.webview.postMessage({ type: 'clearMoveCut', token: message.token, success: false, message: 'Movimiento cancelado; los datos quedaron intactos.' }); return;}
			if (message.revision !== document.revision || document.isDisposed || document.hasUnsavedChanges || this.hasPendingDraft(document)) {throw new Error('El documento cambió durante la confirmación; vuelve a iniciar el movimiento.');}
			if (!this.applyEditBatch(document, message, edits.map(edit => ({ ...edit, ...(document.csv ? { targetType: 'string' as const } : {}), sheetIndex: message.sheetIndex })), true)) {
				void panel.webview.postMessage({ type: 'clearMoveCut', token: message.token, success: false, message: 'No se aplicó ningún cambio.' }); return;
			}
			void panel.webview.postMessage({ type: 'clearMoveCut', token: message.token });
		} catch (error) {
			const messageText = errorMessage(error);
			this.postSaveState(document, { type: 'saveState', state: 'error', message: messageText }, panel);
			void panel.webview.postMessage({ type: 'clearMoveCut', token: message.token, success: false, message: 'Movimiento cancelado: ' + messageText });
			void vscode.window.showErrorMessage(`No se pudo mover el rango: ${messageText}`);
		}
	}

	private applyXlsxStyleOperation(document: SpreadsheetDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToExtensionMessage, { type: 'xlsxStyleOperation' }>): void {
		try {
			if (document.isReadOnly || !document.xlsx || document.isXlsm || message.documentId !== document.documentId
				|| message.revision !== document.revision || message.sheetId !== document.sheetId(message.sheetIndex)
				|| message.operation.sheetIndex !== message.sheetIndex) {throw new Error('El libro o la selección no son editables.');}
			if (!vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('showStyleActions', true)) {return;}
			if (document.hasUnsavedChanges || this.hasPendingDraft(document)) {throw new Error('Guarda o deshaz los cambios pendientes antes de cambiar formato XLSX.');}
			const transactionId = document.applyXlsxStyle(message.operation);
			const labels: Record<string, string> = { format: 'Cambiar estilo XLSX', alignment: 'Cambiar alineación XLSX', numberFormat: 'Cambiar formato numérico XLSX', merge: 'Combinar celdas XLSX', unmerge: 'Separar celdas XLSX', freeze: 'Guardar paneles fijos XLSX' };
			const update = () => {this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document);};
			this.emitter.fire({ document, label: labels[message.operation.kind] ?? 'Cambiar formato XLSX', undo: () => {if (document.undo(transactionId)) {update();}}, redo: () => {if (document.redo(transactionId)) {update();}} });
			this.postDocument(document);
			this.postSaveState(document, { type: 'saveState', state: 'pending' });
			if (this.saveOnCommit(document)) {this.scheduleSave(document);}
		} catch (error) {
			const messageText = errorMessage(error);
			this.postSaveState(document, { type: 'saveState', state: 'error', message: messageText }, panel);
			void vscode.window.showErrorMessage(`No se pudo cambiar el formato XLSX: ${messageText}`);
		}
	}

	private restoreSheetIndexAfterHistory(document: SpreadsheetDocument, message: Extract<WebviewToExtensionMessage, { type: 'xlsxSheetOperation' }>, oldActive: number, panel: vscode.WebviewPanel, redo = false): void {
		const count = document.xlsx?.sheets.length ?? 1;
		for (const targetPanel of this.panels.get(document.uri.toString()) ?? []) {
			const current = this.activeSheets.get(targetPanel) ?? 0;
			let next = current;
			if (message.kind === 'add') {next = targetPanel === panel && redo ? count - 1 : Math.min(current, count - 1);}
			else if (message.kind === 'delete') {
				if (targetPanel === panel) {next = Math.min(oldActive, count - 1);}
				else if (redo) {next = current > message.sheetIndex ? current - 1 : Math.min(current, count - 1);}
				else {next = current >= message.sheetIndex ? Math.min(current + 1, count - 1) : current;}
			}
			this.activeSheets.set(targetPanel, next);
		}
	}

	private applyEditBatch(
		document: SpreadsheetDocument,
		message: Pick<Extract<WebviewToExtensionMessage, { type: 'editCells' }>, 'documentId' | 'revision' | 'sheetIndex' | 'sheetId'>,
		edits: Array<{ sheetIndex: number; row: number; column: number; value: string; targetType?: 'string' | 'number' | 'boolean' | 'date' }>,
		scheduleSave = true,
	): boolean {
		if (document.isDisposed) {return false;}
		try {
			if (document.isReadOnly) {throw new Error('El documento está en modo de solo lectura.');}
			if (message.documentId !== document.documentId || message.revision !== document.revision
				|| message.sheetId !== document.sheetId(message.sheetIndex)) {
				throw new Error('La edición quedó desactualizada; se recargaron los datos actuales.');
			}
			if (document.csv && edits.some(edit => document.csv?.rowKinds[edit.row] === 'comment')) {throw new Error('Los registros de comentario CSV no se pueden editar como celdas.');}
			const baseRevision = document.revision;
			const transactionId = document.editCells(edits);
			if (transactionId === undefined) {return false;}
			const event: vscode.CustomDocumentEditEvent<SpreadsheetDocument> = {
				document,
				label: `Editar ${edits.length} celdas`,
				undo: () => { if (document.undo(transactionId)) {this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document);} },
				redo: () => { if (document.redo(transactionId)) {this.clearPendingDraftsForCells(document, edits); this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document);} },
			};
			this.emitter.fire(event);
			if (!this.postCellEditDelta(document, baseRevision, edits)) {this.postDocument(document);}
			this.postSaveState(document, { type: 'saveState', state: 'pending' });
			if (scheduleSave && this.saveOnCommit(document)) {this.scheduleSave(document);}
			return true;
		} catch (error) {
			const messageText = errorMessage(error);
			this.postSaveState(document, { type: 'saveState', state: 'error', message: messageText });
			void vscode.window.showErrorMessage(`No se pudo aplicar la edición: ${messageText}`);
			return false;
		}
	}

	private postCellEditDelta(
		document: SpreadsheetDocument,
		baseRevision: number,
		edits: readonly { sheetIndex: number; row: number; column: number }[],
	): boolean {
		if (document.csv) {
			if (edits.some(edit => edit.sheetIndex !== 0)) {return false;}
			const settings = vscode.workspace.getConfiguration('spreadsheet-viewer.csv', document.uri);
			const headerRow = settings.get<boolean>('firstRowHeader', true) ? document.csv.rowKinds.findIndex(kind => kind === 'data') : -1;
			if (edits.some(edit => edit.row === headerRow)) {return false;}
			const cells = edits.map(edit => ({ row: edit.row, column: edit.column, value: document.editSession.getCell(0, edit.row, edit.column).value }));
			if (cells.some(cell => !Number.isInteger(cell.row) || cell.row < 0 || cell.row >= document.csv!.rowCount
				|| !Number.isInteger(cell.column) || cell.column < 0 || cell.column >= document.csv!.columnCount)) {return false;}
			const message: CellEditDeltaMessage = { type: 'cellEditDelta', documentId: document.documentId, baseRevision, revision: document.revision, cells };
			for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage(message);}
			return true;
		}
		const workbook = document.xlsx ?? document.ods;
		if (!workbook || workbook.sheets.some(sheet => sheet.cellKinds.some(row => row.includes('formula')))
			|| edits.length === 0 || edits.some(edit => edit.sheetIndex !== edits[0]!.sheetIndex)) {return false;}
		const sheetIndex = edits[0]!.sheetIndex;
		const sheet = workbook.sheets[sheetIndex];
		if (!sheet) {return false;}
		const updated = document.editSession.getSheetSnapshot(sheetIndex);
		if (!updated.cellKinds || !updated.cellTypes) {return false;}
		const cells = edits.map(edit => {
			const storedType = updated.cellTypes![edit.row]?.[edit.column];
			const kind = updated.cellKinds![edit.row]?.[edit.column];
			const value = updated.rows[edit.row]?.[edit.column];
			return storedType && kind && value !== undefined ? { row: edit.row, column: edit.column, value, kind, storedType, editable: true } : undefined;
		});
		if (cells.some(cell => !cell) || cells.some(cell => cell!.row < 0 || cell!.row >= sheet.rowCount
			|| cell!.column < 0 || cell!.column >= sheet.columnCount)) {return false;}
		const message: WorkbookCellEditDeltaMessage = { type: 'workbookCellEditDelta', documentId: document.documentId,
			baseRevision, revision: document.revision, sheetIndex, cells: cells as NonNullable<(typeof cells)[number]>[] };
		for (const panel of this.panels.get(document.uri.toString()) ?? []) {void panel.webview.postMessage(message);}
		return true;
	}

	private async applyXlsxStructureOperation(document: SpreadsheetDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToExtensionMessage, { type: 'xlsxStructureOperation' }>): Promise<void> {
		try {
			if (document.isReadOnly) {throw new Error('El documento está en modo de solo lectura.');}
			if (!document.xlsx || message.documentId !== document.documentId || message.revision !== document.revision
				|| message.sheetId !== document.sheetId(message.sheetIndex)) {throw new Error('La operación quedó desactualizada; se recargaron los datos actuales.');}
			if (!vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', document.uri).get<boolean>('showStructureActions', true)) {return;}
			if (document.hasUnsavedChanges || this.hasPendingDraft(document)) {throw new Error('Guarda o deshaz los cambios pendientes antes de cambiar la estructura XLSX.');}
			if (message.kind.startsWith('delete')) {
				const label = message.kind === 'deleteRows' ? 'fila(s)' : 'columna(s)';
				const answer = await vscode.window.showWarningMessage(`¿Eliminar ${message.count} ${label} XLSX seleccionada(s)?`, { modal: true }, 'Eliminar');
				if (answer !== 'Eliminar') {return;}
				if (message.revision !== document.revision || message.sheetId !== document.sheetId(message.sheetIndex)) {
					throw new Error('La operación cambió mientras se confirmaba; vuelve a intentarlo.');
				}
			}
			const formulaParser = document.xlsx.sheets.some(sheet => sheet.cellTypes.some(row => row.includes('formula')))
				? await loadFormulaParserService(this.extensionUri) : undefined;
			if (message.revision !== document.revision || message.sheetId !== document.sheetId(message.sheetIndex)
				|| document.hasUnsavedChanges || this.hasPendingDraft(document)) {throw new Error('El archivo cambió mientras se preparaba la operación; guarda y vuelve a intentarlo.');}
			const transactionId = await document.applyXlsxStructure({ kind: message.kind, sheetIndex: message.sheetIndex, index: message.index, count: message.count }, formulaParser);
			const label = message.kind.startsWith('insert') ? 'Insertar estructura XLSX' : 'Eliminar estructura XLSX';
			const update = () => {this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document);};
			this.emitter.fire({ document, label, undo: () => {if (document.undo(transactionId)) {update();}}, redo: () => {if (document.redo(transactionId)) {update();}} });
			update();
			const sheet = document.xlsx.sheets[message.sheetIndex];
			if (sheet && sheet.rowCount && sheet.columnCount) {
				const row = Math.min(message.kind.includes('Rows') ? message.index : 0, sheet.rowCount - 1);
				const column = Math.min(message.kind.includes('Columns') ? message.index : 0, sheet.columnCount - 1);
				void panel.webview.postMessage({ type: 'focusCell', row, column });
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`No se pudo cambiar la estructura XLSX: ${errorMessage(error)}`);
		}
	}

	private async applyCsvRowOperation(document: SpreadsheetDocument, panel: vscode.WebviewPanel, message: Extract<WebviewToExtensionMessage, { type: 'csvRowOperation' }>): Promise<void> {
		try {
			if (document.isReadOnly) {throw new Error('El documento está en modo de solo lectura.');}
			if (!document.csv || message.documentId !== document.documentId || message.revision !== document.revision
				|| message.sheetId !== document.sheetId(0)) {throw new Error('La operación quedó desactualizada; se recargaron los datos actuales.');}
			if (!vscode.workspace.getConfiguration('spreadsheet-viewer.csv', document.uri).get<boolean>('showRowActions', true)) {return;}
			if (message.kind === 'delete') {
				if (vscode.workspace.getConfiguration('spreadsheet-viewer.csv', document.uri).get<boolean>('firstRowHeader', true)) {
					const headerRow = document.csv.rowKinds.findIndex(kind => kind === 'data');
					if (headerRow >= 0 && message.rows?.includes(headerRow)) {throw new Error('No se puede eliminar la fila de encabezados CSV.');}
				}
				const answer = await vscode.window.showWarningMessage(`¿Eliminar ${message.rows?.length ?? 0} registro(s) CSV?`, { modal: true }, 'Eliminar');
				if (answer !== 'Eliminar') {return;}
			}
			let columnCount = document.csv.columnCount;
			if (message.kind === 'append' && document.csv.rowCount === 0 && columnCount === 0) {
				const entered = await vscode.window.showInputBox({
					title: 'Añadir el primer registro CSV',
					prompt: 'El archivo está vacío. Indica cuántos campos tendrá el primer registro (1–256).',
					value: '1',
					validateInput: value => {
						const count = Number(value);
						return /^\d+$/.test(value) && Number.isInteger(count) && count >= 1 && count <= 256
							? undefined : 'Escribe un número entero entre 1 y 256.';
					},
				});
				if (entered === undefined) {return;}
				columnCount = Number(entered);
			}
			await this.confirmDraftsBeforeSave(document);
			const operation = message.kind === 'delete'
				? { kind: 'delete' as const, rows: message.rows ?? [] }
			: { kind: 'insert' as const, index: message.kind === 'append' ? document.csv.rowCount : message.index ?? -1,
				rows: [Array.from({ length: columnCount }, () => '')] };
			const transactionId = document.applyCsvRowOperation(operation);
			const label = message.kind === 'delete' ? 'Eliminar registros CSV' : message.kind === 'append' ? 'Añadir registro CSV' : 'Insertar registro CSV';
			const update = () => {this.postDocument(document); this.postSaveState(document, { type: 'saveState', state: 'pending' }); this.scheduleSave(document);};
			this.emitter.fire({ document, label, undo: () => {if (document.undo(transactionId)) {update();}}, redo: () => {if (document.redo(transactionId)) {update();}} });
			update();
			if (document.csv.rowCount > 0) {
				const row = message.kind === 'append' ? document.csv.rowCount - 1
					: message.kind === 'insert' ? Math.min(message.index ?? 0, document.csv.rowCount - 1)
						: Math.min(Math.min(...(message.rows ?? [0])), document.csv.rowCount - 1);
				void panel.webview.postMessage({ type: 'focusCell', row, column: 0 });
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`No se pudo cambiar la estructura CSV: ${errorMessage(error)}`);
		}
	}

	private async confirmDraftsBeforeSave(document: SpreadsheetDocument): Promise<void> {
		if (!await this.captureDrafts(document)) {throw new Error('No se pudo confirmar el borrador visible; se canceló guardar para conservarlo.');}
		const entries = [...(this.panels.get(document.uri.toString()) ?? [])]
			.map(panel => ({ panel, draft: this.panelDrafts.get(panel) })).filter((entry): entry is { panel: vscode.WebviewPanel; draft: NonNullable<typeof entry.draft> } => Boolean(entry.draft));
		if (!entries.length) {return;}
		const choice = await vscode.window.showWarningMessage(
			'Hay texto de celda sin confirmar. ¿Quieres aplicarlo antes de guardar?',
			{ modal: true }, { id: 'apply', title: 'Aplicar borradores y guardar' }, { id: 'save', title: 'Guardar solo cambios aplicados' }, { id: 'cancel', title: 'Cancelar' },
		);
		if (choice?.id === 'cancel' || choice === undefined) {throw new vscode.CancellationError();}
		if (choice.id === 'apply') {
			const formulaDrafts = entries.filter(({ draft }) => draft.formula);
			if (formulaDrafts.length) {
				if (!document.xlsx) {throw new Error('Las fórmulas solo se pueden aplicar a borradores de libros XLSX.');}
				const parser = await loadFormulaParserService(this.extensionUri);
				const coordinates = new Set<string>();
				const formulaEdits = [] as Array<{ sheetIndex: number; row: number; column: number; value: string; type: 'formula' }>;
				for (const { draft } of entries) {
					const key = `${draft.sheetIndex}:${draft.row}:${draft.column}`;
					if (coordinates.has(key)) {throw new Error('Hay borradores duplicados para la misma celda; confirma uno antes de guardar.');}
					coordinates.add(key);
					if (!draft.formula) {continue;}
					const sheet = document.xlsx.sheets[draft.sheetIndex];
					if (!sheet || draft.row < 0 || draft.row >= sheet.rowCount || draft.column < 0 || draft.column >= sheet.columnCount
						|| sheet.metadata?.protected || sheet.metadata?.mergedRanges.some(range => isCellCoveredByRange(range, draft.row, draft.column))) {
						throw new Error('Un borrador de fórmula apunta a una celda que no se puede editar.');
					}
					await validateFormulaExpression(draft.value, parser);
					formulaEdits.push({ sheetIndex: draft.sheetIndex, row: draft.row, column: draft.column, value: draft.value, type: 'formula' });
				}
				// Preflight the entire formula set before applying any draft to the working copy.
				serializeXlsxEdits(document.serializeCopy(), formulaEdits);
			}
			const edits = entries.filter(({ draft }) => !draft.formula).map(({ draft }) => ({ sheetIndex: draft.sheetIndex, row: draft.row, column: draft.column, value: draft.value }));
			const changed = edits.some(edit => {
				const current = document.editSession.getCell(edit.sheetIndex, edit.row, edit.column);
				return current.value !== edit.value || !current.exists;
			});
			if (changed) {
				const message = { documentId: document.documentId, revision: document.revision, sheetIndex: edits[0]!.sheetIndex, sheetId: document.sheetId(edits[0]!.sheetIndex) };
				if (!this.applyEditBatch(document, message, edits, false)) {throw new Error('No se pudo aplicar el borrador; no se guardó el archivo.');}
			}
			for (const { draft } of formulaDrafts) {
				const message = { type: 'editFormula' as const, documentId: document.documentId, revision: document.revision,
					sheetIndex: draft.sheetIndex, sheetId: document.sheetId(draft.sheetIndex), row: draft.row, column: draft.column, formula: draft.value };
				if (!await this.applyFormulaEdit(document, message, false)) {throw new Error('No se pudo aplicar el borrador de fórmula; no se guardó el archivo.');}
			}
			this.clearAllDrafts(document);
		} else {this.markPendingDraftsDirty(document);}
	}

	private clearAllDrafts(document: SpreadsheetDocument): void {
		for (const panel of this.panels.get(document.uri.toString()) ?? []) {
			this.panelDrafts.delete(panel);
			const transaction = this.draftTransactions.get(panel);
			if (transaction) {transaction.active = false;}
			void panel.webview.postMessage({ type: 'discardCellDraft' });
		}
	}

	private markPendingDraftsDirty(document: SpreadsheetDocument): void {
		for (const panel of this.panels.get(document.uri.toString()) ?? []) {
			const transaction = this.draftTransactions.get(panel);
			if (transaction?.active) {this.emitDraftTransaction(document, panel, transaction);}
		}
	}

	private emitDraftTransaction(
		document: SpreadsheetDocument,
		panel: vscode.WebviewPanel,
		state: { current: Extract<WebviewToExtensionMessage, { type: 'draftState' }>; active: boolean },
	): void {
		this.emitter.fire({
			document, label: 'Borrador de celda sin confirmar',
			undo: () => {
				if (!state.active) {return;}
				state.active = false;
				this.panelDrafts.delete(panel);
				void panel.webview.postMessage({ type: 'discardCellDraft' });
				this.postSaveState(document, { type: 'saveState', state: document.hasUnsavedChanges ? 'pending' : 'clean' });
			},
			redo: () => {
				if (state.active || document.isDisposed) {return;}
				state.active = true;
				const current = { ...state.current, revision: document.revision, sheetId: document.sheetId(state.current.sheetIndex) };
				state.current = current;
				this.panelDrafts.set(panel, current);
				void panel.webview.postMessage({ type: 'restoreCellDraft', draft: { sheetIndex: current.sheetIndex, row: current.row, column: current.column, value: current.value, ...(current.formula ? { formula: true } : {}) } });
				this.postSaveState(document, { type: 'saveState', state: 'pending' });
			},
		});
	}

	private clearPendingDraftsForCells(
		document: SpreadsheetDocument,
		edits: readonly { sheetIndex: number; row: number; column: number; value: string }[],
	): void {
		for (const [panel, state] of this.draftTransactions) {
			if (!state.active) {continue;}
			const draft = state.current;
			if (draft.documentId !== document.documentId || !edits.some(edit => edit.sheetIndex === draft.sheetIndex
				&& edit.row === draft.row && edit.column === draft.column && edit.value === draft.value)) {continue;}
			state.active = false;
			this.panelDrafts.delete(panel);
			void panel.webview.postMessage({ type: 'discardCellDraft' });
		}
	}

	private saveOnCommit(document: SpreadsheetDocument): boolean {
		return vscode.workspace.getConfiguration('spreadsheet-viewer.edit', document.uri).get<boolean>('saveOnCommit', true);
	}

	private watchDocument(document: SpreadsheetDocument): void {
		const key = document.uri.toString();
		if (this.watchers.has(key)) {return;}
		const directory = document.uri.with({ path: uriDirname(document.uri.path) });
		try {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(directory, uriBasename(document.uri.path)),
			);
			this.watcherListeners.set(key, [
				watcher.onDidChange(() => this.scheduleExternalCheck(document)),
				watcher.onDidCreate(() => this.scheduleExternalCheck(document)),
				watcher.onDidDelete(() => this.scheduleExternalCheck(document)),
			]);
			this.watchers.set(key, watcher);
		} catch (error) {
			void vscode.window.showWarningMessage(`No se pudo observar cambios externos de ${uriBasename(document.uri.path)}: ${errorMessage(error)}. El guardado aún comprobará la versión en disco.`);
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
				this.handleExternalConflict(document, false, false, `No se pudo leer ${uriBasename(document.uri.path)} tras un cambio externo: ${message} El borrador se conserva.`);
				return;
			}
			this.postSaveState(document, { type: 'saveState', state: 'error', message });
			void vscode.window.showErrorMessage(`No se pudo recargar ${uriBasename(document.uri.path)}: ${message}`);
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
				void vscode.window.showInformationMessage(`${uriBasename(document.uri.path)} cambió en disco y se recargó.`);
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
			? `Se eliminó ${uriBasename(document.uri.path)} en disco. El borrador se conserva.`
			: `${uriBasename(document.uri.path)} cambió en disco mientras tenías cambios pendientes. No se sobrescribirá.`);
		this.postSaveState(document, { type: 'saveState', state: 'error', message });
		if (this.conflictPrompts.has(key)) {return;}
		this.conflictPrompts.add(key);
		const actions = allowReload ? [{ id: 'reload', title: 'Recargar descartando cambios' }, { id: 'copy', title: 'Guardar copia…' }] : [{ id: 'copy', title: 'Guardar copia…' }];
		void vscode.window.showWarningMessage(message, ...actions).then(async action => {
			this.conflictPrompts.delete(key);
			if (action?.id === 'reload') {
				try {
					await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
				} catch (error) {
					void vscode.window.showErrorMessage(`No se pudo recargar el archivo: ${errorMessage(error)}`);
				}
			} else if (action?.id === 'copy') {
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
		this.clearAllDrafts(document);
		const extension = uriExtname(document.uri.path);
		const baseName = uriBasename(document.uri.path, extension);
		const destination = await vscode.window.showSaveDialog({
			defaultUri: document.uri.with({ path: uriJoin(uriDirname(document.uri.path), `${baseName}.conflict${extension}`) }),
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

	private postDocument(document: SpreadsheetDocument, onlyPanel?: vscode.WebviewPanel, recoveredDraft?: RecoveryDraft): void {
		const panels = onlyPanel ? [onlyPanel] : [...(this.panels.get(document.uri.toString()) ?? [])];
		for (const panel of panels) {
			if (document.csv) {
				const csvRows = document.editSession.getRows(0);
				const csvSettings = vscode.workspace.getConfiguration('spreadsheet-viewer.csv', document.uri);
				const headerRow = csvSettings.get<boolean>('firstRowHeader', true)
					? document.csv.rowKinds.findIndex(kind => kind === 'data') : -1;
				const caseMode = csvSettings.get<'none' | 'upper' | 'lower'>('headerCase', 'none');
				const headerLabels = headerRow < 0 ? undefined : Array.from({ length: document.csv.columnCount }, (_, column) => {
					const label = csvRows[headerRow]?.[column] ?? '';
					return caseMode === 'upper' ? label.toUpperCase() : caseMode === 'lower' ? label.toLowerCase() : label;
				});
				const data: CsvDataMessage = {
					type: 'csvData', revision: document.revision, documentId: document.documentId, sheetId: document.sheetId(0), fileName: uriBasename(document.uri.path), rows: csvRows,
					readonly: document.isReadOnly,
					rowCount: document.csv.rowCount, columnCount: document.csv.columnCount,
					rowKinds: document.csv.rowKinds, physicalLines: document.csv.physicalLines,
					rowComments: document.csv.rowComments,
					headerLabels,
					formatSchema: `csv:${document.csv.delimiter}:${document.csv.quoteChar}:${document.csv.quotes ? 1 : 0}:${document.csv.commentPrefix ?? 'no-comments'}:${headerRow < 0 ? 'none' : createHeaderSignature(csvRows[headerRow] ?? [])}`,
					...(recoveredDraft ? { recoveredDraft } : {}),
				};
				void panel.webview.postMessage(data);
			} else if (document.xlsx || document.ods) {
				const workbook = document.xlsx ?? document.ods;
				if (!workbook) {continue;}
				const index = Math.min(this.activeSheets.get(panel) ?? 0, Math.max(0, workbook.sheets.length - 1));
				this.activeSheets.set(panel, index);
				this.postXlsxSheet(document, panel, index, undefined, recoveredDraft);
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
		cancellation: vscode.CancellationToken,
	): Promise<vscode.CustomDocumentBackup> {
		const id = context.destination.toString();
		if (cancellation.isCancellationRequested) {throw new vscode.CancellationError();}
		if (!await this.captureDrafts(document)) {throw new Error('No se pudo recoger el texto sin confirmar; se canceló la copia de recuperación para no perderlo.');}
		if (cancellation.isCancellationRequested) {throw new vscode.CancellationError();}
		const workingBytes = document.serializeCopy();
		document.validateCopy(workingBytes);
		const drafts = [...(this.panels.get(document.uri.toString()) ?? [])]
			.map(panel => this.panelDrafts.get(panel)).filter((draft): draft is NonNullable<typeof draft> => Boolean(draft));
		const draft = drafts.at(-1);
		const bytes = await serializeRecoveryEnvelope({
			uri: document.uri.toString(), baselineBytes: document.sourceBytes, workingBytes,
			...(draft ? { draft: { sheetIndex: draft.sheetIndex, row: draft.row, column: draft.column, value: draft.value, ...(draft.formula ? { formula: true } : {}) } } : {}),
		});
		await writeBackup(context.destination, bytes);
		return { id, delete: () => { void deleteBackup(id); } };
	}

	private async captureDrafts(document: SpreadsheetDocument): Promise<boolean> {
		const panels = [...(this.panels.get(document.uri.toString()) ?? [])];
		const results = await Promise.all(panels.map(panel => new Promise<boolean>(resolve => {
			const requestId = this.nextDraftCaptureId++;
			const timer = setTimeout(() => {this.draftCaptureWaiters.delete(requestId); resolve(false);}, 1_500);
			this.draftCaptureWaiters.set(requestId, { panel, timer, resolve });
			void panel.webview.postMessage({ type: 'captureDraft', requestId }).then(sent => {
				if (!sent) {
					const waiter = this.draftCaptureWaiters.get(requestId);
					if (waiter) {clearTimeout(waiter.timer); this.draftCaptureWaiters.delete(requestId); waiter.resolve(false);}
				}
			});
		})));
		return results.every(Boolean);
	}

	getHtml(uri: vscode.Uri, webview: vscode.Webview, modeLabel?: string): string {
		const fileName = uri.path.split('/').pop() || uri.toString();
		const showResetButton = vscode.workspace.getConfiguration('spreadsheet-viewer.view', uri).get<boolean>('showResetButton', true);
		const showClearSortButton = vscode.workspace.getConfiguration('spreadsheet-viewer.view', uri).get<boolean>('showClearSortButton', true);
		const showCopyButtons = vscode.workspace.getConfiguration('spreadsheet-viewer.view', uri).get<boolean>('showCopyButtons', true);
		const showMoveActions = !modeLabel && vscode.workspace.getConfiguration('spreadsheet-viewer.view', uri).get<boolean>('showMoveActions', true);
		const showDisplayModeButton = vscode.workspace.getConfiguration('spreadsheet-viewer.view', uri).get<boolean>('showDisplayModeButton', true);
		const showXlsxStructureActions = !modeLabel && vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', uri).get<boolean>('showStructureActions', true);
		const showWorkbookAppearance = vscode.workspace.getConfiguration('spreadsheet-viewer.view', uri).get<boolean>('showWorkbookAppearance', true);
		const showCsvRowActions = vscode.workspace.getConfiguration('spreadsheet-viewer.csv', uri).get<boolean>('showRowActions', true);
		const showFillActions = vscode.workspace.getConfiguration('spreadsheet-viewer.view', uri).get<boolean>('showFillActions', true);
		const showFormulaEditing = vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', uri).get<boolean>('allowFormulaEditing', true);
		const showFormulaAssistance = vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', uri).get<boolean>('showFormulaAssistance', true);
		const showFormulaFillActions = vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', uri).get<boolean>('showFormulaFillActions', true);
		const showTableActions = vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', uri).get<boolean>('showTableActions', true);
		const showSheetActions = !modeLabel && vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', uri).get<boolean>('showSheetActions', true);
		const showStyleActions = !modeLabel && vscode.workspace.getConfiguration('spreadsheet-viewer.xlsx', uri).get<boolean>('showStyleActions', true);
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
		const stylesheetUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'));
		const formulaWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'formula-worker.js'));
		const formulaWasmBaseUri = `${webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist')).toString()}/`;
		const nonce = randomBase64(16);

		return `<!DOCTYPE html>
<html lang="es">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource}; worker-src blob:; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval';">
	<link rel="stylesheet" href="${stylesheetUri}">
	<title>${escapeHtml(modeLabel ? `${fileName} · ${modeLabel}` : fileName)}</title>
</head>
<body data-formula-worker-src="${escapeHtml(formulaWorkerUri.toString())}" data-formula-wasm-base-uri="${escapeHtml(formulaWasmBaseUri)}">
	<main>
		<header id="file-summary">
			<div id="file-heading-row">
				<div id="file-heading">
					<h1>${escapeHtml(fileName)}${modeLabel ? ` · ${escapeHtml(modeLabel)}` : ''}</h1>
					<p id="dimensions" role="status">Cargando archivo…</p>
				</div>
				<div id="header-actions">
					<div id="copy-actions"${showCopyButtons ? '' : ' hidden'} aria-label="Copiar selección">
						<span class="copy-control"><button id="copy-raw" type="button" aria-describedby="copy-raw-tooltip">Copiar</button><span id="copy-raw-tooltip" role="tooltip">Copia la selección cruda en TSV; las fórmulas se copian como expresión.</span></span>
						<span class="copy-control"><button id="copy-displayed" type="button" aria-describedby="copy-displayed-tooltip">Copiar mostrado</button><span id="copy-displayed-tooltip" role="tooltip">Copia los valores tal como aparecen en la cuadrícula con la presentación actual.</span></span>
						<span class="copy-control"><button id="copy-headers" type="button" aria-describedby="copy-headers-tooltip">Copiar con encabezados</button><span id="copy-headers-tooltip" role="tooltip">Añade las etiquetas de columna al inicio; no modifica el archivo.</span></span>
					</div>
					<div id="move-actions" data-setting-visible="${showMoveActions}"${showMoveActions ? '' : ' hidden'} aria-label="Mover celdas"><span class="copy-control"><button id="cut-range" type="button" aria-describedby="cut-range-tooltip">Cortar rango</button><span id="cut-range-tooltip" role="tooltip">Marca el rango seleccionado para moverlo dentro de esta hoja; copiar al portapapeles nunca borra el origen.</span></span><span class="copy-control"><button id="move-range" type="button" aria-describedby="move-range-tooltip" hidden>Pegar movimiento</button><span id="move-range-tooltip" role="tooltip">Mueve el rango marcado a la celda seleccionada después de confirmar; puedes deshacerlo.</span></span><output id="move-status" aria-live="polite"></output></div>
					<div id="xlsx-style-actions" data-setting-visible="${showStyleActions}"${showStyleActions ? '' : ' hidden'} aria-label="Formato XLSX"><span class="copy-control"><button id="toggle-xlsx-style" type="button" aria-describedby="toggle-xlsx-style-tooltip" aria-expanded="false">Formato XLSX</button><span id="toggle-xlsx-style-tooltip" role="tooltip">Abre las acciones para aplicar estilos simples, combinar celdas o guardar los paneles fijos en el libro.</span></span><div id="xlsx-style-controls" hidden><span class="copy-control"><button id="xlsx-style-bold" type="button" aria-describedby="xlsx-style-bold-tooltip">Negrita</button><span id="xlsx-style-bold-tooltip" role="tooltip">Activa o quita negrita en todas las celdas seleccionadas; conserva sus demás estilos y valores.</span></span><span class="copy-control"><button id="xlsx-style-italic" type="button" aria-describedby="xlsx-style-italic-tooltip">Cursiva</button><span id="xlsx-style-italic-tooltip" role="tooltip">Activa o quita cursiva en todas las celdas seleccionadas; conserva sus demás estilos y valores.</span></span><span class="copy-control"><button id="xlsx-style-wrap" type="button" aria-describedby="xlsx-style-wrap-tooltip">Ajustar texto</button><span id="xlsx-style-wrap-tooltip" role="tooltip">Activa o quita el ajuste de texto en las celdas seleccionadas.</span></span><span class="copy-control"><button id="xlsx-style-left" type="button" aria-describedby="xlsx-style-left-tooltip">Izquierda</button><span id="xlsx-style-left-tooltip" role="tooltip">Alinea horizontalmente las celdas seleccionadas a la izquierda.</span></span><span class="copy-control"><button id="xlsx-style-center" type="button" aria-describedby="xlsx-style-center-tooltip">Centrar</button><span id="xlsx-style-center-tooltip" role="tooltip">Centra horizontalmente las celdas seleccionadas.</span></span><span class="copy-control"><button id="xlsx-style-right" type="button" aria-describedby="xlsx-style-right-tooltip">Derecha</button><span id="xlsx-style-right-tooltip" role="tooltip">Alinea horizontalmente las celdas seleccionadas a la derecha.</span></span><label><span class="control-label">Formato numérico</span><select id="xlsx-number-format" aria-label="Formato numérico"><option>General</option><option>0</option><option>0.00</option><option>#,##0</option><option>#,##0.00</option><option>0%</option><option>0.00%</option><option>mm-dd-yy</option></select></label><span class="copy-control"><button id="xlsx-style-apply-number" type="button" aria-describedby="xlsx-style-apply-number-tooltip">Aplicar formato</button><span id="xlsx-style-apply-number-tooltip" role="tooltip">Aplica al rango el formato numérico de la lista. Solo se ofrecen formatos incorporados de Excel.</span></span><span class="copy-control"><button id="xlsx-style-merge" type="button" aria-describedby="xlsx-style-merge-tooltip">Combinar</button><span id="xlsx-style-merge-tooltip" role="tooltip">Combina el rango rectangular seleccionado si las celdas cubiertas están vacías.</span></span><span class="copy-control"><button id="xlsx-style-unmerge" type="button" aria-describedby="xlsx-style-unmerge-tooltip">Separar</button><span id="xlsx-style-unmerge-tooltip" role="tooltip">Separa exactamente la combinación seleccionada; no inventa ni modifica valores.</span></span><span class="copy-control"><button id="xlsx-style-freeze" type="button" aria-describedby="xlsx-style-freeze-tooltip">Guardar paneles fijos</button><span id="xlsx-style-freeze-tooltip" role="tooltip">Guarda en el XLSX las filas y columnas que ahora están fijadas en la vista del editor.</span></span></div><output id="xlsx-style-status" aria-live="polite"></output></div>
					<span id="fill-actions-control"${showFillActions ? '' : ' hidden'} class="copy-control"><button id="fill-range" type="button" aria-describedby="fill-range-tooltip">Rellenar rango</button><span id="fill-range-tooltip" role="tooltip">Repite los valores o extiende una serie numérica en el rango seleccionado. Muestra una vista previa antes de aplicar; se puede deshacer.</span></span>
					<div id="formula-fill-actions" data-setting-visible="${showFormulaFillActions}"${showFormulaFillActions ? '' : ' hidden'}><span class="copy-control"><button id="fill-formulas-down" type="button" aria-describedby="fill-formulas-down-tooltip">Rellenar fórmulas abajo</button><span id="fill-formulas-down-tooltip" role="tooltip">Copia las fórmulas de la primera fila seleccionada hacia abajo y ajusta referencias relativas. Revisa la vista previa antes de aplicar.</span></span><span class="copy-control"><button id="fill-formulas-right" type="button" aria-describedby="fill-formulas-right-tooltip">Rellenar fórmulas derecha</button><span id="fill-formulas-right-tooltip" role="tooltip">Copia las fórmulas de la primera columna seleccionada hacia la derecha y ajusta referencias relativas. Revisa la vista previa antes de aplicar.</span></span></div>
					<span id="table-actions-control" data-setting-visible="${showTableActions}"${showTableActions ? '' : ' hidden'} class="copy-control"><button id="create-xlsx-table" type="button" aria-describedby="create-xlsx-table-tooltip">Crear tabla XLSX</button><span id="create-xlsx-table-tooltip" role="tooltip">Crea una tabla nativa de Excel en el rango seleccionado si sus encabezados y el libro pasan la validación. No cambia los valores.</span></span>
					<span class="copy-control"><button id="toggle-display-mode" type="button"${showDisplayModeButton ? '' : ' hidden'} aria-describedby="display-mode-tooltip">Ver libro</button><span id="display-mode-tooltip" role="tooltip">Alterna entre valores crudos y su formato numérico de presentación. No modifica el archivo.</span></span>
					<div id="csv-row-actions"${showCsvRowActions ? '' : ' hidden'} aria-label="Acciones de registros CSV">
						<span class="copy-control"><button id="insert-row" type="button" aria-describedby="insert-row-tooltip">Insertar fila</button><span id="insert-row-tooltip" role="tooltip">Inserta un registro vacío debajo de la fila seleccionada. La operación se puede deshacer.</span></span>
						<span class="copy-control"><button id="append-row" type="button" aria-describedby="append-row-tooltip">Añadir fila</button><span id="append-row-tooltip" role="tooltip">Añade un registro vacío al final de los datos CSV. La operación se puede deshacer.</span></span>
						<span class="copy-control"><button id="delete-row" type="button" aria-describedby="delete-row-tooltip">Eliminar fila(s)</button><span id="delete-row-tooltip" role="tooltip">Elimina el registro o rango seleccionado después de pedir confirmación.</span></span>
					</div>
					<span class="copy-control"><button id="toggle-xlsx-structure" type="button"${showXlsxStructureActions ? '' : ' hidden'} aria-describedby="xlsx-structure-tooltip" aria-expanded="false">Estructura XLSX</button><span id="xlsx-structure-tooltip" role="tooltip">Abre las acciones para insertar o eliminar filas y columnas. Se habilitan solo en libros compatibles.</span></span>
					<div id="xlsx-structure-actions" hidden aria-label="Acciones estructurales XLSX">
						<p id="xlsx-structure-status" role="status" aria-live="polite"></p>
						<span class="copy-control"><button id="insert-xlsx-row-before" type="button" aria-describedby="insert-xlsx-row-before-tooltip">Insertar fila arriba</button><span id="insert-xlsx-row-before-tooltip" role="tooltip">Inserta una fila vacía antes de la fila seleccionada.</span></span>
						<span class="copy-control"><button id="insert-xlsx-row-after" type="button" aria-describedby="insert-xlsx-row-after-tooltip">Insertar fila abajo</button><span id="insert-xlsx-row-after-tooltip" role="tooltip">Inserta una fila vacía después de la fila seleccionada.</span></span>
						<span class="copy-control"><button id="delete-xlsx-row" type="button" aria-describedby="delete-xlsx-row-tooltip">Eliminar fila(s)</button><span id="delete-xlsx-row-tooltip" role="tooltip">Elimina las filas seleccionadas después de pedir confirmación.</span></span>
						<span class="copy-control"><button id="insert-xlsx-column-before" type="button" aria-describedby="insert-xlsx-column-before-tooltip">Insertar columna izquierda</button><span id="insert-xlsx-column-before-tooltip" role="tooltip">Inserta una columna vacía a la izquierda de la columna seleccionada.</span></span>
						<span class="copy-control"><button id="insert-xlsx-column-after" type="button" aria-describedby="insert-xlsx-column-after-tooltip">Insertar columna derecha</button><span id="insert-xlsx-column-after-tooltip" role="tooltip">Inserta una columna vacía a la derecha de la columna seleccionada.</span></span>
						<span class="copy-control"><button id="delete-xlsx-column" type="button" aria-describedby="delete-xlsx-column-tooltip">Eliminar columna(s)</button><span id="delete-xlsx-column-tooltip" role="tooltip">Elimina las columnas seleccionadas después de pedir confirmación.</span></span>
					</div>
					<button id="toggle-comments" type="button" hidden>Mostrar comentarios</button>
					<span id="clear-sort-control">
						<button id="clear-sort" type="button" data-setting-enabled="${showClearSortButton}" aria-describedby="clear-sort-tooltip" hidden>Limpiar orden</button>
						<span id="clear-sort-tooltip" role="tooltip">Quita todos los criterios de orden activos. No modifica los datos del archivo.</span>
					</span>
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
			<div id="sheet-control" class="navigation-group" data-actions-visible="${showSheetActions}" hidden>
				<div id="sheet-tabs" role="tablist" aria-label="Hojas del libro"></div>
				<label class="sheet-selector-fallback"><span class="control-label">Ir a hoja</span><select id="sheet-selector" aria-label="Hoja activa"></select></label>
				<div id="sheet-actions"${showSheetActions ? '' : ' hidden'}><span class="copy-control"><button id="add-xlsx-sheet" type="button" aria-describedby="add-xlsx-sheet-tooltip">Añadir hoja</button><span id="add-xlsx-sheet-tooltip" role="tooltip">Añade una hoja vacía al libro con un nombre válido y único.</span></span><span class="copy-control"><button id="rename-xlsx-sheet" type="button" aria-describedby="rename-xlsx-sheet-tooltip">Renombrar hoja</button><span id="rename-xlsx-sheet-tooltip" role="tooltip">Cambia el nombre de la hoja seleccionada si el libro cumple el perfil seguro.</span></span><span class="copy-control"><button id="delete-xlsx-sheet" type="button" aria-describedby="delete-xlsx-sheet-tooltip">Eliminar hoja</button><span id="delete-xlsx-sheet-tooltip" role="tooltip">Elimina la hoja seleccionada después de confirmarlo; el libro conserva una hoja visible.</span></span></div>
				<output id="sheet-state-status" aria-live="polite"></output>
			</div>
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
				<label id="formula-mode-control"${showFormulaEditing ? '' : ' hidden'}><input id="formula-edit-mode" type="checkbox" data-setting-enabled="${showFormulaEditing}" aria-describedby="formula-mode-tooltip"> Editar como fórmula <span id="formula-mode-tooltip" role="tooltip">Habilita la edición o creación explícita de una fórmula XLSX. La sintaxis se valida antes de guardarla.</span></label>
				<label id="cell-edit-label" class="control-label" for="cell-editor">Editar valor crudo</label>
				<textarea id="cell-editor" rows="2" spellcheck="false" aria-label="Editar valor crudo" disabled></textarea>
				<div id="formula-assistance-controls" data-setting-enabled="${showFormulaAssistance}"${showFormulaAssistance ? '' : ' hidden'}>
					<span><button id="pick-formula-reference" type="button" aria-pressed="false" aria-describedby="pick-formula-reference-tooltip">Insertar referencia seleccionada</button><span id="pick-formula-reference-tooltip" role="tooltip">Activa el modo y haz clic en una celda para insertar su referencia sin cambiar el borrador de fórmula.</span></span>
					<div id="formula-completions" role="listbox" aria-label="Funciones compatibles" hidden></div>
				</div>
				<button id="apply-cell-edit" type="button" disabled>Aplicar</button>
			</div>
		</section>
		<div id="grid-scroll" aria-label="Vista de tabla" tabindex="0">
			<div id="grid-root" data-workbook-appearance="${showWorkbookAppearance}"></div>
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

async function writeClipboard(text: string): Promise<void> {
	try {await vscode.env.clipboard.writeText(text);}
	catch (error) {void vscode.window.showErrorMessage(`No se pudo copiar la selección: ${errorMessage(error)}`);}
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

function isRequestFormulaWasmMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'requestFormulaWasm' }> {
	return typeof message === 'object' && message !== null && 'type' in message && message.type === 'requestFormulaWasm'
		&& 'requestId' in message && Number.isInteger(message.requestId);
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

function isCopyToClipboardMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'copyToClipboard' }> {
	return typeof message === 'object' && message !== null && 'type' in message && message.type === 'copyToClipboard'
		&& 'text' in message && typeof message.text === 'string' && message.text.length <= 50 * 1024 * 1024;
}

function isEditCellMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'editCell' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'editCell') {return false;}
	const candidate = message as Record<string, unknown>;
	return typeof candidate.documentId === 'string' && Number.isInteger(candidate.revision) && typeof candidate.sheetId === 'string'
		&& Number.isInteger(candidate.sheetIndex) && Number.isInteger(candidate.row)
		&& Number.isInteger(candidate.column) && typeof candidate.value === 'string';
}

function isEditFormulaMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'editFormula' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'editFormula') {return false;}
	const candidate = message as Record<string, unknown>;
	return typeof candidate.documentId === 'string' && Number.isInteger(candidate.revision) && typeof candidate.sheetId === 'string'
		&& Number.isInteger(candidate.sheetIndex) && Number.isInteger(candidate.row) && Number.isInteger(candidate.column)
		&& typeof candidate.formula === 'string' && candidate.formula.length <= 32 * 1024;
}

function isEditCellsMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'editCells' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'editCells') {return false;}
	const candidate = message as Record<string, unknown>;
	if (typeof candidate.documentId !== 'string' || !Number.isInteger(candidate.revision) || !Number.isInteger(candidate.sheetIndex)
		|| typeof candidate.sheetId !== 'string' || !Array.isArray(candidate.edits) || candidate.edits.length > 500_000) {return false;}
	let totalCharacters = 0;
	return candidate.edits.every(item => {
		if (typeof item !== 'object' || item === null) {return false;}
		const edit = item as Record<string, unknown>;
		if (!Number.isInteger(edit.row) || !Number.isInteger(edit.column) || typeof edit.value !== 'string'
			|| (edit.targetType !== undefined && !['string', 'number', 'boolean', 'date'].includes(String(edit.targetType)))) {return false;}
		totalCharacters += (edit.value as string).length;
		return totalCharacters <= 50 * 1024 * 1024;
	});
}

function isCsvRowOperationMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'csvRowOperation' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'csvRowOperation') {return false;}
	const value = message as Record<string, unknown>;
	if (typeof value.documentId !== 'string' || !Number.isInteger(value.revision) || typeof value.sheetId !== 'string'
		|| !['insert', 'append', 'delete'].includes(String(value.kind))) {return false;}
	if (value.kind === 'insert' && !Number.isInteger(value.index)) {return false;}
	if (value.kind === 'delete' && (!Array.isArray(value.rows) || value.rows.length === 0 || value.rows.length > 50_000
		|| !value.rows.every(Number.isInteger))) {return false;}
	return true;
}

function isXlsxStructureOperationMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'xlsxStructureOperation' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'xlsxStructureOperation') {return false;}
	const value = message as Record<string, unknown>;
	return typeof value.documentId === 'string' && Number.isInteger(value.revision) && typeof value.sheetId === 'string'
		&& Number.isInteger(value.sheetIndex) && ['insertRows', 'deleteRows', 'insertColumns', 'deleteColumns'].includes(String(value.kind))
		&& Number.isInteger(value.index) && Number(value.index) >= 0 && Number.isInteger(value.count)
		&& Number(value.count) > 0 && Number(value.count) <= 50_000;
}

function isFillFormulaRangeMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'fillFormulaRange' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'fillFormulaRange') {return false;}
	const value = message as Record<string, unknown>;
	return typeof value.documentId === 'string' && Number.isInteger(value.revision) && typeof value.sheetId === 'string'
		&& Number.isInteger(value.sheetIndex) && (value.direction === 'down' || value.direction === 'right')
		&& Number.isInteger(value.startRow) && Number(value.startRow) >= 0 && Number.isInteger(value.startColumn) && Number(value.startColumn) >= 0
		&& Number.isInteger(value.endRow) && Number(value.endRow) >= Number(value.startRow)
		&& Number.isInteger(value.endColumn) && Number(value.endColumn) >= Number(value.startColumn);
}

function isCreateXlsxTableMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'createXlsxTable' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'createXlsxTable') {return false;}
	const value = message as Record<string, unknown>;
	return typeof value.documentId === 'string' && Number.isInteger(value.revision) && typeof value.sheetId === 'string'
		&& Number.isInteger(value.sheetIndex) && Number(value.sheetIndex) >= 0
		&& Number.isInteger(value.startRow) && Number(value.startRow) >= 0 && Number.isInteger(value.startColumn) && Number(value.startColumn) >= 0
		&& Number.isInteger(value.endRow) && Number(value.endRow) >= Number(value.startRow)
		&& Number.isInteger(value.endColumn) && Number(value.endColumn) >= Number(value.startColumn);
}

function isXlsxSheetOperationMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'xlsxSheetOperation' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'xlsxSheetOperation') {return false;}
	const value = message as Record<string, unknown>;
	return typeof value.documentId === 'string' && Number.isInteger(value.revision) && typeof value.sheetId === 'string'
		&& Number.isInteger(value.sheetIndex) && Number(value.sheetIndex) >= 0 && ['add', 'rename', 'delete'].includes(String(value.kind));
}

function isMoveCellsMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'moveCells' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'moveCells') {return false;}
	const value = message as Record<string, unknown>;
	const source = value.source as Record<string, unknown> | undefined, destination = value.destination as Record<string, unknown> | undefined;
	return typeof value.documentId === 'string' && Number.isSafeInteger(value.revision) && typeof value.sheetId === 'string'
		&& Number.isSafeInteger(value.sheetIndex) && Number(value.sheetIndex) >= 0 && typeof value.token === 'string' && value.token.length > 0
		&& Boolean(source && Number.isSafeInteger(source.row) && Number(source.row) >= 0 && Number.isSafeInteger(source.column) && Number(source.column) >= 0
			&& Number.isSafeInteger(source.height) && Number(source.height) > 0 && Number.isSafeInteger(source.width) && Number(source.width) > 0)
		&& Boolean(destination && Number.isSafeInteger(destination.row) && Number(destination.row) >= 0
			&& Number.isSafeInteger(destination.column) && Number(destination.column) >= 0);
}

function isXlsxStyleOperationMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'xlsxStyleOperation' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'xlsxStyleOperation') {return false;}
	const value = message as Record<string, unknown>, operation = value.operation as Record<string, unknown> | undefined;
	if (typeof value.documentId !== 'string' || !Number.isSafeInteger(value.revision) || typeof value.sheetId !== 'string'
		|| !Number.isSafeInteger(value.sheetIndex) || Number(value.sheetIndex) < 0 || !operation || operation.sheetIndex !== value.sheetIndex) {return false;}
	if (operation.kind === 'freeze') {return Number.isSafeInteger(operation.rows) && Number(operation.rows) >= 0 && Number.isSafeInteger(operation.columns) && Number(operation.columns) >= 0;}
	if (!['format', 'alignment', 'numberFormat', 'merge', 'unmerge'].includes(String(operation.kind))) {return false;}
	if (![operation.startRow, operation.startColumn, operation.endRow, operation.endColumn].every(Number.isSafeInteger)) {return false;}
	if (operation.kind === 'format') {return ['bold', 'italic', 'wrapText'].includes(String(operation.property)) && (operation.value === undefined || typeof operation.value === 'boolean');}
	if (operation.kind === 'alignment') {return ['general', 'left', 'center', 'right'].includes(String(operation.value));}
	if (operation.kind === 'numberFormat') {return ['General', '0', '0.00', '#,##0', '#,##0.00', '0%', '0.00%', 'mm-dd-yy'].includes(String(operation.value));}
	return operation.kind === 'merge' || operation.kind === 'unmerge';
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
		&& Number.isInteger(candidate.row) && Number.isInteger(candidate.column) && typeof candidate.value === 'string'
		&& (candidate.formula === undefined || typeof candidate.formula === 'boolean');
}

function isDraftCaptureResultMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'draftCaptureResult' }> {
	if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'draftCaptureResult'
		|| !('requestId' in message) || !Number.isInteger(message.requestId)) {return false;}
	if (!('draft' in message) || message.draft === undefined) {return true;}
	const draft = message.draft;
	return typeof draft === 'object' && draft !== null && 'sheetIndex' in draft && Number.isInteger(draft.sheetIndex)
		&& 'row' in draft && Number.isInteger(draft.row) && 'column' in draft && Number.isInteger(draft.column)
		&& 'value' in draft && typeof draft.value === 'string' && (!('formula' in draft) || typeof draft.formula === 'boolean');
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

function isRequestSnapshotMessage(message: unknown): message is Extract<WebviewToExtensionMessage, { type: 'requestSnapshot' }> {
	return typeof message === 'object' && message !== null && 'type' in message && message.type === 'requestSnapshot'
		&& 'documentId' in message && typeof message.documentId === 'string'
		&& 'revision' in message && Number.isInteger(message.revision);
}

function isMutationMessage(message: unknown): boolean {
	return typeof message === 'object' && message !== null && 'type' in message
		&& typeof message.type === 'string' && isDocumentMutationMessageType(message.type);
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
		{ id: 'save', title: 'Guardar y abrir' }, { id: 'discard', title: 'Descartar y abrir' }, { id: 'cancel', title: 'Cancelar' },
	);
	if (action?.id === 'save') {return textDocument.save();}
	if (action?.id === 'discard') {
		await vscode.commands.executeCommand('workbench.action.files.revert', uri);
		return !textDocument.isDirty;
	}
	return false;
}

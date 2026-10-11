import type { CellVisualStyle, CsvDataMessage, FormulaEvaluation, ReloadStateMessage, RestoreViewStateMessage, SaveStateMessage, WebviewToExtensionMessage, XlsxDataMessage } from '../protocol';
import type { CellEditDeltaMessage, WorkbookCellEditDeltaMessage } from '../protocol';
import { parseCellRangeBounds, resolveCellReference } from '../cell-reference';
import { applyCsvCellEditDelta, applyWorkbookCellEditDelta } from '../cell-delta';
import { findSearchMatches } from '../search';
import { findRowAtOffset, gridTemplateColumns, rebuildRowOffsets, sampleEvenly, wrappedTextHeight, type RowLayout } from './grid-layout';
import { renderSpreadsheetGrid, type GridRendererState } from './grid-renderer';
import { selectGridCell, type CellRange } from './selection';
import { isCellInVisibleRange } from '../range-selection';
import { parseClipboardTsv, serializeVisibleSelection } from '../clipboard';
import { presentXlsxCell, type CellPresentation } from './presentation';
import { completeFormulaFunction, getFormulaCompletions, insertFormulaReference, type FormulaCompletion } from '../formula-assistance';
import { cycleSort, getColumnFilterValues, projectRows, validateColumnFilters, type ColumnFilter, type FilterCondition, type FilterOperator, type SortCriterion } from '../table-view';
import type { SheetViewState, ViewMode } from '../view-state';

window.addEventListener('error', event => {
	const detail = event.target instanceof HTMLScriptElement
		? `No se pudo cargar el script de la tabla: ${event.target.src}`
		: event.message || 'Error inesperado en la interfaz.';
	showStartupError(detail);
}, true);
window.addEventListener('unhandledrejection', event => {
	const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
	showStartupError(reason);
});

function showStartupError(detail: string): void {
	const dimensions = document.querySelector<HTMLElement>('#dimensions');
	const status = document.querySelector<HTMLElement>('#save-status');
	if (dimensions) {dimensions.textContent = 'La interfaz de la tabla encontró un error.';}
	if (status) {
		status.textContent = `Error de la interfaz: ${detail}`;
		status.classList.add('save-error');
	}
	console.error('Spreadsheet Viewer webview error:', detail);
}

interface VsCodeApi {
	postMessage(message: WebviewToExtensionMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;
declare let __webpack_nonce__: string | undefined;

__webpack_nonce__ = document.currentScript instanceof HTMLScriptElement ? document.currentScript.nonce : undefined;

const vscodeApi = acquireVsCodeApi();
const gridScroll = requiredElement<HTMLDivElement>('#grid-scroll');
const gridRoot = requiredElement<HTMLDivElement>('#grid-root');
const dimensions = requiredElement<HTMLParagraphElement>('#dimensions');
const cellReference = requiredElement<HTMLElement>('#cell-reference');
const cellState = requiredElement<HTMLParagraphElement>('#cell-state');
const cellValue = requiredElement<HTMLPreElement>('#cell-value');
const formatNote = requiredElement<HTMLParagraphElement>('#format-note');
const saveStatus = requiredElement<HTMLParagraphElement>('#save-status');
const reloadFileButton = requiredElement<HTMLButtonElement>('#reload-file');
const toggleCommentsButton = requiredElement<HTMLButtonElement>('#toggle-comments');
const clearSortButton = requiredElement<HTMLButtonElement>('#clear-sort');
let showClearSortButton = clearSortButton.dataset.settingEnabled !== 'false';
const copyActions = requiredElement<HTMLDivElement>('#copy-actions');
let showCopyButtons = !copyActions.hidden;
const displayModeButton = requiredElement<HTMLButtonElement>('#toggle-display-mode');
const displayModeTooltip = requiredElement<HTMLSpanElement>('#display-mode-tooltip');
let showDisplayModeButton = !displayModeButton.hidden;
const toggleXlsxStructureButton = requiredElement<HTMLButtonElement>('#toggle-xlsx-structure');
const xlsxStructureActions = requiredElement<HTMLDivElement>('#xlsx-structure-actions');
const xlsxStructureStatus = requiredElement<HTMLParagraphElement>('#xlsx-structure-status');
let showXlsxStructureActions = !toggleXlsxStructureButton.hidden;
let showWorkbookAppearance = gridRoot.dataset.workbookAppearance !== 'false';
const csvRowActions = requiredElement<HTMLDivElement>('#csv-row-actions');
let showCsvRowActions = !csvRowActions.hidden;
const sortWarning = requiredElement<HTMLParagraphElement>('#sort-warning');
const filterChips = requiredElement<HTMLDivElement>('#filter-chips');
const projectionCount = requiredElement<HTMLOutputElement>('#projection-count');
const filterStatus = requiredElement<HTMLOutputElement>('#filter-status');
const filterPopover = requiredElement<HTMLElement>('#filter-popover');
const resetViewButton = requiredElement<HTMLButtonElement>('#reset-view');
const autoFitMode = requiredElement<HTMLSelectElement>('#auto-fit-mode');
const autoFitButton = requiredElement<HTMLButtonElement>('#auto-fit-columns');
const wrapCellsInput = requiredElement<HTMLInputElement>('#wrap-cells');
const freezeRowsInput = requiredElement<HTMLInputElement>('#freeze-rows');
const freezeColumnsInput = requiredElement<HTMLInputElement>('#freeze-columns');
const sheetControl = requiredElement<HTMLDivElement>('#sheet-control');
const sheetSelector = requiredElement<HTMLSelectElement>('#sheet-selector');
const sheetTabs = requiredElement<HTMLDivElement>('#sheet-tabs');
const sheetStateStatus = requiredElement<HTMLOutputElement>('#sheet-state-status');
const cellReferenceInput = requiredElement<HTMLInputElement>('#cell-reference-input');
const goToCellButton = requiredElement<HTMLButtonElement>('#go-to-cell');
const searchInput = requiredElement<HTMLInputElement>('#search-input');
const previousMatchButton = requiredElement<HTMLButtonElement>('#previous-match');
const nextMatchButton = requiredElement<HTMLButtonElement>('#next-match');
const searchStatus = requiredElement<HTMLOutputElement>('#search-status');
const searchAllRowsInput = requiredElement<HTMLInputElement>('#search-all-rows');
const revealHiddenMatchButton = requiredElement<HTMLButtonElement>('#reveal-hidden-match');
const cellEditor = requiredElement<HTMLTextAreaElement>('#cell-editor');
const applyCellEditButton = requiredElement<HTMLButtonElement>('#apply-cell-edit');
const cellEditorGroup = requiredElement<HTMLDivElement>('#cell-editor-group');
const formulaEditMode = requiredElement<HTMLInputElement>('#formula-edit-mode');
const formulaModeControl = requiredElement<HTMLLabelElement>('#formula-mode-control');
const cellEditLabel = requiredElement<HTMLLabelElement>('#cell-edit-label');
const formulaAssistanceControls = requiredElement<HTMLDivElement>('#formula-assistance-controls');
const formulaCompletions = requiredElement<HTMLDivElement>('#formula-completions');
const pickFormulaReferenceButton = requiredElement<HTMLButtonElement>('#pick-formula-reference');
let showFormulaEditing = formulaEditMode.dataset.settingEnabled !== 'false';
let showFormulaAssistance = formulaAssistanceControls.dataset.settingEnabled !== 'false';
let pickingFormulaReference = false;

const defaultRowHeight = 28;
const minimumRowHeight = 20;
const maximumRowHeight = 600;
const headingHeight = 34;
const rowHeaderWidth = 64;
const columnWidth = 160;
const minimumColumnWidth = 48;
const maximumColumnWidth = 800;
const overscan = 6;
let snapshot: CsvDataMessage | XlsxDataMessage | undefined;
let formulaResults: Record<string, FormulaEvaluation> = {};
let formulaCalculationGeneration = 0;
let formulaWorkerPromise: Promise<Worker> | undefined;
let formulaWorkerRequestId = 0;
const pendingFormulaRequests = new Map<number, { resolve: (results: Record<string, FormulaEvaluation>) => void; reject: (error: Error) => void; timer: number }>();
let formulaWorkbookSnapshot: { documentId: string; revision: number; base64: string } | undefined;
let reloadWatchdog: number | undefined;
let startupDataTimer: number | undefined;
let startupDataAttempts = 0;
const columnWidthsBySheet = new Map<number, number[]>();
const rowLayoutsBySheet = new Map<number, RowLayout>();
const manualRowHeightsBySheet = new Map<number, Set<number>>();
let selectedCell: { row: number; column: number } | undefined;
let selectionRange: CellRange | undefined;
let wrapCells = false;
let freezeRows = 0;
let freezeColumns = 0;
let renderScheduled = false;
let rowsViewport: HTMLDivElement | undefined;
let renderedColumnCount = 0;
const gridRendererState: GridRendererState = { rowsViewport: undefined, renderedColumnCount: 0 };
let sheetRequestId = 0;
let pendingSheetRequestId: number | undefined;
let pendingSheetIndex: number | undefined;
let searchGeneration = 0;
let searchResults: number[] = [];
let currentSearchIndex = -1;
let searchInProgress = false;
let editorDirty = false;
let inlineEditorDirty = false;
let inlineEditValue = '';
let editingCell: { row: number; column: number } | undefined;
let sortCriteria: SortCriterion[] = [];
let columnFilters: ColumnFilter[] = [];
let searchAllRows = false;
let popupColumn: number | undefined;
let popupAnchor: HTMLButtonElement | undefined;
let popupSearch = '';
let popupLimit = 200;
let popupConditionCount = 1;
let popupMessage = '';
let pendingHiddenCell: { row: number; column: number } | undefined;
let cachedProjection: ReturnType<typeof projectRows> | undefined;
let cachedProjectionSnapshot: CsvDataMessage | XlsxDataMessage | undefined;
let cachedProjectionCriteria: SortCriterion[] | undefined;
let cachedProjectionComments: boolean | undefined;
let cachedProjectionFilters: ColumnFilter[] | undefined;
let showComments = false;
let viewMode: ViewMode = 'edit';
let cellPresentation: CellPresentation = 'raw';
let pendingViewRestore: RestoreViewStateMessage | undefined;
let persistViewTimer: number | undefined;
let applyingViewRestore = false;
const viewSheets: Record<string, SheetViewState> = {};
let restoreScrollAfterSelection: { top: number; left: number } | undefined;
let viewStateNotice = '';
let wrappedLayoutUpdateScheduled = false;
let autoFitTextBudget = 2_000_000;
let dragRangeAnchor: { row: number; column: number } | undefined;
let suppressNextCellClick = false;

gridScroll.tabIndex = 0;
gridScroll.setAttribute('role', 'grid');
gridScroll.setAttribute('aria-label', 'Tabla de datos. Usa las flechas para moverte entre celdas y escribe para editar la celda seleccionada.');

window.addEventListener('message', (event: MessageEvent<unknown>) => {
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data && event.data.type === 'captureDraft'
		&& 'requestId' in event.data && Number.isInteger(event.data.requestId)) {
		let draft: { sheetIndex: number; row: number; column: number; value: string } | undefined;
		if (snapshot && !snapshot.readonly) {
			const position = inlineEditorDirty ? editingCell : editorDirty ? selectedCell : undefined;
			if (position) {
				draft = { sheetIndex: snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0, ...position,
					value: inlineEditorDirty ? inlineEditValue : cellEditor.value,
					...(formulaEditMode.checked ? { formula: true } : {}) };
			}
		}
		vscodeApi.postMessage({ type: 'draftCaptureResult', requestId: event.data.requestId as number, ...(draft ? { draft } : {}) });
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data && event.data.type === 'restoreCellDraft'
		&& 'draft' in event.data && isRecoveredDraft(event.data.draft)) {
		restoreCellDraft(event.data.draft);
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data && event.data.type === 'discardCellDraft') {
		discardCellDraft();
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data
		&& event.data.type === 'copyButtonVisibility' && 'visible' in event.data && typeof event.data.visible === 'boolean') {
		showCopyButtons = event.data.visible;
		copyActions.hidden = !showCopyButtons;
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data
		&& event.data.type === 'displayModeButtonVisibility' && 'visible' in event.data && typeof event.data.visible === 'boolean') {
		showDisplayModeButton = event.data.visible;
		updateDisplayModeControl();
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data
		&& event.data.type === 'xlsxStructureActionsVisibility' && 'visible' in event.data && typeof event.data.visible === 'boolean') {
		showXlsxStructureActions = event.data.visible;
		updateXlsxStructureActions();
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data
		&& event.data.type === 'workbookAppearanceVisibility' && 'visible' in event.data && typeof event.data.visible === 'boolean') {
		showWorkbookAppearance = event.data.visible;
		renderGrid();
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data
		&& event.data.type === 'csvRowActionsVisibility' && 'visible' in event.data && typeof event.data.visible === 'boolean') {
		showCsvRowActions = event.data.visible;
		updateCsvRowActions();
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data && event.data.type === 'focusCell'
		&& 'row' in event.data && Number.isInteger(event.data.row) && 'column' in event.data && Number.isInteger(event.data.column)) {
		const position = event.data as { row: number; column: number };
		if (snapshot && position.row < snapshot.rowCount && position.column < snapshot.columnCount) {
			selectCell(position.row, position.column);
			gridScroll.focus();
		}
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data
		&& event.data.type === 'resetViewButtonVisibility' && 'visible' in event.data && typeof event.data.visible === 'boolean') {
		resetViewButton.hidden = !event.data.visible;
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data
		&& event.data.type === 'clearSortButtonVisibility' && 'visible' in event.data && typeof event.data.visible === 'boolean') {
		showClearSortButton = event.data.visible;
		clearSortButton.hidden = !showClearSortButton || sortCriteria.length === 0;
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data
		&& event.data.type === 'formulaEditingVisibility' && 'visible' in event.data && typeof event.data.visible === 'boolean') {
		showFormulaEditing = event.data.visible;
		if (!showFormulaEditing && !editorDirty) {formulaEditMode.checked = false;}
		updateFormulaEditorControls();
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data
		&& event.data.type === 'formulaAssistanceVisibility' && 'visible' in event.data && typeof event.data.visible === 'boolean') {
		showFormulaAssistance = event.data.visible;
		if (!showFormulaAssistance) {setFormulaReferencePicking(false);}
		updateFormulaEditorControls();
		return;
	}
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data && event.data.type === 'sortState'
		&& 'criteria' in event.data && Array.isArray(event.data.criteria)) {
		sortCriteria = event.data.criteria as SortCriterion[];
		cachedProjection = undefined;
		gridRendererState.rowsViewport = undefined;
		renderGrid();
		return;
	}
	if (isRestoreViewStateMessage(event.data)) {
		pendingViewRestore = event.data;
		viewMode = event.data.mode;
		if (event.data.corrupted) {viewStateNotice = 'Se ignoró un estado de vista dañado; se abrió la vista predeterminada.';}
		if (event.data.reset && snapshot) {
			pendingViewRestore = undefined;
			resetCurrentView(snapshot);
		}
		return;
	}
	if (isReloadStateMessage(event.data)) {
		updateReloadState(event.data);
		return;
	}
	if (isSaveStateMessage(event.data)) {
		updateSaveStatus(event.data);
		return;
	}
	if (isCellEditDeltaMessage(event.data)) {
		if (!snapshot || snapshot.documentId !== event.data.documentId) {return;}
		if (snapshot.type !== 'csvData') {
			vscodeApi.postMessage({ type: 'requestSnapshot', documentId: snapshot.documentId, revision: snapshot.revision });
			return;
		}
		const result = applyCsvCellEditDelta(snapshot, event.data);
		if (result.status === 'resync') {
			vscodeApi.postMessage({ type: 'requestSnapshot', documentId: snapshot.documentId, revision: snapshot.revision });
			return;
		}
		if (result.status === 'ignore') {return;}
		const changedSelectedCell = selectedCell && event.data.cells.some(cell => cell.row === selectedCell!.row && cell.column === selectedCell!.column);
		snapshot = { ...snapshot, ...result.snapshot };
		cachedProjection = undefined;
		gridRendererState.rowsViewport = undefined;
		scheduleSearch();
		if (changedSelectedCell && !editorDirty && !inlineEditorDirty && selectedCell) {selectCell(selectedCell.row, selectedCell.column);}
		else {renderGrid();}
		return;
	}
	if (isWorkbookCellEditDeltaMessage(event.data)) {
		if (!snapshot || snapshot.documentId !== event.data.documentId) {return;}
		if (snapshot.type !== 'xlsxData') {
			vscodeApi.postMessage({ type: 'requestSnapshot', documentId: snapshot.documentId, revision: snapshot.revision });
			return;
		}
		const result = applyWorkbookCellEditDelta(snapshot, event.data);
		if (result.status === 'resync') {
			vscodeApi.postMessage({ type: 'requestSnapshot', documentId: snapshot.documentId, revision: snapshot.revision });
			return;
		}
		if (result.status === 'ignore') {return;}
		const changedSelectedCell = selectedCell && event.data.sheetIndex === snapshot.activeSheetIndex
			&& event.data.cells.some(cell => cell.row === selectedCell!.row && cell.column === selectedCell!.column);
		snapshot = result.snapshot;
		cachedProjection = undefined;
		gridRendererState.rowsViewport = undefined;
		scheduleSearch();
		if (changedSelectedCell && !editorDirty && !inlineEditorDirty && selectedCell) {selectCell(selectedCell.row, selectedCell.column);}
		else {renderGrid();}
		return;
	}
	if (!isCsvDataMessage(event.data) && !isXlsxDataMessage(event.data)) {
		if (typeof event.data === 'object' && event.data !== null && 'type' in event.data
			&& (event.data.type === 'csvData' || event.data.type === 'xlsxData')) {
			dimensions.textContent = 'No se pudieron recibir los datos del archivo. Puedes volver a intentar con Recargar.';
			saveStatus.textContent = 'Error al cargar los datos del archivo.';
			saveStatus.classList.add('save-error');
		}
		return;
	}
	if (isXlsxDataMessage(event.data)
		&& event.data.requestId !== undefined
		&& event.data.requestId !== pendingSheetRequestId) {
		return;
	}
	if (isXlsxDataMessage(event.data) && event.data.fileFormat !== 'ods') {
		if (event.data.workbookBase64) {
			formulaWorkbookSnapshot = { documentId: event.data.documentId, revision: event.data.revision, base64: event.data.workbookBase64 };
		} else if (formulaWorkbookSnapshot?.documentId === event.data.documentId
			&& formulaWorkbookSnapshot.revision === event.data.revision) {
			event.data.workbookBase64 = formulaWorkbookSnapshot.base64;
		}
	}
	const previousSheetIndex = snapshot?.type === 'xlsxData' ? snapshot.activeSheetIndex : undefined;
	const previousSheetId = snapshot?.sheetId;
	const previousDocumentId = snapshot?.documentId;
	const previousRevision = snapshot?.revision;
	if (snapshot && snapshot.documentId !== event.data.documentId) {
		cellPresentation = 'raw';
		showComments = false;
		toggleCommentsButton.textContent = 'Mostrar comentarios';
		columnFilters = [];
		sortCriteria = [];
		searchAllRows = false;
		searchAllRowsInput.checked = false;
	}
	if (startupDataTimer !== undefined) {
		window.clearTimeout(startupDataTimer);
		startupDataTimer = undefined;
	}
	formulaCalculationGeneration++;
	if (pendingFormulaRequests.size > 0) {stopFormulaWorker(new Error('Se canceló un cálculo de fórmulas reemplazado por una vista más reciente.'));}
	snapshot = event.data;
	updateDisplayModeControl();
	updateCsvRowActions();
	const changedSheet = snapshot.type === 'xlsxData'
		&& (previousSheetIndex !== snapshot.activeSheetIndex || snapshot.requestId !== undefined);
	formulaResults = {};
	const restoredView = restoreViewForSnapshot(snapshot, changedSheet);
	if (!restoredView && (previousDocumentId !== snapshot.documentId || previousSheetId !== snapshot.sheetId)) {applyWorkbookViewDefaults(snapshot);}
	const changedContent = previousRevision !== undefined && previousRevision !== snapshot.revision;
	dimensions.textContent = `${snapshot.rowCount.toLocaleString()} filas · ${snapshot.columnCount.toLocaleString()} columnas`;
	toggleCommentsButton.hidden = snapshot.type !== 'csvData' || snapshot.rowKinds?.includes('comment') !== true;
	formatNote.textContent = snapshot.type === 'xlsxData'
		? snapshot.fileFormat === 'ods'
			? `Hoja: ${snapshot.sheetName}. Los valores se muestran sin formatos visuales de ODS; las fórmulas muestran su expresión y valor almacenado, sin recalcularse.${snapshot.warnings.length ? ` Avisos: ${snapshot.warnings.join(' ')}` : ''}`
		: `Hoja: ${snapshot.sheetName}. La vista cruda conserva los valores almacenados; el modo libro puede aplicar formatos numéricos sin modificar el archivo. Las fórmulas muestran su expresión y los resultados calculados solo como información; no se guardan como valores.${snapshot.warnings.length ? ` Avisos: ${snapshot.warnings.join(' ')}` : ''}`
		: '';
	if (viewStateNotice) {formatNote.textContent = `${formatNote.textContent} ${viewStateNotice}`.trim(); viewStateNotice = '';}
	if (snapshot.readonly) {
		cellEditorGroup.hidden = true;
		cellEditor.disabled = true;
		applyCellEditButton.disabled = true;
		saveStatus.textContent = snapshot.sourceStatus ?? (snapshot.sourceMode === 'buffer' ? 'Vista previa de cambios sin guardar' : 'Vista previa de solo lectura');
		saveStatus.classList.remove('save-error');
		formatNote.textContent = `${formatNote.textContent} Vista previa de solo lectura.${snapshot.sourceStatus ? ` ${snapshot.sourceStatus}` : ''}`.trim();
	} else {
		cellEditorGroup.hidden = false;
	}
	if (snapshot.type === 'xlsxData') {
		sheetControl.hidden = snapshot.sheetNames.length < 2;
		updateSheetOptions(snapshot.sheetNames, snapshot.activeSheetIndex, snapshot.sheetStates);
		if (snapshot.requestId !== undefined) {
			pendingSheetRequestId = undefined;
			pendingSheetIndex = undefined;
		}
	} else {
		sheetControl.hidden = true;
	}
	if (selectedCell && (selectedCell.row >= snapshot.rowCount || selectedCell.column >= snapshot.columnCount)) {
		selectedCell = undefined;
	}
	if (changedSheet && !restoredView) {
		gridScroll.scrollTop = 0;
		gridScroll.scrollLeft = 0;
		selectedCell = undefined;
	}
	if (snapshot.rowCount > 0 && snapshot.columnCount > 0) {
		if ((changedSheet && !restoredView) || !selectedCell) {
			selectCell(0, 0);
		} else if (changedContent || restoredView) {
			selectCell(selectedCell.row, selectedCell.column);
		} else {
			renderGrid();
		}
		gridScroll.focus({ preventScroll: true });
	} else {
		selectedCell = undefined;
		cellReference.textContent = 'Sin selección';
		cellReferenceInput.value = '';
		cellState.textContent = '';
		cellValue.textContent = '';
		cellEditor.value = '';
		cellEditor.disabled = true;
		applyCellEditButton.disabled = true;
		renderGrid();
	}
	if (snapshot.recoveredDraft) {restoreCellDraft(snapshot.recoveredDraft);}
	if (restoredView && restoreScrollAfterSelection) {
		gridScroll.scrollTop = restoreScrollAfterSelection.top;
		gridScroll.scrollLeft = restoreScrollAfterSelection.left;
		restoreScrollAfterSelection = undefined;
		renderGrid();
	}
	reconcileFilteredSelection();
	updateProjectionControls(getRowProjection());
	if (changedSheet || changedContent || restoredView) {
		scheduleSearch();
	}
	if (snapshot.type === 'xlsxData' && snapshot.fileFormat !== 'ods' && snapshot.workbookBase64 && snapshot.cellKinds.some(row => row.includes('formula'))) {
		const calculationSnapshot = snapshot;
		const generation = ++formulaCalculationGeneration;
		void calculateFormulasInWorker(calculationSnapshot, generation).then(results => {
			if (generation !== formulaCalculationGeneration || snapshot !== calculationSnapshot) {return;}
			formulaResults = results;
			if (selectedCell && isFormula(selectedCell.row, selectedCell.column)) {
				selectCell(selectedCell.row, selectedCell.column);
			} else {
				renderGrid();
			}
		}).catch(error => {
			if (generation !== formulaCalculationGeneration || snapshot !== calculationSnapshot) {return;}
			const message = error instanceof Error ? error.message : String(error);
			for (let row = 0; row < calculationSnapshot.cellKinds.length; row++) {
				for (let column = 0; column < calculationSnapshot.cellKinds[row]!.length; column++) {
					if (calculationSnapshot.cellKinds[row]![column] === 'formula') {
						formulaResults[`${columnName(column)}${row + 1}`] = { status: 'error', value: message };
					}
				}
			}
			if (selectedCell && isFormula(selectedCell.row, selectedCell.column)) {
				selectCell(selectedCell.row, selectedCell.column);
			} else {
				renderGrid();
			}
		});
	}
});

interface FormulaWorkerResponse {
	type: 'result' | 'error';
	requestId: number;
	results?: Record<string, FormulaEvaluation>;
	error?: string;
}

function getFormulaWorker(): Promise<Worker> {
	if (formulaWorkerPromise) {return formulaWorkerPromise;}
	formulaWorkerPromise = (async () => {
		const source = document.body.dataset.formulaWorkerSrc;
		if (!source) {throw new Error('No se encontró el worker local de fórmulas.');}
		const response = await fetch(source);
		if (!response.ok) {throw new Error(`No se pudo cargar el worker de fórmulas (${response.status}).`);}
		const code = await response.text();
		const blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
		let worker: Worker;
		try {worker = new Worker(blobUrl);}
		finally {URL.revokeObjectURL(blobUrl);}
		worker.addEventListener('message', event => {
			const result = event.data as FormulaWorkerResponse;
			const pending = pendingFormulaRequests.get(result?.requestId);
			if (!pending) {return;}
			window.clearTimeout(pending.timer);
			pendingFormulaRequests.delete(result.requestId);
			if (result.type === 'result' && result.results) {pending.resolve(result.results);}
			else {pending.reject(new Error(result.error || 'Falló el cálculo de fórmulas.'));}
		});
		worker.addEventListener('error', event => {
			const error = new Error(event.message || 'Falló el worker de fórmulas.');
			stopFormulaWorker(error);
		});
		return worker;
	})().catch(error => {
		formulaWorkerPromise = undefined;
		throw error;
	});
	return formulaWorkerPromise;
}

async function calculateFormulasInWorker(data: XlsxDataMessage, generation: number): Promise<Record<string, FormulaEvaluation>> {
	const worker = await getFormulaWorker();
	if (generation !== formulaCalculationGeneration) {return {};}
	const requestId = ++formulaWorkerRequestId;
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => {
			stopFormulaWorker(new Error('El cálculo de fórmulas excedió el límite de 60 segundos.'));
		}, 60_000);
		pendingFormulaRequests.set(requestId, { resolve, reject, timer });
		const wasmBaseUri = document.body.dataset.formulaWasmBaseUri;
		if (!wasmBaseUri) {
			window.clearTimeout(timer);
			pendingFormulaRequests.delete(requestId);
			reject(new Error('No se encontró el recurso WASM local para fórmulas.'));
			return;
		}
		worker.postMessage({
			type: 'calculate', requestId, workbookBase64: data.workbookBase64!, revision: data.revision,
			sheetName: data.sheetName, kinds: data.cellKinds, rows: data.rows, wasmBaseUri,
		});
	});
}

function stopFormulaWorker(error: Error): void {
	void formulaWorkerPromise?.then(worker => worker.terminate(), () => undefined);
	formulaWorkerPromise = undefined;
	for (const [requestId, pending] of pendingFormulaRequests) {
		window.clearTimeout(pending.timer);
		pending.reject(error);
		pendingFormulaRequests.delete(requestId);
	}
}

reloadFileButton.addEventListener('click', () => {
	reloadFileButton.disabled = true;
	reloadFileButton.textContent = 'Recargando…';
	dimensions.textContent = 'Recargando archivo…';
	if (reloadWatchdog !== undefined) {window.clearTimeout(reloadWatchdog);}
	reloadWatchdog = window.setTimeout(() => {
		reloadWatchdog = undefined;
		reloadFileButton.disabled = false;
		reloadFileButton.textContent = '↻ Recargar';
		dimensions.textContent = snapshot
			? `${snapshot.rowCount.toLocaleString()} filas · ${snapshot.columnCount.toLocaleString()} columnas`
			: 'No se recibió respuesta al cargar. Puedes volver a intentar con Recargar.';
		saveStatus.textContent = 'No se recibió respuesta al recargar.';
		saveStatus.classList.add('save-error');
	}, 30000);
	vscodeApi.postMessage({ type: 'reloadFile' });
});

toggleCommentsButton.addEventListener('click', () => {
	showComments = !showComments;
	selectionRange = undefined;
	toggleCommentsButton.textContent = showComments ? 'Ocultar comentarios' : 'Mostrar comentarios';
	cachedProjection = undefined;
	renderGrid();
	updateProjectionControls();
	schedulePersistViewState();
	if (searchInput.value) {scheduleSearch();}
});
clearSortButton.addEventListener('click', () => {
	if (!snapshot || sortCriteria.length === 0) {return;}
	sortCriteria = [];
	selectionRange = undefined;
	cachedProjection = undefined;
	vscodeApi.postMessage({ type: 'setSort', documentId: snapshot.documentId, sheetId: snapshot.sheetId, criteria: sortCriteria });
	schedulePersistViewState();
	gridRendererState.rowsViewport = undefined;
	renderGrid();
});
resetViewButton.addEventListener('click', () => {if (snapshot) {resetCurrentView(snapshot);}});
autoFitButton.addEventListener('click', autoFitColumns);
wrapCellsInput.addEventListener('change', () => {
	wrapCells = wrapCellsInput.checked;
	if (!wrapCells && snapshot) {
		const sheet = snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0;
		const manual = manualRowHeightsBySheet.get(sheet) ?? new Set<number>();
		const layout = getActiveRowLayout();
		for (let row = 0; row < layout.heights.length; row++) {if (!manual.has(row)) {layout.heights[row] = workbookRowHeight(snapshot, row);}}
		rebuildRowOffsets(layout);
	}
	renderGrid(); schedulePersistViewState();
});
freezeRowsInput.addEventListener('change', () => updateFreezeCount('rows'));
freezeColumnsInput.addEventListener('change', () => updateFreezeCount('columns'));

sheetSelector.addEventListener('change', () => {
	requestSheetSelection(Number(sheetSelector.value));
});

function requestSheetSelection(sheetIndex: number): void {
	if (snapshot?.type !== 'xlsxData') {return;}
	const currentOrPendingIndex = pendingSheetIndex ?? snapshot.activeSheetIndex;
	if (!Number.isInteger(sheetIndex)
		|| sheetIndex < 0
		|| sheetIndex >= snapshot.sheetNames.length
		|| sheetIndex === currentOrPendingIndex) {
		return;
	}
	const requestId = ++sheetRequestId;
	flushViewState(snapshot.sheetIds[sheetIndex]!);
	pendingSheetRequestId = requestId;
	pendingSheetIndex = sheetIndex;
	invalidateSearch();
	updateSearchStatus();
	renderGrid();
	vscodeApi.postMessage({ type: 'selectSheet', documentId: snapshot.documentId, revision: snapshot.revision, sheetIndex, sheetId: snapshot.sheetIds[sheetIndex]!, requestId });
}

goToCellButton.addEventListener('click', goToCell);
cellEditor.addEventListener('input', () => {
	editorDirty = true;
	sendDraftState(true);
	updateFormulaCompletions();
});
formulaEditMode.addEventListener('change', () => {
	if (editorDirty) {formulaEditMode.checked = !formulaEditMode.checked; return;}
	updateFormulaEditorControls();
});
pickFormulaReferenceButton.addEventListener('click', () => {
	if (!showFormulaAssistance || !formulaEditMode.checked || !selectedCell || !canEditFormulaCell(selectedCell.row, selectedCell.column)) {return;}
	setFormulaReferencePicking(!pickingFormulaReference);
});
formulaCompletions.addEventListener('mousedown', event => {event.preventDefault();});
formulaCompletions.addEventListener('click', event => {
	if (!(event.target instanceof Element)) {return;}
	const option = event.target.closest<HTMLButtonElement>('button[data-formula-name]');
	if (!option) {return;}
	const completion = JSON.parse(option.dataset.completion ?? 'null') as FormulaCompletion | null;
	if (!completion) {return;}
	const result = completeFormulaFunction(cellEditor.value, completion);
	cellEditor.value = result.value;
	cellEditor.setSelectionRange(result.cursor, result.cursor);
	editorDirty = true;
	sendDraftState(true);
	updateFormulaCompletions();
	cellEditor.focus();
});
cellEditor.addEventListener('blur', commitSelectedEdit);
cellEditor.addEventListener('keydown', event => {
	if (!editorDirty && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
		event.preventDefault();
		vscodeApi.postMessage({ type: 'history', direction: event.shiftKey ? 'redo' : 'undo' });
	} else if (!editorDirty && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
		event.preventDefault();
		vscodeApi.postMessage({ type: 'history', direction: 'redo' });
	} else if (event.key === 'Escape') {
		event.preventDefault();
		cancelCellEdit();
	} else if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		commitSelectedEdit();
	}
});
applyCellEditButton.addEventListener('pointerdown', event => event.preventDefault());
applyCellEditButton.addEventListener('click', commitSelectedEdit);
cellReferenceInput.addEventListener('keydown', event => {
	if (event.key === 'Enter') {
		event.preventDefault();
		goToCell();
	}
});

searchInput.addEventListener('input', () => {
	pendingHiddenCell = undefined; revealHiddenMatchButton.hidden = true; filterStatus.textContent = '';
	scheduleSearch(); schedulePersistViewState(); updateCsvRowActions();
});
searchAllRowsInput.addEventListener('change', () => {
	searchAllRows = searchAllRowsInput.checked;
	scheduleSearch();
	schedulePersistViewState();
});
revealHiddenMatchButton.addEventListener('click', () => revealPendingCell());
previousMatchButton.addEventListener('click', () => navigateSearch(-1));
nextMatchButton.addEventListener('click', () => navigateSearch(1));

gridScroll.addEventListener('scroll', () => {
	schedulePersistViewState();
	if (renderScheduled) {
		return;
	}
	renderScheduled = true;
	window.requestAnimationFrame(() => {
		renderScheduled = false;
		renderGrid();
	});
});

window.addEventListener('pagehide', () => flushViewState());
window.addEventListener('keydown', event => {
	if (event.key === 'Escape' && !filterPopover.hidden) {closeFilterPopup(true); event.preventDefault();}
	else if (event.key === 'Escape' && pendingHiddenCell) {pendingHiddenCell = undefined; revealHiddenMatchButton.hidden = true; filterStatus.textContent = '';}
});
document.addEventListener('pointerdown', event => {
	if (!filterPopover.hidden && event.target instanceof Node && !filterPopover.contains(event.target)
		&& !(event.target instanceof Element && event.target.closest('.column-filter-button'))) {closeFilterPopup(false);}
});

gridScroll.addEventListener('keydown', event => {
	if (event.target !== gridScroll || !snapshot || !selectedCell) {
		return;
	}
	if (event.isComposing) {return;}
	if (event.key === 'Delete' || event.key === 'Backspace') {
		event.preventDefault();
		clearSelectionContents();
		return;
	}
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && showCopyButtons) {
		event.preventDefault();
		void copySelection('raw');
		return;
	}
	const rows = getRowProjection().visibleRows;
	const currentVisibleRow = getRowProjection().sourceToVisible.get(selectedCell.row) ?? 0;
	let visibleRow = currentVisibleRow;
	let column = selectedCell.column;
	let extend = event.shiftKey;
	const pageStep = Math.max(1, Math.floor(gridScroll.clientHeight / defaultRowHeight) - 1);
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
		event.preventDefault();
		if (rows.length) {
			selectionRange = { anchor: { row: rows[0]!, column: 0 }, focus: { row: rows[rows.length - 1]!, column: snapshot.columnCount - 1 } };
			selectCell(rows[rows.length - 1]!, snapshot.columnCount - 1, true, 'allow');
		}
		return;
	}
	if (event.key === 'F2') {event.preventDefault(); beginInlineEdit(selectedCell.row, selectedCell.column); return;}
	const plainText = !event.ctrlKey && !event.metaKey && !event.altKey && Array.from(event.key).length === 1;
	if (plainText && canEditCell(selectedCell.row, selectedCell.column)) {event.preventDefault(); beginInlineEdit(selectedCell.row, selectedCell.column, event.key); return;}
	switch (event.key) {
		case 'ArrowUp': visibleRow--; break;
		case 'ArrowDown': visibleRow++; break;
		case 'ArrowLeft': column--; break;
		case 'ArrowRight': column++; break;
		case 'Home': if (event.ctrlKey || event.metaKey) {visibleRow = 0;} column = 0; break;
		case 'End': if (event.ctrlKey || event.metaKey) {visibleRow = rows.length - 1;} column = snapshot.columnCount - 1; break;
		case 'PageUp': visibleRow -= pageStep; break;
		case 'PageDown': visibleRow += pageStep; break;
		case 'Enter': visibleRow += event.shiftKey ? -1 : 1; extend = false; break;
		case 'Tab': {
			const delta = event.shiftKey ? -1 : 1;
			const nextFlat = currentVisibleRow * snapshot.columnCount + selectedCell.column + delta;
			if (nextFlat < 0 || nextFlat >= rows.length * snapshot.columnCount) {return;}
			const flat = nextFlat;
			visibleRow = Math.floor(flat / snapshot.columnCount);
			column = flat % snapshot.columnCount;
			extend = false; break;
		}
		default: return;
	}
	if (!rows.length) {return;}
	event.preventDefault();
	visibleRow = Math.max(0, Math.min(rows.length - 1, visibleRow));
	column = Math.max(0, Math.min(snapshot.columnCount - 1, column));
	selectCell(rows[visibleRow]!, column, extend, 'skip');
});

gridScroll.addEventListener('paste', event => {
	if (event.target !== gridScroll || !snapshot || !selectedCell || snapshot.readonly) {return;}
	const text = event.clipboardData?.getData('text/plain');
	if (text === undefined) {return;}
	event.preventDefault();
	try {
		if (sortCriteria.length || columnFilters.length || searchInput.value) {throw new Error('Quita orden, filtros y búsqueda antes de pegar para conservar la correspondencia de filas.');}
		const matrix = parseClipboardTsv(text);
		const startRow = selectionRange ? Math.min(selectionRange.anchor.row, selectionRange.focus.row) : selectedCell.row;
		const startColumn = selectionRange ? Math.min(selectionRange.anchor.column, selectionRange.focus.column) : selectedCell.column;
		const fillRange = matrix.length === 1 && matrix[0]?.length === 1 && selectionRange;
		const height = fillRange ? Math.abs(selectionRange!.focus.row - selectionRange!.anchor.row) + 1 : matrix.length;
		const width = fillRange ? Math.abs(selectionRange!.focus.column - selectionRange!.anchor.column) + 1 : Math.max(...matrix.map(row => row.length));
		if (startRow + height > snapshot.rowCount || startColumn + width > snapshot.columnCount) {throw new Error('El pegado se sale del rango actual de la hoja.');}
		const edits: Array<{ row: number; column: number; value: string }> = [];
		for (let r = 0; r < height; r++) {for (let c = 0; c < width; c++) {
			const value = fillRange ? matrix[0]![0]! : (matrix[r]?.[c] ?? '');
			edits.push({ row: startRow + r, column: startColumn + c, value });
		}}
		vscodeApi.postMessage({ type: 'editCells', documentId: snapshot.documentId, revision: snapshot.revision,
			sheetIndex: snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0,
			sheetId: snapshot.sheetId, edits });
	} catch (error) {
		saveStatus.textContent = error instanceof Error ? error.message : 'No se pudo pegar el contenido.';
		saveStatus.classList.add('save-error');
	}
});

function clearSelectionContents(): void {
	if (!snapshot || !selectedCell || snapshot.readonly) {return;}
	if (sortCriteria.length || columnFilters.length || searchInput.value) {
		saveStatus.textContent = 'Quita orden, filtros y búsqueda antes de borrar contenido.';
		saveStatus.classList.add('save-error');
		return;
	}
	const firstRow = selectionRange ? Math.min(selectionRange.anchor.row, selectionRange.focus.row) : selectedCell.row;
	const lastRow = selectionRange ? Math.max(selectionRange.anchor.row, selectionRange.focus.row) : selectedCell.row;
	const firstColumn = selectionRange ? Math.min(selectionRange.anchor.column, selectionRange.focus.column) : selectedCell.column;
	const lastColumn = selectionRange ? Math.max(selectionRange.anchor.column, selectionRange.focus.column) : selectedCell.column;
	const edits = [];
	for (let row = firstRow; row <= lastRow; row++) {for (let column = firstColumn; column <= lastColumn; column++) {edits.push({ row, column, value: '', targetType: 'string' as const });}}
	vscodeApi.postMessage({ type: 'editCells', documentId: snapshot.documentId, revision: snapshot.revision,
		sheetIndex: snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0, sheetId: snapshot.sheetId, edits });
}

requiredElement<HTMLButtonElement>('#copy-raw').addEventListener('click', () => {void copySelection('raw');});
displayModeButton.addEventListener('click', () => {
	cellPresentation = cellPresentation === 'raw' ? 'book' : 'raw';
	updateDisplayModeControl();
	gridRendererState.rowsViewport = undefined;
	renderGrid();
});
requiredElement<HTMLButtonElement>('#copy-displayed').addEventListener('click', () => {void copySelection('displayed');});
requiredElement<HTMLButtonElement>('#copy-headers').addEventListener('click', () => {void copySelection('headers');});
requiredElement<HTMLButtonElement>('#insert-row').addEventListener('click', () => {
	if (!snapshot || snapshot.type !== 'csvData' || !selectedCell) {return;}
	vscodeApi.postMessage({ type: 'csvRowOperation', kind: 'insert', documentId: snapshot.documentId,
		revision: snapshot.revision, sheetId: snapshot.sheetId, index: selectedCell.row + 1 });
});
requiredElement<HTMLButtonElement>('#append-row').addEventListener('click', () => {
	if (!snapshot || snapshot.type !== 'csvData') {return;}
	vscodeApi.postMessage({ type: 'csvRowOperation', kind: 'append', documentId: snapshot.documentId, revision: snapshot.revision, sheetId: snapshot.sheetId });
});
requiredElement<HTMLButtonElement>('#delete-row').addEventListener('click', () => {
	if (!snapshot || snapshot.type !== 'csvData' || !selectedCell) {return;}
	const first = selectionRange ? Math.min(selectionRange.anchor.row, selectionRange.focus.row) : selectedCell.row;
	const last = selectionRange ? Math.max(selectionRange.anchor.row, selectionRange.focus.row) : selectedCell.row;
	vscodeApi.postMessage({ type: 'csvRowOperation', kind: 'delete', documentId: snapshot.documentId, revision: snapshot.revision,
		sheetId: snapshot.sheetId, rows: Array.from({ length: last - first + 1 }, (_, index) => first + index) });
});
toggleXlsxStructureButton.addEventListener('click', () => {
	xlsxStructureActions.hidden = !xlsxStructureActions.hidden;
	toggleXlsxStructureButton.setAttribute('aria-expanded', String(!xlsxStructureActions.hidden));
	updateXlsxStructureActions();
});
for (const [id, kind, axis, direction] of [
	['insert-xlsx-row-before', 'insertRows', 'row', -1], ['insert-xlsx-row-after', 'insertRows', 'row', 1],
	['delete-xlsx-row', 'deleteRows', 'row', 0], ['insert-xlsx-column-before', 'insertColumns', 'column', -1],
	['insert-xlsx-column-after', 'insertColumns', 'column', 1], ['delete-xlsx-column', 'deleteColumns', 'column', 0],
] as const) {
	requiredElement<HTMLButtonElement>(`#${id}`).addEventListener('click', () => requestXlsxStructure(kind, axis, direction));
}

function requestXlsxStructure(kind: 'insertRows' | 'deleteRows' | 'insertColumns' | 'deleteColumns', axis: 'row' | 'column', direction: -1 | 0 | 1): void {
	if (snapshot?.type !== 'xlsxData' || !selectedCell || sortCriteria.length || columnFilters.length) {return;}
	const start = axis === 'row' ? selectedCell.row : selectedCell.column;
	const end = selectionRange ? Math.max(axis === 'row' ? selectionRange.anchor.row : selectionRange.anchor.column,
		axis === 'row' ? selectionRange.focus.row : selectionRange.focus.column) : start;
	const first = selectionRange ? Math.min(axis === 'row' ? selectionRange.anchor.row : selectionRange.anchor.column,
		axis === 'row' ? selectionRange.focus.row : selectionRange.focus.column) : start;
	const index = direction < 0 ? first : direction > 0 ? end + 1 : first;
	const count = direction === 0 ? end - first + 1 : 1;
	vscodeApi.postMessage({ type: 'xlsxStructureOperation', documentId: snapshot.documentId, revision: snapshot.revision,
		sheetId: snapshot.sheetId, sheetIndex: snapshot.activeSheetIndex, kind, index, count });
}

function updateXlsxStructureActions(): void {
	const visible = showXlsxStructureActions && snapshot?.type === 'xlsxData' && snapshot.fileFormat === 'xlsx';
	toggleXlsxStructureButton.hidden = !visible;
	const blockedByProjection = sortCriteria.length > 0 || columnFilters.length > 0;
	const capability = snapshot?.type === 'xlsxData' ? snapshot.structureCapability : undefined;
	const blocked = blockedByProjection || !capability?.allowed || !selectedCell;
	xlsxStructureStatus.textContent = blockedByProjection ? 'Quita el orden y los filtros antes de cambiar la estructura.'
		: capability?.allowed ? selectedCell ? '' : 'Selecciona una celda en la fila o columna que quieres modificar.'
			: capability?.reason ?? 'El libro no cumple el perfil de seguridad para cambios estructurales.';
	xlsxStructureStatus.hidden = !blocked || !visible;
	for (const button of xlsxStructureActions.querySelectorAll<HTMLButtonElement>('button')) {
		button.disabled = blocked;
		button.title = blocked ? xlsxStructureStatus.textContent : '';
	}
	if (!visible) {xlsxStructureActions.hidden = true; toggleXlsxStructureButton.setAttribute('aria-expanded', 'false');}
}

async function copySelection(mode: 'raw' | 'displayed' | 'headers'): Promise<void> {
	if (!showCopyButtons || !snapshot || !selectedCell) {return;}
	const projection = getRowProjection();
	const start = selectionRange?.anchor ?? selectedCell;
	const end = selectionRange?.focus ?? selectedCell;
	// Display formatting is not implemented yet, so both value modes copy the text shown in the grid.
	// Formula calculations are metadata only; raw copy preserves the formula expression.
	const headers = mode === 'headers' ? Array.from({ length: snapshot.columnCount }, (_, column) => snapshot!.type === 'csvData'
		? snapshot!.headerLabels?.[column] ?? columnName(column) : columnName(column)) : undefined;
	const formatCell = mode === 'displayed' && snapshot.type === 'xlsxData' && cellPresentation === 'book'
		? (row: number, column: number, raw: string) => presentXlsxCell(snapshot as XlsxDataMessage, row, column, raw, 'book') : undefined;
	const text = serializeVisibleSelection(snapshot.rows, projection.visibleRows, { anchor: start, focus: end }, snapshot.columnCount, headers, formatCell);
	if (text === undefined) {return;}
	if (text.length > 50 * 1024 * 1024) {
		saveStatus.textContent = 'La selección supera el límite de 50 MiB y no se copió.';
		saveStatus.classList.add('save-error');
		return;
	}
	try {
		if (text.length > 5 * 1024 * 1024) {vscodeApi.postMessage({ type: 'copyToClipboard', text });}
		else if (navigator.clipboard?.writeText) {await navigator.clipboard.writeText(text);}
		else {vscodeApi.postMessage({ type: 'copyToClipboard', text });}
		saveStatus.textContent = 'Selección copiada';
		saveStatus.classList.remove('save-error');
	} catch {
		vscodeApi.postMessage({ type: 'copyToClipboard', text });
		saveStatus.textContent = 'Selección copiada';
		saveStatus.classList.remove('save-error');
	}
}

let dragPointer: { x: number; y: number } | undefined;
let dragFrame: number | undefined;
gridRoot.addEventListener('pointerdown', event => {
	if (event.button !== 0 || !(event.target instanceof Element)) {return;}
	const cell = event.target.closest<HTMLElement>('.grid-cell[data-source-row][data-column]');
	if (!cell || !snapshot) {return;}
	const row = Number(cell.dataset.sourceRow); const column = Number(cell.dataset.column);
	if (pickingFormulaReference && formulaEditMode.checked && selectedCell
		&& canEditFormulaCell(selectedCell.row, selectedCell.column) && Number.isInteger(row) && Number.isInteger(column)) {
		event.preventDefault(); event.stopPropagation();
		const reference = `${columnName(column)}${row + 1}`;
		const inserted = insertFormulaReference(cellEditor.value, cellEditor.selectionStart, reference);
		cellEditor.value = inserted.value;
		cellEditor.setSelectionRange(inserted.cursor, inserted.cursor);
		editorDirty = true;
		cellState.textContent = `Referencia ${reference} insertada; la fórmula sigue sin confirmar.`;
		setFormulaReferencePicking(false);
		sendDraftState(true);
		updateFormulaCompletions();
		cellEditor.focus();
		return;
	}
	selectCell(row, column, event.shiftKey);
	dragRangeAnchor = selectionRange?.anchor ?? { row, column };
	dragPointer = { x: event.clientX, y: event.clientY };
	suppressNextCellClick = true;
	gridScroll.focus({ preventScroll: true });
	if (dragFrame === undefined) {dragFrame = window.requestAnimationFrame(dragSelectionFrame);}
});
window.addEventListener('pointermove', event => {if (dragRangeAnchor) {dragPointer = { x: event.clientX, y: event.clientY };}});
window.addEventListener('pointerup', () => {
	dragRangeAnchor = undefined; dragPointer = undefined;
	if (dragFrame !== undefined) {window.cancelAnimationFrame(dragFrame); dragFrame = undefined;}
	window.setTimeout(() => {suppressNextCellClick = false;}, 0);
});
function dragSelectionFrame(): void {
	if (!dragRangeAnchor || !dragPointer) {dragFrame = undefined; return;}
	const rect = gridScroll.getBoundingClientRect();
	const edge = 24;
	if (dragPointer.y < rect.top + edge) {gridScroll.scrollTop -= 10;}
	else if (dragPointer.y > rect.bottom - edge) {gridScroll.scrollTop += 10;}
	if (dragPointer.x < rect.left + edge) {gridScroll.scrollLeft -= 10;}
	else if (dragPointer.x > rect.right - edge) {gridScroll.scrollLeft += 10;}
	const target = document.elementFromPoint(dragPointer.x, dragPointer.y)?.closest<HTMLElement>('.grid-cell[data-source-row][data-column]');
	if (target) {
		const row = Number(target.dataset.sourceRow); const column = Number(target.dataset.column);
		if (selectionRange?.focus.row !== row || selectionRange?.focus.column !== column) {selectCell(row, column, true);}
	}
	dragFrame = window.requestAnimationFrame(dragSelectionFrame);
}

gridScroll.addEventListener('wheel', event => {
	if (event.shiftKey && event.deltaY !== 0) {
		gridScroll.scrollLeft += event.deltaY;
		event.preventDefault();
	}
}, { passive: false });

function renderGrid(): void {
	if (editingCell && gridRoot.querySelector('.cell-inline-editor') === document.activeElement) {return;}
	gridRendererState.rowsViewport = rowsViewport;
	gridRendererState.renderedColumnCount = renderedColumnCount;
	renderSpreadsheetGrid({
		snapshot, state: gridRendererState, gridScroll, gridRoot,
		defaultRowHeight, headingHeight, rowHeaderWidth, overscan,
		freezeRows, freezeColumns, wrapCells, showWorkbookAppearance,
		consumeSuppressedCellClick: () => {const value = suppressNextCellClick; suppressNextCellClick = false; return value;},
		autoFitColumn,
		getActiveColumnWidths, gridTemplateColumns: widths => gridTemplateColumns(widths, rowHeaderWidth),
		startColumnResize, resizeColumnWithKeyboard, updateGridColumnSizing, getActiveRowLayout,
		findRowAtOffset, startRowResize, resizeRowWithKeyboard, columnName, isSelected,
		isActiveCell: (row, column) => selectedCell?.row === row && selectedCell.column === column, isFormula,
		getFormulaCache, getFormulaResult, isEditing, isActiveSearchMatch,
		getCellDisplayValue: (row, column, raw) => snapshot?.type === 'xlsxData'
			? presentXlsxCell(snapshot, row, column, raw, cellPresentation) : raw,
		inlineEditValue,
		setInlineEditValue: value => {inlineEditValue = value;},
		sendDraftState, setInlineEditorDirty: value => {inlineEditorDirty = value;},
		commitInlineEdit, cancelInlineEdit, selectCell, beginInlineEdit,
		navigateAfterInlineEdit: (rowDelta, columnDelta) => {
			if (!snapshot || !selectedCell) {return;}
			const projection = getRowProjection();
			const index = projection.sourceToVisible.get(selectedCell.row) ?? 0;
			const total = projection.visibleRows.length * snapshot.columnCount;
			const position = Math.max(0, Math.min(total - 1, (index + rowDelta) * snapshot.columnCount + selectedCell.column + columnDelta));
			selectCell(projection.visibleRows[Math.floor(position / snapshot.columnCount)]!, position % snapshot.columnCount, false, 'skip');
		},
		projection: getRowProjection(),
		openFilter: openColumnFilter,
		isFiltered: column => columnFilters.some(filter => filter.column === column),
		sortHeader: (column, event) => {
		if (event.altKey) {
			const existing = sortCriteria.find(item => item.column === column);
			sortCriteria = existing
				? sortCriteria.map(item => item.column === column ? { ...item, mode: item.mode === 'text' ? 'number' : 'text' } : item)
				: cycleSort(sortCriteria, column, { shift: event.shiftKey }, 'number');
		} else {
			sortCriteria = cycleSort(sortCriteria, column, { shift: event.shiftKey, remove: event.ctrlKey || event.metaKey });
		}
		if (snapshot) {vscodeApi.postMessage({ type: 'setSort', documentId: snapshot.documentId, sheetId: snapshot.sheetId, criteria: sortCriteria });}
		selectionRange = undefined;
		cachedProjection = undefined;
		schedulePersistViewState();
			gridRendererState.rowsViewport = undefined;
			renderGrid();
			if (searchInput.value) {scheduleSearch();}
		},
		sortLabel: column => {
			const index = sortCriteria.findIndex(item => item.column === column);
			return index < 0 ? '' : ` ${sortCriteria[index]!.direction === 'asc' ? '↑' : '↓'}${index + 1}${sortCriteria[index]!.mode === 'number' ? 'N' : 'T'}`;
		},
	});
	rowsViewport = gridRendererState.rowsViewport;
	renderedColumnCount = gridRendererState.renderedColumnCount;
	if (selectedCell && gridRoot.querySelector(`#cell-${selectedCell.row}-${selectedCell.column}`)) {
		gridScroll.setAttribute('aria-activedescendant', `cell-${selectedCell.row}-${selectedCell.column}`);
	} else {gridScroll.removeAttribute('aria-activedescendant');}
	if (wrapCells || (snapshot?.type === 'xlsxData' && snapshot.cellVisualStyles?.some(style => style.wrapText))) {updateWrappedVisibleRowHeights();}
	updateCsvRowActions();
	updateXlsxStructureActions();
}

function updateDisplayModeControl(): void {
	const supported = snapshot?.type === 'xlsxData' && snapshot.fileFormat === 'xlsx';
	displayModeButton.hidden = !showDisplayModeButton || !supported;
	displayModeButton.textContent = cellPresentation === 'raw' ? 'Ver libro' : 'Ver valores crudos';
	displayModeTooltip.textContent = cellPresentation === 'raw'
		? 'Aplica los formatos numéricos de Excel a la cuadrícula sin modificar los valores guardados.'
		: 'Muestra los valores almacenados sin formato; el archivo permanece intacto.';
}
function selectCell(row: number, column: number, extend = false, coveredMode: 'snap' | 'skip' | 'allow' = 'snap'): void {
	if (showWorkbookAppearance && snapshot?.type === 'xlsxData' && coveredMode !== 'allow') {
		let attempts = 0;
		while (attempts++ < 8) {
			const range = (snapshot.mergedRanges ?? []).map(parseCellRangeBounds).find(bounds => bounds
				&& row >= bounds.top && row <= bounds.bottom && column >= bounds.left && column <= bounds.right
				&& (row !== bounds.top || column !== bounds.left));
			if (!range) {break;}
			if (coveredMode === 'snap') {row = range.top; column = range.left; break;}
			const rowDelta = selectedCell ? row - selectedCell.row : 0;
			const columnDelta = selectedCell ? column - selectedCell.column : 0;
			if (Math.abs(rowDelta) >= Math.abs(columnDelta) && rowDelta !== 0) {row = rowDelta > 0 ? range.bottom + 1 : range.top - 1;}
			else {column = columnDelta >= 0 ? range.right + 1 : range.left - 1;}
			row = Math.max(0, Math.min(snapshot.rowCount - 1, row));
			column = Math.max(0, Math.min(snapshot.columnCount - 1, column));
		}
	}
	if (!showComments && snapshot?.type === 'csvData' && snapshot.rowKinds?.[row] === 'comment') {
		showComments = true;
		selectionRange = undefined;
		toggleCommentsButton.textContent = 'Ocultar comentarios';
	}
	if (extend && selectedCell) {selectionRange = { anchor: selectionRange?.anchor ?? { ...selectedCell }, focus: { row, column } };}
	else if (!selectedCell || selectedCell.row !== row || selectedCell.column !== column) {selectionRange = undefined;}
	selectGridCell({
		snapshot, selectedCell, setSelectedCell: position => {selectedCell = position;}, commitSelectedEdit,
		columnName, getFormulaResult, getFormulaCache, cellReference, cellReferenceInput, cellState, cellValue,
		cellEditor, applyCellEditButton, setEditorDirty: value => {editorDirty = value;},
		ensureSelectionVisible, renderGrid,
	}, row, column);
	formulaEditMode.checked = snapshot?.type === 'xlsxData' && snapshot.cellTypes[row]?.[column] === 'formula';
	updateFormulaEditorControls();
	schedulePersistViewState();
}

function updateFormulaEditorControls(): void {
	const enabled = showFormulaEditing && snapshot?.type === 'xlsxData' && snapshot.fileFormat !== 'ods' && snapshot.readonly !== true;
	formulaModeControl.hidden = !enabled;
	formulaEditMode.disabled = !enabled || !selectedCell || !canEditFormulaCell(selectedCell.row, selectedCell.column);
	formulaAssistanceControls.hidden = !showFormulaAssistance || !enabled;
	pickFormulaReferenceButton.disabled = !formulaEditMode.checked || !selectedCell || !canEditFormulaCell(selectedCell.row, selectedCell.column);
	if (!formulaEditMode.checked || !enabled || !showFormulaAssistance) {setFormulaReferencePicking(false);}
	if (!formulaEditMode.checked) {
		cellEditLabel.textContent = 'Editar valor crudo';
		cellEditor.setAttribute('aria-label', 'Editar valor crudo');
		const normallyEditable = Boolean(selectedCell && canEditCell(selectedCell.row, selectedCell.column));
		cellEditor.disabled = !normallyEditable;
		applyCellEditButton.disabled = !normallyEditable || !editorDirty;
		updateFormulaCompletions();
		return;
	}
	const canEditFormula = Boolean(selectedCell && canEditFormulaCell(selectedCell.row, selectedCell.column));
	cellEditLabel.textContent = 'Editar fórmula';
	cellEditor.setAttribute('aria-label', 'Editar fórmula XLSX');
	cellEditor.disabled = !canEditFormula;
	applyCellEditButton.disabled = !canEditFormula || !editorDirty;
	updateFormulaCompletions();
}

function updateFormulaCompletions(): void {
	formulaCompletions.replaceChildren();
	if (!showFormulaAssistance || !formulaEditMode.checked || !editorDirty) {formulaCompletions.hidden = true; return;}
	const completions = getFormulaCompletions(cellEditor.value, cellEditor.selectionStart);
	if (completions.length === 0) {formulaCompletions.hidden = true; return;}
	for (const completion of completions.slice(0, 8)) {
		const button = document.createElement('button');
		button.type = 'button';
		button.setAttribute('role', 'option');
		button.dataset.formulaName = completion.name;
		button.dataset.completion = JSON.stringify(completion);
		button.textContent = `${completion.signature} — ${completion.description}`;
		formulaCompletions.append(button);
	}
	formulaCompletions.hidden = false;
}

function setFormulaReferencePicking(active: boolean): void {
	pickingFormulaReference = active;
	pickFormulaReferenceButton.setAttribute('aria-pressed', String(active));
	pickFormulaReferenceButton.textContent = active ? 'Selecciona una celda…' : 'Insertar referencia seleccionada';
	if (active) {gridScroll.setAttribute('data-picking-formula-reference', 'true');}
	else {gridScroll.removeAttribute('data-picking-formula-reference');}
}

function updateCsvRowActions(): void {
	const visible = showCsvRowActions && snapshot?.type === 'csvData' && !snapshot.readonly;
	csvRowActions.hidden = !visible;
	const projected = sortCriteria.length > 0 || columnFilters.length > 0 || searchInput.value.length > 0;
	const enabled = visible && !projected;
	requiredElement<HTMLButtonElement>('#insert-row').disabled = !enabled || !selectedCell;
	requiredElement<HTMLButtonElement>('#append-row').disabled = !enabled;
	requiredElement<HTMLButtonElement>('#delete-row').disabled = !enabled || !selectedCell;
}

function commitSelectedEdit(): void {
	if (!editorDirty || !snapshot || !selectedCell) {return;}
	if (formulaEditMode.checked) {
		if (!canEditFormulaCell(selectedCell.row, selectedCell.column)) {return;}
		sendFormulaEdit(selectedCell, cellEditor.value);
	} else {
		if (!canEditCell(selectedCell.row, selectedCell.column)) {return;}
		sendCellEdit(selectedCell, cellEditor.value);
	}
	editorDirty = false;
	saveStatus.textContent = 'Cambios pendientes…';
}

function beginInlineEdit(row: number, column: number, initialText?: string): void {
	if (!snapshot || !canEditCell(row, column)) {return;}
	selectCell(row, column);
	editingCell = { row, column };
	inlineEditValue = initialText ?? snapshot.rows[row]?.[column] ?? '';
	inlineEditorDirty = initialText !== undefined;
	if (initialText !== undefined) {sendDraftState(true, initialText, { row, column });}
	renderGrid();
	const inlineEditor = gridRoot.querySelector<HTMLTextAreaElement>('.cell-inline-editor');
	inlineEditor?.focus({ preventScroll: true });
	inlineEditor?.setSelectionRange(inlineEditor.value.length, inlineEditor.value.length);
}

function commitInlineEdit(): void {
	if (!editingCell) {return;}
	const position = editingCell;
	editingCell = undefined;
	if (inlineEditorDirty && canEditCell(position.row, position.column)) {
		sendCellEdit(position, inlineEditValue);
		saveStatus.textContent = 'Cambios pendientes…';
	}
	inlineEditorDirty = false;
	renderGrid();
}

function cancelInlineEdit(): void {
	if (!editingCell) {return;}
	sendDraftState(false, inlineEditValue);
	editingCell = undefined;
	inlineEditorDirty = false;
	renderGrid();
	gridScroll.focus({ preventScroll: true });
}

function sendCellEdit(position: { row: number; column: number }, value: string): void {
	if (!snapshot || snapshot.readonly) {return;}
	const sheetIndex = snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0;
	sendDraftState(false, value, position);
	vscodeApi.postMessage({ type: 'editCell', documentId: snapshot.documentId, revision: snapshot.revision,
		sheetIndex, sheetId: snapshot.sheetId, ...position, value });
}

function sendFormulaEdit(position: { row: number; column: number }, formula: string): void {
	if (!snapshot || snapshot.type !== 'xlsxData' || snapshot.fileFormat === 'ods' || snapshot.readonly) {return;}
	sendDraftState(false, formula, position);
	vscodeApi.postMessage({ type: 'editFormula', documentId: snapshot.documentId, revision: snapshot.revision,
		sheetIndex: snapshot.activeSheetIndex, sheetId: snapshot.sheetId, ...position, formula });
}

function cancelCellEdit(): void {
	if (!snapshot || !selectedCell) {return;}
	sendDraftState(false);
	cellEditor.value = snapshot.rows[selectedCell.row]?.[selectedCell.column] ?? '';
	editorDirty = false;
}

function sendDraftState(
	dirty: boolean,
	value = cellEditor.value,
	position = selectedCell,
): void {
	if (!snapshot || snapshot.readonly || !position) {return;}
	vscodeApi.postMessage({
		type: 'draftState', dirty,
		documentId: snapshot.documentId, revision: snapshot.revision,
		sheetIndex: snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0,
		sheetId: snapshot.sheetId,
		...position,
		value,
		...(formulaEditMode.checked ? { formula: true } : {}),
	});
}

function isRecoveredDraft(value: unknown): value is { sheetIndex: number; row: number; column: number; value: string; formula?: boolean } {
	return typeof value === 'object' && value !== null && 'sheetIndex' in value && Number.isInteger(value.sheetIndex)
		&& 'row' in value && Number.isInteger(value.row) && 'column' in value && Number.isInteger(value.column)
		&& 'value' in value && typeof value.value === 'string' && (!('formula' in value) || typeof value.formula === 'boolean');
}

function restoreCellDraft(draft: { sheetIndex: number; row: number; column: number; value: string; formula?: boolean }): void {
	if (!snapshot || snapshot.readonly || draft.sheetIndex !== (snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0)
		|| draft.row >= snapshot.rowCount || draft.column >= snapshot.columnCount
		|| (draft.formula ? !canEditFormulaCell(draft.row, draft.column) : !canEditCell(draft.row, draft.column))) {return;}
	selectCell(draft.row, draft.column);
	if (draft.formula) {formulaEditMode.checked = true; updateFormulaEditorControls();}
	cellEditor.value = draft.value;
	editorDirty = true;
	applyCellEditButton.disabled = false;
	cellState.textContent = 'Borrador recuperado; presiona Aplicar para confirmar o Esc para descartarlo.';
	sendDraftState(true, draft.value, { row: draft.row, column: draft.column });
}

function discardCellDraft(): void {
	if (!snapshot || !selectedCell) {return;}
	editorDirty = false;
	cellEditor.value = snapshot.rows[selectedCell.row]?.[selectedCell.column] ?? '';
	applyCellEditButton.disabled = true;
	selectCell(selectedCell.row, selectedCell.column);
}

function isEditing(row: number, column: number): boolean {
	return editingCell?.row === row && editingCell.column === column;
}

function updateSaveStatus(message: SaveStateMessage): void {
	if ((message.state === 'saved' || message.state === 'clean') && snapshot?.type === 'xlsxData'
		&& snapshot.structureCapability?.reason === 'Guarda o deshaz los cambios pendientes antes de cambiar la estructura.') {
		snapshot = { ...snapshot, structureCapability: { allowed: true } };
		updateXlsxStructureActions();
	}
	saveStatus.textContent = message.state === 'clean' ? 'Sin cambios'
		: message.state === 'pending' ? 'Cambios pendientes…'
			: message.state === 'saving' ? 'Guardando…'
				: message.state === 'saved' ? 'Guardado'
				: `Error: ${message.message ?? 'Error desconocido'}`;
	saveStatus.classList.toggle('save-error', message.state === 'error');
}

function goToCell(): void {
	if (!snapshot) {
		vscodeApi.postMessage({ type: 'invalidCell' });
		return;
	}
	const position = resolveCellReference(cellReferenceInput.value, snapshot.rowCount, snapshot.columnCount);
	if (!position) {
		vscodeApi.postMessage({ type: 'invalidCell' });
		return;
	}
	if (!getRowProjection().sourceToVisible.has(position.row)) {
		pendingHiddenCell = position;
		revealHiddenMatchButton.hidden = false;
		revealHiddenMatchButton.textContent = 'Mostrar celda';
		filterStatus.textContent = `La celda ${cellReferenceInput.value.toUpperCase()} está oculta. Puedes mostrarla quitando los filtros.`;
		return;
	}
	selectCell(position.row, position.column);
	gridScroll.focus({ preventScroll: true });
}

function updateSheetOptions(names: string[], activeIndex: number, states: Array<'visible' | 'hidden' | 'veryHidden'> = []): void {
	sheetSelector.replaceChildren();
	sheetTabs.replaceChildren();
	for (let index = 0; index < names.length; index++) {
		const state = states[index] ?? 'visible';
		const option = document.createElement('option');
		option.value = String(index);
		option.textContent = `${names[index]}${state === 'veryHidden' ? ' (muy oculta)' : state === 'hidden' ? ' (oculta)' : ''}`;
		sheetSelector.append(option);
		const tab = document.createElement('button');
		tab.type = 'button';
		tab.className = 'sheet-tab';
		tab.setAttribute('role', 'tab');
		tab.setAttribute('aria-selected', String(index === activeIndex));
		tab.dataset.state = state;
		tab.tabIndex = index === activeIndex ? 0 : -1;
		tab.textContent = option.textContent;
		tab.title = state === 'veryHidden' ? `${names[index]}: hoja marcada como muy oculta en el libro.`
			: state === 'hidden' ? `${names[index]}: hoja marcada como oculta en el libro.` : `Abrir hoja ${names[index]}`;
		tab.addEventListener('click', () => requestSheetSelection(index));
		tab.addEventListener('keydown', event => {
			if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {return;}
			event.preventDefault();
			const tabs = Array.from(sheetTabs.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
				: (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
			tabs[next]?.focus();
			tabs[next]?.click();
		});
		sheetTabs.append(tab);
	}
	sheetSelector.value = String(activeIndex);
	const state = states[activeIndex] ?? 'visible';
	sheetStateStatus.textContent = state === 'veryHidden' ? 'Hoja muy oculta en el libro.' : state === 'hidden' ? 'Hoja oculta en el libro.' : '';
	sheetTabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function scheduleSearch(): void {
	invalidateSearch();
	const sheet = snapshot;
	const query = searchInput.value;
	if (!sheet || query.length === 0 || pendingSheetIndex !== undefined) {
		updateSearchStatus();
		renderGrid();
		return;
	}

	searchInProgress = true;
	updateSearchStatus();
	renderGrid();
	const generation = searchGeneration;
	const visibleRows = searchAllRows ? undefined : getRowProjection().visibleRows;
	void findSearchMatches(
		sheet.rows,
		sheet.columnCount,
		query,
		() => generation !== searchGeneration || snapshot !== sheet,
		visibleRows,
	).then(results => {
		if (results === undefined || generation !== searchGeneration || snapshot !== sheet) {
			return;
		}
		searchInProgress = false;
		searchResults = results;
		currentSearchIndex = results.length > 0 ? 0 : -1;
		updateSearchStatus();
		if (results.length > 0) {
			const firstMatch = results[0];
			navigateToMatch(firstMatch);
		} else {
			renderGrid();
		}
	});
}

function invalidateSearch(): void {
	searchGeneration++;
	searchResults = [];
	currentSearchIndex = -1;
	searchInProgress = false;
}

function navigateSearch(direction: -1 | 1): void {
	if (searchResults.length === 0 || !snapshot) {
		return;
	}
	if (currentSearchIndex < 0) {
		currentSearchIndex = direction > 0 ? 0 : searchResults.length - 1;
	} else {
		currentSearchIndex = (currentSearchIndex + direction + searchResults.length) % searchResults.length;
	}
	updateSearchStatus();
	const match = searchResults[currentSearchIndex];
	navigateToMatch(match);
}

function navigateToMatch(match: number): void {
	if (!snapshot) {return;}
	const row = Math.floor(match / snapshot.columnCount), column = match % snapshot.columnCount;
	if (!getRowProjection().sourceToVisible.has(row)) {
		pendingHiddenCell = { row, column };
		revealHiddenMatchButton.hidden = false;
		revealHiddenMatchButton.textContent = 'Mostrar coincidencia';
		filterStatus.textContent = `La coincidencia ${columnName(column)}${row + 1} está oculta por filtros o comentarios. Puedes mostrarla quitando los filtros.`;
		return;
	}
	pendingHiddenCell = undefined;
	revealHiddenMatchButton.hidden = true;
	filterStatus.textContent = '';
	selectCell(row, column);
}

function updateSearchStatus(): void {
	const disabled = pendingSheetIndex !== undefined
		|| searchInProgress
		|| searchInput.value.length === 0
		|| searchResults.length === 0;
	previousMatchButton.disabled = disabled;
	nextMatchButton.disabled = disabled;
	if (pendingSheetIndex !== undefined) {
		searchStatus.textContent = 'Cambiando de hoja…';
	} else if (searchInput.value.length === 0) {
		searchStatus.textContent = 'Escribe para buscar';
	} else if (searchInProgress) {
		searchStatus.textContent = 'Buscando…';
	} else if (searchResults.length === 0) {
		searchStatus.textContent = '0 coincidencias';
	} else {
		searchStatus.textContent = `${currentSearchIndex + 1} de ${searchResults.length} coincidencias`;
	}
}

function isActiveSearchMatch(row: number, column: number): boolean {
	return snapshot !== undefined
		&& currentSearchIndex >= 0
		&& searchResults[currentSearchIndex] === row * snapshot.columnCount + column;
}

function ensureSelectionVisible(row: number, column: number): void {
	const rowLayout = getActiveRowLayout();
	const projection = getRowProjection();
	const visibleRow = projection.sourceToVisible.get(row) ?? row;
	const visibleOffsets = [0];
	for (const sourceRow of projection.visibleRows) {visibleOffsets.push(visibleOffsets[visibleOffsets.length - 1]! + (rowLayout.heights[sourceRow] ?? defaultRowHeight));}
	const cellTop = headingHeight + (visibleOffsets[visibleRow] ?? 0);
	const cellBottom = headingHeight + (visibleOffsets[visibleRow + 1] ?? ((visibleOffsets[visibleRow] ?? 0) + defaultRowHeight));
	const frozenHeight = projection.visibleRows.slice(0, freezeRows).reduce((sum, sourceRow) => sum + (rowLayout.heights[sourceRow] ?? defaultRowHeight), 0);
	const visibleTop = gridScroll.scrollTop + headingHeight + frozenHeight;
	const visibleBottom = gridScroll.scrollTop + gridScroll.clientHeight;
	if (visibleRow >= freezeRows && cellTop < visibleTop) {
		gridScroll.scrollTop = cellTop - headingHeight - frozenHeight;
	} else if (visibleRow >= freezeRows && cellBottom > visibleBottom) {
		gridScroll.scrollTop = cellBottom - gridScroll.clientHeight;
	}
	const widths = getActiveColumnWidths();
	const cellLeft = rowHeaderWidth + widths.slice(0, column).reduce((total, width) => total + width, 0);
	const selectedColumnWidth = widths[column] ?? columnWidth;
	const frozenWidth = widths.slice(0, freezeColumns).reduce((total, width) => total + width, 0);
	const visibleLeft = gridScroll.scrollLeft + rowHeaderWidth + frozenWidth;
	const visibleRight = gridScroll.scrollLeft + gridScroll.clientWidth;
	if (column >= freezeColumns && cellLeft < visibleLeft) {
		gridScroll.scrollLeft = cellLeft - rowHeaderWidth - frozenWidth;
	} else if (column >= freezeColumns && cellLeft + selectedColumnWidth > visibleRight) {
		gridScroll.scrollLeft = cellLeft + selectedColumnWidth - gridScroll.clientWidth;
	}
}

function getRowProjection() {
	if (cachedProjection && cachedProjectionSnapshot === snapshot && cachedProjectionCriteria === sortCriteria && cachedProjectionComments === showComments && cachedProjectionFilters === columnFilters) {
		return cachedProjection;
	}
	const hidden = new Set<number>();
	const rowKinds = snapshot?.type === 'csvData' ? snapshot.rowKinds : undefined;
	for (let row = 0; !showComments && row < (rowKinds?.length ?? 0); row++) {
		if (rowKinds?.[row] === 'comment') {hidden.add(row);}
	}
	const fixed = new Set<number>();
	if (snapshot?.type === 'csvData' && snapshot.headerLabels) {
		const headerRow = rowKinds?.findIndex(kind => kind === 'data') ?? -1;
		if (headerRow >= 0) {fixed.add(headerRow);}
	}
	cachedProjection = projectRows(snapshot?.rows ?? [], sortCriteria, hidden, fixed, columnFilters);
	cachedProjectionSnapshot = snapshot;
	cachedProjectionCriteria = sortCriteria;
	cachedProjectionComments = showComments;
	cachedProjectionFilters = columnFilters;
	clearSortButton.hidden = !showClearSortButton || sortCriteria.length === 0;
	const warnings = cachedProjection.incompatibleColumns.length
		? [`Orden numérico: valores no numéricos se colocan al final en las columnas ${cachedProjection.incompatibleColumns.map(columnName).join(', ')}.`] : [];
	if (snapshot?.type === 'xlsxData' && snapshot.mergedRanges?.length
		&& (cachedProjection.visibleRows.length !== snapshot.rowCount || cachedProjection.visibleRows.some((sourceRow, index) => sourceRow !== index))) {
		warnings.push('Vista tabular temporal: las combinaciones se ocultan mientras el orden o los filtros cambian el orden o la posición de las filas.');
	}
	sortWarning.textContent = warnings.join(' ');
	return cachedProjection;
}

function getProjectionFixedRows(): { hidden: Set<number>; fixed: Set<number> } {
	const hidden = new Set<number>(), fixed = new Set<number>();
	const rowKinds = snapshot?.type === 'csvData' ? snapshot.rowKinds : undefined;
	for (let row = 0; !showComments && row < (rowKinds?.length ?? 0); row++) {if (rowKinds?.[row] === 'comment') {hidden.add(row);}}
	if (snapshot?.type === 'csvData' && snapshot.headerLabels) {
		const headerRow = rowKinds?.findIndex(kind => kind === 'data') ?? -1;
		if (headerRow >= 0) {fixed.add(headerRow);}
	}
	return { hidden, fixed };
}

function updateProjectionControls(projection = getRowProjection()): void {
	filterChips.replaceChildren();
	for (const filter of columnFilters) {
		const chip = document.createElement('span');
		chip.className = 'filter-chip';
		const description = document.createElement('span');
		description.textContent = `${columnLabel(filter.column)}: ${describeFilter(filter)}`;
		chip.append(description);
		const remove = document.createElement('button');
		remove.type = 'button'; remove.textContent = '×';
		remove.setAttribute('aria-label', `Quitar filtro de ${columnLabel(filter.column)}`);
		remove.addEventListener('click', () => applyColumnFilter(filter.column, undefined));
		chip.append(remove); filterChips.append(chip);
	}
	const contexts = getProjectionFixedRows();
	const headerCount = contexts.fixed.size;
	const total = snapshot?.rowCount ?? 0;
	projectionCount.textContent = `${Math.max(0, projection.visibleRows.length - headerCount)} / ${Math.max(0, total - headerCount - contexts.hidden.size)} filas visibles`;
}

function describeFilter(filter: ColumnFilter): string {
	if (filter.kind === 'values') {return `${filter.values.length} valor${filter.values.length === 1 ? '' : 'es'}`;}
	return filter.conditions.map(condition => `${operatorLabel(condition.operator)}${condition.value ? ` ${condition.value}` : ''}`).join(filter.join === 'and' ? ' Y ' : ' O ');
}

function columnLabel(column: number): string {
	const label = snapshot?.type === 'csvData' ? snapshot.headerLabels?.[column] : undefined;
	return label ? `${columnName(column)} · ${label}` : columnName(column);
}

function applyColumnFilter(column: number, candidate: ColumnFilter | undefined): void {
	if (!snapshot) {return;}
	commitSelectedEdit();
	commitInlineEdit();
	const proposed = columnFilters.filter(filter => filter.column !== column);
	if (candidate) {proposed.push(candidate);}
	const validated = validateColumnFilters(proposed, snapshot.columnCount);
	if (!validated) {filterStatus.textContent = 'El filtro excede los límites o contiene una condición no válida.'; if (popupColumn !== undefined) {popupMessage = filterStatus.textContent; renderFilterPopup();} return;}
	columnFilters = validated;
	selectionRange = undefined;
	cachedProjection = undefined;
	invalidateSearch();
	pendingHiddenCell = undefined;
	revealHiddenMatchButton.hidden = true;
	filterStatus.textContent = '';
	gridRendererState.rowsViewport = undefined;
	const projection = getRowProjection();
	reconcileFilteredSelection(projection);
	renderGrid();
	updateProjectionControls(projection);
	schedulePersistViewState();
	if (searchInput.value) {scheduleSearch();}
	gridRoot.querySelectorAll<HTMLButtonElement>('.column-filter-button')[column]?.focus();
}

function reconcileFilteredSelection(projection = getRowProjection()): void {
	if (!snapshot || !selectedCell || projection.sourceToVisible.has(selectedCell.row)) {return;}
	const firstVisible = projection.visibleRows.find(row => row < snapshot!.rowCount);
	if (firstVisible === undefined || snapshot.columnCount === 0) {
		selectedCell = undefined;
		cellReference.textContent = 'Sin filas visibles'; cellState.textContent = 'Ninguna fila coincide con los filtros.';
		cellValue.textContent = ''; cellEditor.value = '';
		filterStatus.textContent = 'La selección quedó oculta; no hay filas que coincidan con los filtros.';
	} else {
		selectCell(firstVisible, Math.min(selectedCell.column, snapshot.columnCount - 1));
		filterStatus.textContent = 'La fila seleccionada dejó de coincidir; la selección pasó a la primera fila visible.';
	}
}

function openColumnFilter(column: number, button: HTMLButtonElement): void {
	if (!snapshot) {return;}
	if (popupColumn !== undefined) {closeFilterPopup(false);}
	popupColumn = column; popupAnchor = button; popupSearch = ''; popupLimit = 200; popupMessage = '';
	const current = columnFilters.find(filter => filter.column === column);
	if (current?.kind === 'values') {
		popupMode = 'values'; popupSelectedValues = new Set(current.values);
		popupConditions = [];
	} else if (current?.kind === 'conditions') {
		popupMode = 'conditions'; popupConditions = current.conditions.map(item => ({ ...item }));
		popupJoin = current.join; popupSelectedValues = new Set();
	} else {
		popupMode = 'values'; popupSelectedValues = new Set(); popupConditions = [{ operator: 'contains', mode: 'text', value: '' }]; popupJoin = 'and';
	}
	popupConditionCount = Math.max(1, popupConditions.length);
	filterPopover.hidden = false; button.setAttribute('aria-expanded', 'true');
	renderFilterPopup();
	const rect = button.getBoundingClientRect();
	filterPopover.style.left = `${Math.max(8, Math.min(window.innerWidth - 356, rect.left))}px`;
	filterPopover.style.top = `${Math.max(8, Math.min(window.innerHeight - 520, rect.bottom + 4))}px`;
	filterPopover.querySelector<HTMLSelectElement>('#filter-mode')?.focus();
}

let popupMode: 'values' | 'conditions' = 'values';
let popupJoin: 'and' | 'or' = 'and';
let popupSelectedValues = new Set<string | null>();
let popupConditions: FilterCondition[] = [];
let popupAvailableValues: ReturnType<typeof getColumnFilterValues> = [];

function closeFilterPopup(returnFocus: boolean): void {
	filterPopover.hidden = true;
	filterPopover.replaceChildren();
	if (popupAnchor) {popupAnchor.setAttribute('aria-expanded', 'false'); if (returnFocus) {popupAnchor.focus();}}
	popupAnchor = undefined; popupColumn = undefined;
}

function renderFilterPopup(): void {
	if (popupColumn === undefined || !snapshot) {return;}
	filterPopover.replaceChildren();
	const heading = document.createElement('h2'); heading.textContent = `Filtrar ${columnLabel(popupColumn)}`; filterPopover.append(heading);
	const modeLabel = document.createElement('label'); modeLabel.textContent = 'Tipo de filtro';
	const mode = document.createElement('select'); mode.id = 'filter-mode';
	mode.add(new Option('Seleccionar valores', 'values')); mode.add(new Option('Usar condiciones', 'conditions'));
	mode.value = popupMode; mode.addEventListener('change', () => {
		if (popupMode === 'conditions') {popupConditions = readConditionDraft(); popupJoin = filterPopover.querySelector<HTMLSelectElement>('#filter-condition-join')?.value as typeof popupJoin ?? popupJoin;}
		popupMode = mode.value as typeof popupMode; popupMessage = ''; renderFilterPopup();
	});
	modeLabel.append(mode); filterPopover.append(modeLabel);
	const content = document.createElement('div'); content.className = 'filter-popup-content'; filterPopover.append(content);
	if (popupMode === 'values') {renderValuesFilter(content);} else {renderConditionsFilter(content);}
	const message = document.createElement('p'); message.className = 'filter-popup-message'; message.setAttribute('role', 'status'); message.textContent = popupMessage; filterPopover.append(message);
	const actions = document.createElement('div'); actions.className = 'filter-popup-actions';
	const apply = makeButton('Aplicar', () => {
		const candidate = readPopupCandidate();
		if (candidate === null) {popupMessage = 'Revisa el filtro y sus límites antes de aplicarlo.'; renderFilterPopup(); return;}
		const proposed = columnFilters.filter(filter => filter.column !== popupColumn);
		if (candidate) {proposed.push(candidate);}
		if (!validateColumnFilters(proposed, snapshot!.columnCount)) {popupMessage = 'El filtro supera el límite de valores o contiene una condición no válida.'; renderFilterPopup(); return;}
		const column = popupColumn!; closeFilterPopup(false); applyColumnFilter(column, candidate);
	});
	const cancel = makeButton('Cancelar', () => closeFilterPopup(true));
	const clear = makeButton('Limpiar', () => {const column = popupColumn!; closeFilterPopup(true); applyColumnFilter(column, undefined);});
	actions.append(apply, cancel, clear); filterPopover.append(actions);
}

function renderValuesFilter(container: HTMLElement): void {
	const { hidden, fixed } = getProjectionFixedRows();
	popupAvailableValues = getColumnFilterValues(snapshot?.rows ?? [], popupColumn!, columnFilters, hidden, fixed);
	const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Buscar entre todos los valores'; search.value = popupSearch;
	search.setAttribute('aria-label', 'Buscar valores de filtro'); container.append(search);
	const controls = document.createElement('div'); controls.className = 'filter-popup-actions';
	controls.append(makeButton('Todos', () => {
		if (popupAvailableValues.length > 10_000) {popupMessage = 'Hay más de 10 000 valores; busca y selecciona un subconjunto.'; renderFilterPopup(); return;}
		popupSelectedValues = new Set(popupAvailableValues.map(item => item.value)); popupMessage = ''; updateValueOptions();
	}), makeButton('Ninguno', () => {popupSelectedValues.clear(); updateValueOptions();}));
	container.append(controls);
	const list = document.createElement('div'); list.id = 'filter-value-list'; list.className = 'filter-value-list'; list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Valores disponibles'); container.append(list);
	const listStatus = document.createElement('p'); listStatus.id = 'filter-value-status'; listStatus.className = 'filter-popup-message'; container.append(listStatus);
	const more = makeButton('Mostrar 200 más', () => {popupLimit += 200; updateValueOptions();});
	more.id = 'filter-value-more'; container.append(more);
	search.addEventListener('input', () => {popupSearch = search.value; popupLimit = 200; updateValueOptions();});
	updateValueOptions();
}

function updateValueOptions(): void {
	const list = filterPopover.querySelector<HTMLElement>('#filter-value-list');
	const status = filterPopover.querySelector<HTMLElement>('#filter-value-status');
	const more = filterPopover.querySelector<HTMLButtonElement>('#filter-value-more');
	if (!list || !status || !more) {return;}
	const query = popupSearch.toLocaleLowerCase();
	const matching = popupAvailableValues.filter(item => filterValueLabel(item.value).toLocaleLowerCase().includes(query));
	const shown = matching.slice(0, popupLimit); list.replaceChildren();
	for (const item of shown) {
		const label = document.createElement('label'); label.className = 'filter-value-option';
		const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
		checkbox.checked = popupSelectedValues.has(item.value);
		checkbox.addEventListener('change', () => {if (checkbox.checked) {popupSelectedValues.add(item.value);} else {popupSelectedValues.delete(item.value);}});
		const text = document.createElement('span'); text.textContent = `${filterValueLabel(item.value)} (${item.count})`;
		label.append(checkbox, text); list.append(label);
	}
	status.textContent = `${popupSelectedValues.size} valores seleccionados; ${matching.length.toLocaleString()} coincidencias disponibles.`;
	more.hidden = shown.length >= matching.length;
}

function renderConditionsFilter(container: HTMLElement): void {
	const joinLabel = document.createElement('label'); joinLabel.textContent = 'Combinar condiciones';
	const join = document.createElement('select'); join.id = 'filter-condition-join';
	join.add(new Option('Y (AND)', 'and')); join.add(new Option('O (OR)', 'or')); join.value = popupJoin;
	join.addEventListener('change', () => {popupJoin = join.value as typeof popupJoin;});
	joinLabel.append(join); container.append(joinLabel);
	const rows = document.createElement('div'); rows.id = 'filter-condition-rows'; container.append(rows);
	for (let index = 0; index < popupConditionCount; index++) {rows.append(createConditionRow(index, popupConditions[index]));}
	if (popupConditionCount < 2) {container.append(makeButton('Añadir segunda condición', () => {popupConditions = readConditionDraft(); popupConditionCount = 2; renderFilterPopup();}));}
	else {container.append(makeButton('Quitar segunda condición', () => {popupConditions = readConditionDraft().slice(0, 1); popupConditionCount = 1; renderFilterPopup();}));}
}

function createConditionRow(index: number, saved?: FilterCondition): HTMLElement {
	const row = document.createElement('div'); row.className = 'filter-condition-row'; row.dataset.index = String(index);
	const mode = document.createElement('select'); mode.className = 'condition-mode'; mode.setAttribute('aria-label', `Tipo de comparación ${index + 1}`);
	mode.add(new Option('Texto', 'text')); mode.add(new Option('Número', 'number')); mode.value = saved?.mode ?? 'text';
	const operator = document.createElement('select'); operator.className = 'condition-operator'; operator.setAttribute('aria-label', `Operador ${index + 1}`);
	const term = document.createElement('input'); term.className = 'condition-value'; term.type = 'text'; term.placeholder = 'Valor'; term.value = saved?.value ?? ''; term.setAttribute('aria-label', `Valor de condición ${index + 1}`);
	const fillOperators = () => {
		const previous = saved?.operator ?? operator.value;
		operator.replaceChildren();
		for (const [value, label] of operatorsFor(mode.value as 'text' | 'number')) {operator.add(new Option(label, value));}
		if ([...operator.options].some(option => option.value === previous)) {operator.value = previous;}
		term.hidden = ['empty', 'notEmpty'].includes(operator.value);
	};
	mode.addEventListener('change', () => {saved = undefined; fillOperators();});
	operator.addEventListener('change', () => {term.hidden = ['empty', 'notEmpty'].includes(operator.value);});
	fillOperators();
	if (!saved && index === 0) {operator.value = 'contains';}
	term.hidden = ['empty', 'notEmpty'].includes(operator.value);
	row.append(mode, operator, term); return row;
}

function readConditionDraft(): FilterCondition[] {
	return [...filterPopover.querySelectorAll<HTMLElement>('.filter-condition-row')].map(row => ({
		mode: row.querySelector<HTMLSelectElement>('.condition-mode')!.value as 'text' | 'number',
		operator: row.querySelector<HTMLSelectElement>('.condition-operator')!.value as FilterOperator,
		value: row.querySelector<HTMLInputElement>('.condition-value')!.value,
	}));
}

function readPopupCandidate(): ColumnFilter | undefined | null {
	if (popupColumn === undefined) {return null;}
	if (popupMode === 'values') {
		if (popupSelectedValues.size === popupAvailableValues.length && popupAvailableValues.every(value => popupSelectedValues.has(value.value))) {return undefined;}
		return { column: popupColumn, kind: 'values', values: [...popupSelectedValues] };
	}
	const conditions = readConditionDraft();
	return { column: popupColumn, kind: 'conditions', join: filterPopover.querySelector<HTMLSelectElement>('#filter-condition-join')?.value as 'and' | 'or' ?? 'and', conditions };
}

function filterValueLabel(value: string | null): string {return value === null ? '(sin campo)' : value === '' ? '(vacío)' : value;}

function operatorsFor(mode: 'text' | 'number'): Array<[FilterOperator, string]> {
	return mode === 'number'
		? [['equals', 'es igual a'], ['notEquals', 'es distinto de'], ['gt', 'es mayor que'], ['gte', 'es mayor o igual que'], ['lt', 'es menor que'], ['lte', 'es menor o igual que'], ['empty', 'está vacío'], ['notEmpty', 'no está vacío']]
		: [['equals', 'es igual a'], ['notEquals', 'es distinto de'], ['contains', 'contiene'], ['notContains', 'no contiene'], ['startsWith', 'comienza con'], ['endsWith', 'termina con'], ['empty', 'está vacío'], ['notEmpty', 'no está vacío']];
}

function operatorLabel(operator: FilterOperator): string {
	return [...operatorsFor('text'), ...operatorsFor('number')].find(item => item[0] === operator)?.[1] ?? operator;
}

function makeButton(label: string, action: () => void): HTMLButtonElement {
	const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', action); return button;
}

function revealPendingCell(): void {
	if (!pendingHiddenCell || !snapshot) {return;}
	const target = pendingHiddenCell;
	pendingHiddenCell = undefined; revealHiddenMatchButton.hidden = true;
	columnFilters = []; showComments = true; toggleCommentsButton.textContent = 'Ocultar comentarios';
	cachedProjection = undefined; gridRendererState.rowsViewport = undefined;
	filterStatus.textContent = 'Se quitaron los filtros para mostrar la celda.';
	updateProjectionControls(); renderGrid(); selectCell(target.row, target.column); gridScroll.focus({ preventScroll: true }); schedulePersistViewState();
	if (searchInput.value) {scheduleSearch();}
}

function restoreViewForSnapshot(current: CsvDataMessage | XlsxDataMessage, changedSheet: boolean): boolean {
	const message = pendingViewRestore;
	pendingViewRestore = undefined;
	if (!message || message.mode !== viewMode) {return false;}
	if (!message.state) {if (changedSheet) {resetSheetView(current);} return false;}
	const saved = message.state;
	if (saved.schema !== viewSchema(current)) {
		viewStateNotice = 'Cambió el formato del archivo; se abrió la vista predeterminada.';
		resetSheetView(current);
		return true;
	}
	Object.assign(viewSheets, saved.sheets);
	const sheetState = saved.sheets[current.sheetId];
	if (!sheetState) {resetSheetView(current); return true;}
	applyingViewRestore = true;
	const columnCount = current.columnCount;
	const rowCount = current.rowCount;
	const sheetIndex = current.type === 'xlsxData' ? current.activeSheetIndex : 0;
	const columnWidths = Array.from({ length: columnCount }, (_, column) => Number(sheetState.columnWidths[String(column)]) || workbookColumnWidth(current, column));
	columnWidthsBySheet.set(sheetIndex, columnWidths);
	const rowLayout = { heights: Array.from({ length: rowCount }, (_, row) => Number(sheetState.rowHeights[String(row)]) || workbookRowHeight(current, row)), offsets: [] as number[] };
	const manualHeights = new Set(Object.keys(sheetState.rowHeights).map(Number));
	const selection = sheetState.selection && rowCount && columnCount
		? { row: Math.min(sheetState.selection.row, rowCount - 1), column: Math.min(sheetState.selection.column, columnCount - 1) }
		: undefined;
	const columnSchemaChanged = sheetState.schema !== sheetSchema(current);
	sortCriteria = columnSchemaChanged ? sheetState.sort.filter(item => item.column < columnCount) : [...sheetState.sort];
	columnFilters = validateColumnFilters((sheetState.filters ?? []).filter(item => item.column < columnCount), columnCount) ?? [];
	searchAllRows = sheetState.searchAllRows;
	searchAllRowsInput.checked = searchAllRows;
	if (columnSchemaChanged) {
		for (const key of Object.keys(sheetState.columnWidths)) {if (Number(key) >= columnCount) {delete sheetState.columnWidths[key];}}
	}
	searchInput.value = sheetState.query;
	showComments = sheetState.showComments;
	selectionRange = sheetState.selectionRange;
	wrapCells = sheetState.wrapCells;
	freezeRows = Math.min(sheetState.freezeRows, rowCount, 50);
	freezeColumns = Math.min(sheetState.freezeColumns, columnCount);
	wrapCellsInput.checked = wrapCells;
	freezeRowsInput.value = String(freezeRows);
	freezeColumnsInput.value = String(freezeColumns);
	toggleCommentsButton.textContent = showComments ? 'Ocultar comentarios' : 'Mostrar comentarios';
	rowLayoutsBySheet.set(sheetIndex, rowLayout);
	manualRowHeightsBySheet.set(sheetIndex, manualHeights);
	rebuildRowOffsets(rowLayout);
	selectedCell = selection;
	restoreScrollAfterSelection = sheetState.scroll;
	applyingViewRestore = false;
	return true;
}

function resetCurrentView(current: CsvDataMessage | XlsxDataMessage): void {
	applyingViewRestore = true;
	const keepDraftCell = editorDirty || inlineEditorDirty || editingCell !== undefined;
	const draftSelection = selectedCell;
	for (const key of Object.keys(viewSheets)) {delete viewSheets[key];}
	sortCriteria = [];
	columnFilters = [];
	searchInput.value = '';
	searchAllRows = false;
	searchAllRowsInput.checked = false;
	showComments = false;
	wrapCells = false; wrapCellsInput.checked = false;
	freezeRows = 0; freezeColumns = 0; freezeRowsInput.value = '0'; freezeColumnsInput.value = '0';
	selectionRange = undefined;
	cachedProjection = undefined;
	filterStatus.textContent = '';
	resetSheetView(current);
	gridScroll.scrollTop = 0;
	gridScroll.scrollLeft = 0;
	invalidateSearch();
	applyingViewRestore = false;
	if (keepDraftCell && draftSelection) {selectedCell = draftSelection; renderGrid();}
	else if (current.rowCount && current.columnCount) {selectedCell = undefined; selectCell(0, 0);}
	else {renderGrid();}
	updateProjectionControls();
	if (persistViewTimer !== undefined) {window.clearTimeout(persistViewTimer); persistViewTimer = undefined;}
	void vscodeApi.postMessage({ type: 'resetView', mode: viewMode });
}

function resetSheetView(current: CsvDataMessage | XlsxDataMessage): void {
	const sheetIndex = current.type === 'xlsxData' ? current.activeSheetIndex : 0;
	columnWidthsBySheet.delete(sheetIndex);
	rowLayoutsBySheet.delete(sheetIndex);
	selectedCell = undefined;
	sortCriteria = [];
	columnFilters = [];
	searchInput.value = '';
	searchAllRows = false;
	searchAllRowsInput.checked = false;
	showComments = false;
	wrapCells = false; wrapCellsInput.checked = false;
	freezeRows = 0; freezeColumns = 0; freezeRowsInput.value = '0'; freezeColumnsInput.value = '0';
	selectionRange = undefined;
	cachedProjection = undefined;
	gridRendererState.rowsViewport = undefined;
	manualRowHeightsBySheet.delete(sheetIndex);
	applyWorkbookViewDefaults(current);
	toggleCommentsButton.textContent = 'Mostrar comentarios';
	gridScroll.scrollTop = 0;
	gridScroll.scrollLeft = 0;
}

function schedulePersistViewState(): void {
	if (applyingViewRestore || !snapshot) {return;}
	if (persistViewTimer !== undefined) {window.clearTimeout(persistViewTimer);}
	persistViewTimer = window.setTimeout(() => {persistViewTimer = undefined; flushViewState();}, 250);
}

function flushViewState(activeSheetOverride?: string): void {
	if (persistViewTimer !== undefined) {window.clearTimeout(persistViewTimer); persistViewTimer = undefined;}
	if (applyingViewRestore || !snapshot) {return;}
	const sheetId = snapshot.sheetId;
	const sheetIndex = snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0;
	const widths = getActiveColumnWidths();
	const layout = getActiveRowLayout();
	const columnWidthOverrides: Record<string, number> = {};
	widths.forEach((width, index) => {if (width !== workbookColumnWidth(snapshot!, index)) {columnWidthOverrides[String(index)] = width;}});
	const rowHeightOverrides: Record<string, number> = {};
	const manualHeights = manualRowHeightsBySheet.get(sheetIndex) ?? new Set<number>();
	layout.heights.forEach((height, index) => {if (manualHeights.has(index)) {rowHeightOverrides[String(index)] = height;}});
	viewSheets[sheetId] = {
		schema: sheetSchema(snapshot), query: searchInput.value.slice(0, 2048),
		searchAllRows,
		...(selectedCell ? { selection: { ...selectedCell } } : {}),
		...(selectionRange ? { selectionRange: structuredClone(selectionRange) } : {}),
		scroll: { top: Math.max(0, gridScroll.scrollTop), left: Math.max(0, gridScroll.scrollLeft) },
		sort: [...sortCriteria], filters: columnFilters, columnWidths: columnWidthOverrides, rowHeights: rowHeightOverrides, showComments,
		wrapCells, freezeRows, freezeColumns,
	};
	const sheets = Object.fromEntries(Object.entries(viewSheets).slice(-256));
	void vscodeApi.postMessage({ type: 'persistViewState', mode: viewMode, state: {
		schema: viewSchema(snapshot), activeSheetId: activeSheetOverride ?? sheetId, sheets,
	} });
}

function viewSchema(current: CsvDataMessage | XlsxDataMessage): string {
	return current.type === 'csvData' ? `csv-v1:${current.formatSchema ?? 'unknown'}` : `${current.fileFormat ?? 'xlsx'}-v1`;
}

function sheetSchema(current: CsvDataMessage | XlsxDataMessage): string {return `columns:${current.columnCount}`;}

function workbookColumnWidth(current: CsvDataMessage | XlsxDataMessage, column: number): number {
	if (current.type !== 'xlsxData') {return columnWidth;}
	const dimension = current.columnDimensions?.find(item => column >= item.min && column <= item.max);
	if (!dimension) {return columnWidth;}
	if (dimension.hidden) {return 1;}
	if (dimension.width === undefined || !Number.isFinite(dimension.width) || dimension.width <= 0) {return columnWidth;}
	return Math.max(minimumColumnWidth, Math.min(maximumColumnWidth, Math.round(dimension.width * 7 + 5)));
}

function workbookRowHeight(current: CsvDataMessage | XlsxDataMessage, row: number): number {
	if (current.type !== 'xlsxData') {return defaultRowHeight;}
	const dimension = current.rowDimensions?.find(item => item.row === row);
	if (!dimension) {return defaultRowHeight;}
	if (dimension.hidden) {return 1;}
	if (dimension.height === undefined || !Number.isFinite(dimension.height) || dimension.height <= 0) {return defaultRowHeight;}
	return Math.max(minimumRowHeight, Math.min(maximumRowHeight, Math.round(dimension.height * 96 / 72)));
}

function applyWorkbookViewDefaults(current: CsvDataMessage | XlsxDataMessage): void {
	const pane = current.type === 'xlsxData' ? current.frozenPane : undefined;
	freezeRows = Math.min(current.rowCount, Math.max(0, Math.min(50, pane?.ySplit ?? 0)));
	freezeColumns = Math.min(current.columnCount, Math.max(0, Math.min(256, pane?.xSplit ?? 0)));
	freezeRowsInput.value = String(freezeRows);
	freezeColumnsInput.value = String(freezeColumns);
}

function getActiveColumnWidths(): number[] {
	if (!snapshot) {return [];}
	const sheetIndex = snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0;
	let widths = columnWidthsBySheet.get(sheetIndex);
	if (!widths) {
		widths = [];
		columnWidthsBySheet.set(sheetIndex, widths);
	}
	widths.length = snapshot.columnCount;
	for (let column = 0; column < snapshot.columnCount; column++) {
		if (!Number.isFinite(widths[column])) {widths[column] = workbookColumnWidth(snapshot, column);}
	}
	return widths;
}

function updateGridColumnSizing(): void {
	if (!snapshot || !rowsViewport) {return;}
	const widths = getActiveColumnWidths();
	const template = gridTemplateColumns(widths, rowHeaderWidth);
	const totalWidth = rowHeaderWidth + widths.reduce((total, width) => total + width, 0);
	const headerRow = gridRoot.querySelector<HTMLDivElement>('.grid-header');
	if (headerRow) {headerRow.style.gridTemplateColumns = template;}
	gridRoot.querySelectorAll<HTMLElement>('.column-header.frozen-column, .grid-cell.frozen-column').forEach(element => {
		const column = Number(element.dataset.column ?? element.closest('.column-header')?.getAttribute('data-column-index'));
		if (Number.isInteger(column)) {element.style.left = `${rowHeaderWidth + widths.slice(0, column).reduce((total, width) => total + width, 0)}px`;}
	});
	for (const row of rowsViewport.children) {
		(row as HTMLDivElement).style.gridTemplateColumns = template;
	}
	rowsViewport.style.width = `${totalWidth}px`;
}

function autoFitColumns(): void {
	if (!snapshot || autoFitMode.value === 'none') {filterStatus.textContent = 'Elige primera columna o todas para autoajustar.'; return;}
	const widths = getActiveColumnWidths();
	const columns = autoFitMode.value === 'first' ? 1 : snapshot.columnCount;
	autoFitTextBudget = 2_000_000;
	for (let column = 0; column < columns; column++) {widths[column] = measureColumnWidth(column);}
	filterStatus.textContent = getRowProjection().visibleRows.length > 200
		? 'Anchos medidos con una muestra distribuida de hasta 200 filas.' : 'Columnas autoajustadas.';
	updateGridColumnSizing();
	gridRendererState.renderedColumnCount = 0;
	renderGrid();
	schedulePersistViewState();
}

function autoFitColumn(column: number): void {
	if (!snapshot || column < 0 || column >= snapshot.columnCount) {return;}
	const widths = getActiveColumnWidths();
	autoFitTextBudget = 2_000_000;
	widths[column] = measureColumnWidth(column);
	filterStatus.textContent = `Columna ${columnName(column)} autoajustada con una muestra distribuida de hasta 200 filas.`;
	updateGridColumnSizing();
	gridRendererState.renderedColumnCount = 0;
	renderGrid();
	schedulePersistViewState();
}

function measureColumnWidth(column: number): number {
	if (!snapshot) {return columnWidth;}
	const ctx = document.createElement('canvas').getContext('2d');
	if (!ctx) {return columnWidth;}
	ctx.font = getComputedStyle(gridRoot).font;
	const rows = sampleEvenly(getRowProjection().visibleRows, 200);
	let maxWidth = ctx.measureText(columnName(column)).width;
	const header = snapshot.type === 'csvData' ? snapshot.headerLabels?.[column] : undefined;
	if (header) {maxWidth = Math.max(maxWidth, ctx.measureText(header).width);}
	for (const row of rows) {
		if (maxWidth >= maximumColumnWidth - 28 || autoFitTextBudget <= 0) {break;}
		const raw = snapshot.rows[row]?.[column] ?? '';
		const shown = snapshot.type === 'xlsxData' && cellPresentation === 'book' ? presentXlsxCell(snapshot, row, column, raw, 'book') : raw;
		const text = shown.slice(0, Math.min(4_096, autoFitTextBudget));
		autoFitTextBudget -= text.length;
		for (const line of text.split(/\r\n|\r|\n/)) {maxWidth = Math.max(maxWidth, ctx.measureText(line).width);}
	}
	return Math.max(minimumColumnWidth, Math.min(maximumColumnWidth, Math.ceil(maxWidth + 28)));
}

function updateFreezeCount(kind: 'rows' | 'columns'): void {
	const input = kind === 'rows' ? freezeRowsInput : freezeColumnsInput;
	const maximum = kind === 'rows' ? 50 : 256;
	const value = Number(input.value);
	const normalized = Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
	input.value = String(normalized);
	if (kind === 'rows') {freezeRows = normalized;} else {freezeColumns = normalized;}
	gridRendererState.renderedColumnCount = 0;
	renderGrid();
	schedulePersistViewState();
}

function updateWrappedVisibleRowHeights(): void {
	if (!snapshot || !rowsViewport) {return;}
	const sheet = snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0;
	const layout = getActiveRowLayout();
	let manual = manualRowHeightsBySheet.get(sheet);
	if (!manual) {manual = new Set<number>(); manualRowHeightsBySheet.set(sheet, manual);}
	const widths = getActiveColumnWidths();
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	if (!ctx) {return;}
	const style = getComputedStyle(gridRoot);
	ctx.font = style.font;
	const lineHeight = Number.parseFloat(style.lineHeight) || 18;
	let changed = false;
	const projection = getRowProjection();
	const visualStyles = snapshot.type === 'xlsxData' ? snapshot.cellVisualStyles : undefined;
	for (const element of rowsViewport.querySelectorAll<HTMLDivElement>(':scope > .grid-row')) {
		const sourceRow = Number(element.dataset.sourceRow);
		const visibleIndex = Number(element.dataset.visibleIndex);
		if (!Number.isInteger(sourceRow) || manual.has(sourceRow)) {continue;}
		const baseHeight = workbookRowHeight(snapshot, sourceRow);
		if (baseHeight <= 1) {if (layout.heights[sourceRow] !== baseHeight) {layout.heights[sourceRow] = baseHeight; changed = true;} element.style.height = `${baseHeight}px`; continue;}
		const rowStyleWrap = snapshot.type === 'xlsxData' && snapshot.cellStyleIndexes?.[sourceRow]?.some(styleIndex =>
			visualStyles?.[styleIndex ?? 0]?.wrapText === true) === true;
		if (!wrapCells && !rowStyleWrap) {
			if (layout.heights[sourceRow] !== baseHeight) {layout.heights[sourceRow] = baseHeight; changed = true;}
			element.style.height = `${baseHeight}px`;
			continue;
		}
		const rowValues = snapshot.rows[sourceRow] ?? [];
		const displayedValues = snapshot.type === 'xlsxData' && cellPresentation === 'book'
			? rowValues.map((value, column) => presentXlsxCell(snapshot as XlsxDataMessage, sourceRow, column, value, 'book')) : rowValues;
		const height = wrappedTextHeight(displayedValues, widths, value => ctx.measureText(value).width,
			lineHeight, wrapCells ? defaultRowHeight : baseHeight, maximumRowHeight);
		if (layout.heights[sourceRow] !== height) {layout.heights[sourceRow] = height; changed = true;}
		element.style.height = `${height}px`;
	}
	if (!changed) {return;}
	rebuildRowOffsets(layout);
	const offsets = [0];
	for (const sourceRow of projection.visibleRows) {offsets.push(offsets[offsets.length - 1]! + (layout.heights[sourceRow] ?? defaultRowHeight));}
	rowsViewport.style.height = `${offsets[projection.visibleRows.length] ?? 0}px`;
	for (const element of rowsViewport.querySelectorAll<HTMLDivElement>(':scope > .grid-row')) {
		const visibleIndex = Number(element.dataset.visibleIndex);
		element.style.top = `${offsets[visibleIndex] ?? 0}px`;
	}
	if (!wrappedLayoutUpdateScheduled) {
		wrappedLayoutUpdateScheduled = true;
		window.requestAnimationFrame(() => {wrappedLayoutUpdateScheduled = false; renderGrid();});
	}
}

function startColumnResize(event: PointerEvent, column: number, handle: HTMLSpanElement): void {
	if (event.button !== 0) {return;}
	event.preventDefault();
	event.stopPropagation();
	const widths = getActiveColumnWidths();
	const startX = event.clientX;
	const startWidth = widths[column] ?? columnWidth;
	handle.setPointerCapture(event.pointerId);
	const onMove = (moveEvent: PointerEvent): void => {
		if (moveEvent.pointerId !== event.pointerId) {return;}
		widths[column] = Math.max(minimumColumnWidth, Math.min(maximumColumnWidth, startWidth + moveEvent.clientX - startX));
		updateGridColumnSizing();
	};
	const finish = (finishEvent: PointerEvent): void => {
		if (finishEvent.pointerId !== event.pointerId) {return;}
		handle.removeEventListener('pointermove', onMove);
		handle.removeEventListener('pointerup', finish);
		handle.removeEventListener('pointercancel', finish);
		renderGrid();
		schedulePersistViewState();
	};
	handle.addEventListener('pointermove', onMove);
	handle.addEventListener('pointerup', finish);
	handle.addEventListener('pointercancel', finish);
}

function resizeColumnWithKeyboard(event: KeyboardEvent, column: number): void {
	if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {return;}
	event.preventDefault();
	event.stopPropagation();
	const widths = getActiveColumnWidths();
	const amount = event.shiftKey ? 32 : 8;
	const direction = event.key === 'ArrowRight' ? 1 : -1;
	widths[column] = Math.max(minimumColumnWidth, Math.min(maximumColumnWidth, (widths[column] ?? columnWidth) + direction * amount));
	updateGridColumnSizing();
	renderGrid();
	schedulePersistViewState();
}

function getActiveRowLayout(): { heights: number[]; offsets: number[] } {
	if (!snapshot) {return { heights: [], offsets: [0] };}
	const sheetIndex = snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0;
	let layout = rowLayoutsBySheet.get(sheetIndex);
	if (!layout) {
		layout = { heights: [], offsets: [] };
		rowLayoutsBySheet.set(sheetIndex, layout);
	}
	if (layout.heights.length !== snapshot.rowCount) {
		layout.heights.length = snapshot.rowCount;
		for (let row = 0; row < snapshot.rowCount; row++) {
			if (!Number.isFinite(layout.heights[row])) {layout.heights[row] = workbookRowHeight(snapshot, row);}
		}
		rebuildRowOffsets(layout);
	}
	return layout;
}

function startRowResize(event: PointerEvent, row: number, handle: HTMLSpanElement): void {
	if (event.button !== 0) {return;}
	event.preventDefault();
	event.stopPropagation();
	const layout = getActiveRowLayout();
	const startY = event.clientY;
	const startHeight = layout.heights[row] ?? defaultRowHeight;
	const sheet = snapshot?.type === 'xlsxData' ? snapshot.activeSheetIndex : 0;
	const manual = manualRowHeightsBySheet.get(sheet) ?? new Set<number>();
	manual.add(row); manualRowHeightsBySheet.set(sheet, manual);
	handle.setPointerCapture(event.pointerId);
	const onMove = (moveEvent: PointerEvent): void => {
		if (moveEvent.pointerId !== event.pointerId) {return;}
		layout.heights[row] = Math.max(minimumRowHeight, Math.min(maximumRowHeight, startHeight + moveEvent.clientY - startY));
		rebuildRowOffsets(layout);
		updateGridRowSizing(layout);
	};
	const finish = (finishEvent: PointerEvent): void => {
		if (finishEvent.pointerId !== event.pointerId) {return;}
		handle.removeEventListener('pointermove', onMove);
		handle.removeEventListener('pointerup', finish);
		handle.removeEventListener('pointercancel', finish);
			renderGrid();
		schedulePersistViewState();
	};
	handle.addEventListener('pointermove', onMove);
	handle.addEventListener('pointerup', finish);
	handle.addEventListener('pointercancel', finish);
}

function updateGridRowSizing(layout: { heights: number[]; offsets: number[] }): void {
	if (!snapshot || !rowsViewport) {return;}
	const projection = getRowProjection();
	const offsets = [0];
	for (const sourceRow of projection.visibleRows) {offsets.push(offsets[offsets.length - 1]! + (layout.heights[sourceRow] ?? defaultRowHeight));}
	rowsViewport.style.height = `${offsets[projection.visibleRows.length] ?? 0}px`;
	for (const element of rowsViewport.children) {
		const row = element as HTMLDivElement;
		const sourceRow = Number(row.dataset.sourceRow);
		const visibleIndex = Number(row.dataset.visibleIndex);
		row.style.top = `${offsets[visibleIndex] ?? 0}px`;
		row.style.height = `${layout.heights[sourceRow] ?? defaultRowHeight}px`;
	}
}

function resizeRowWithKeyboard(event: KeyboardEvent, row: number): void {
	if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {return;}
	event.preventDefault();
	event.stopPropagation();
	const layout = getActiveRowLayout();
	const sheet = snapshot?.type === 'xlsxData' ? snapshot.activeSheetIndex : 0;
	const manual = manualRowHeightsBySheet.get(sheet) ?? new Set<number>();
	manual.add(row); manualRowHeightsBySheet.set(sheet, manual);
	const amount = event.shiftKey ? 32 : 8;
	const direction = event.key === 'ArrowDown' ? 1 : -1;
	layout.heights[row] = Math.max(minimumRowHeight, Math.min(maximumRowHeight, (layout.heights[row] ?? defaultRowHeight) + direction * amount));
	rebuildRowOffsets(layout);
	updateGridRowSizing(layout);
	renderGrid();
	schedulePersistViewState();
}

function isSelected(row: number, column: number): boolean {
	return selectedCell?.row === row && selectedCell.column === column
		|| isCellInVisibleRange({ row, column }, selectionRange, getRowProjection().sourceToVisible);
}

function columnName(index: number): string {
	let name = '';
	for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
		name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
	}
	return name;
}

function isCsvDataMessage(value: unknown): value is CsvDataMessage {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.type !== 'csvData'
		|| typeof candidate.documentId !== 'string' || typeof candidate.sheetId !== 'string'
		|| (candidate.readonly !== undefined && typeof candidate.readonly !== 'boolean')
		|| (candidate.sourceMode !== undefined && !['disk', 'buffer', 'csv-text'].includes(String(candidate.sourceMode)))
		|| (candidate.sourceStatus !== undefined && typeof candidate.sourceStatus !== 'string')
		|| !Number.isInteger(candidate.revision)
		|| typeof candidate.fileName !== 'string'
		|| !Array.isArray(candidate.rows)
		|| !Number.isInteger(candidate.rowCount)
		|| candidate.rowCount !== candidate.rows.length
		|| !Number.isInteger(candidate.columnCount)
		|| (candidate.columnCount as number) < 0) {
		return false;
	}
	return candidate.rows.every(row => Array.isArray(row)
		&& row.length <= (candidate.columnCount as number)
		&& row.every(cell => typeof cell === 'string'));
}

function isRestoreViewStateMessage(value: unknown): value is RestoreViewStateMessage {
	return typeof value === 'object' && value !== null && 'type' in value && value.type === 'restoreViewState'
		&& 'mode' in value && (value.mode === 'edit' || value.mode === 'preview')
		&& (!('state' in value) || value.state === undefined || (typeof value.state === 'object' && value.state !== null))
		&& (!('corrupted' in value) || typeof value.corrupted === 'boolean')
		&& (!('reset' in value) || typeof value.reset === 'boolean');
}

function isXlsxDataMessage(value: unknown): value is XlsxDataMessage {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return candidate.type === 'xlsxData'
		&& typeof candidate.documentId === 'string' && typeof candidate.sheetId === 'string'
		&& (candidate.readonly === undefined || typeof candidate.readonly === 'boolean')
		&& (candidate.sourceMode === undefined || ['disk', 'buffer', 'csv-text'].includes(String(candidate.sourceMode)))
		&& (candidate.sourceStatus === undefined || typeof candidate.sourceStatus === 'string')
		&& Array.isArray(candidate.sheetIds) && Array.isArray(candidate.sheetNames) && candidate.sheetIds.length === candidate.sheetNames.length
		&& Number.isInteger(candidate.revision)
		&& typeof candidate.fileName === 'string'
		&& typeof candidate.sheetName === 'string'
		&& Array.isArray(candidate.sheetNames)
		&& candidate.sheetNames.every(name => typeof name === 'string')
		&& Number.isInteger(candidate.activeSheetIndex)
		&& (candidate.activeSheetIndex as number) >= 0
		&& (candidate.activeSheetIndex as number) < candidate.sheetNames.length
		&& (candidate.requestId === undefined || Number.isInteger(candidate.requestId))
		&& Array.isArray(candidate.rows)
		&& Array.isArray(candidate.cellKinds)
		&& Array.isArray(candidate.cellTypes) && Array.isArray(candidate.cellCapabilities)
		&& candidate.rows.length === candidate.cellKinds.length
		&& Number.isInteger(candidate.rowCount)
		&& candidate.rowCount === candidate.rows.length
		&& Number.isInteger(candidate.columnCount)
		&& (candidate.columnCount as number) >= 0
		&& candidate.rows.every(row => Array.isArray(row)
			&& row.length === candidate.columnCount
			&& row.every(cell => typeof cell === 'string'))
		&& candidate.cellKinds.every(row => Array.isArray(row)
			&& row.length === candidate.columnCount
			&& row.every(kind => ['value', 'empty', 'missing', 'formula'].includes(String(kind))))
		&& typeof candidate.formulaCaches === 'object'
		&& candidate.formulaCaches !== null
		&& (candidate.fileFormat === undefined || candidate.fileFormat === 'xlsx' || candidate.fileFormat === 'ods')
		&& (candidate.fileFormat === 'ods' || candidate.workbookBase64 === undefined || typeof candidate.workbookBase64 === 'string')
		&& (candidate.date1904 === undefined || typeof candidate.date1904 === 'boolean')
		&& (candidate.cellStyleIndexes === undefined || Array.isArray(candidate.cellStyleIndexes)
			&& candidate.cellStyleIndexes.length === candidate.rowCount
			&& candidate.cellStyleIndexes.every(row => Array.isArray(row) && row.length === candidate.columnCount
				&& row.every(index => index === undefined || index === null || Number.isInteger(index))))
		&& (candidate.cellNumberFormats === undefined || Array.isArray(candidate.cellNumberFormats)
			&& candidate.cellNumberFormats.every(item => typeof item === 'object' && item !== null
				&& 'numberFormatId' in item && Number.isInteger(item.numberFormatId)
				&& (!('formatCode' in item) || typeof item.formatCode === 'string')))
		&& (candidate.cellVisualStyles === undefined || Array.isArray(candidate.cellVisualStyles) && candidate.cellVisualStyles.every(isCellVisualStyle))
		&& (candidate.sheetStates === undefined || Array.isArray(candidate.sheetStates)
			&& candidate.sheetStates.length === candidate.sheetNames.length
			&& candidate.sheetStates.every(state => ['visible', 'hidden', 'veryHidden'].includes(String(state))))
		&& (candidate.columnDimensions === undefined || Array.isArray(candidate.columnDimensions)
			&& candidate.columnDimensions.every(item => typeof item === 'object' && item !== null
				&& 'min' in item && Number.isInteger(item.min) && 'max' in item && Number.isInteger(item.max)
				&& 'hidden' in item && typeof item.hidden === 'boolean'
				&& (!('width' in item) || item.width === undefined || Number.isFinite(item.width))))
		&& (candidate.rowDimensions === undefined || Array.isArray(candidate.rowDimensions)
			&& candidate.rowDimensions.every(item => typeof item === 'object' && item !== null
				&& 'row' in item && Number.isInteger(item.row) && 'hidden' in item && typeof item.hidden === 'boolean'
				&& (!('height' in item) || item.height === undefined || Number.isFinite(item.height))))
		&& (candidate.frozenPane === undefined || typeof candidate.frozenPane === 'object' && candidate.frozenPane !== null
			&& 'xSplit' in candidate.frozenPane && Number.isInteger(candidate.frozenPane.xSplit)
			&& 'ySplit' in candidate.frozenPane && Number.isInteger(candidate.frozenPane.ySplit))
		&& (candidate.mergedRanges === undefined || Array.isArray(candidate.mergedRanges) && candidate.mergedRanges.every(item => typeof item === 'string'))
		&& (candidate.cellNotes === undefined || Array.isArray(candidate.cellNotes) && candidate.cellNotes.every(item => typeof item === 'object' && item !== null
			&& 'reference' in item && typeof item.reference === 'string' && 'text' in item && typeof item.text === 'string'
			&& (!('author' in item) || item.author === undefined || typeof item.author === 'string')))
		&& (candidate.cellHyperlinks === undefined || Array.isArray(candidate.cellHyperlinks) && candidate.cellHyperlinks.every(item => typeof item === 'object' && item !== null
			&& 'reference' in item && typeof item.reference === 'string'
			&& (!('target' in item) || item.target === undefined || typeof item.target === 'string')
			&& (!('location' in item) || item.location === undefined || typeof item.location === 'string')))
		&& Array.isArray(candidate.warnings);
}

function isCellEditDeltaMessage(value: unknown): value is CellEditDeltaMessage {
	if (typeof value !== 'object' || value === null) {return false;}
	const candidate = value as Record<string, unknown>;
	return candidate.type === 'cellEditDelta' && typeof candidate.documentId === 'string'
		&& Number.isInteger(candidate.baseRevision) && Number.isInteger(candidate.revision)
		&& Array.isArray(candidate.cells) && candidate.cells.length > 0 && candidate.cells.length <= 500_000
		&& candidate.cells.every((cell: unknown) => typeof cell === 'object' && cell !== null
			&& Number.isInteger((cell as Record<string, unknown>).row) && Number.isInteger((cell as Record<string, unknown>).column)
			&& typeof (cell as Record<string, unknown>).value === 'string');
}

function isWorkbookCellEditDeltaMessage(value: unknown): value is WorkbookCellEditDeltaMessage {
	if (typeof value !== 'object' || value === null) {return false;}
	const candidate = value as Record<string, unknown>;
	return candidate.type === 'workbookCellEditDelta' && typeof candidate.documentId === 'string'
		&& Number.isInteger(candidate.baseRevision) && Number.isInteger(candidate.revision)
		&& Number.isInteger(candidate.sheetIndex) && Array.isArray(candidate.cells)
		&& candidate.cells.length > 0 && candidate.cells.length <= 500_000
		&& candidate.cells.every((cell: unknown) => typeof cell === 'object' && cell !== null
			&& Number.isInteger((cell as Record<string, unknown>).row) && Number.isInteger((cell as Record<string, unknown>).column)
			&& typeof (cell as Record<string, unknown>).value === 'string'
			&& ['value', 'empty'].includes(String((cell as Record<string, unknown>).kind))
			&& typeof (cell as Record<string, unknown>).storedType === 'string'
			&& typeof (cell as Record<string, unknown>).editable === 'boolean');
}

function isCellVisualStyle(value: unknown): value is CellVisualStyle {
	if (typeof value !== 'object' || value === null) {return false;}
	const style = value as Record<string, unknown>;
	const color = (candidate: unknown) => typeof candidate === 'string' && /^#[0-9a-f]{6}$/i.test(candidate);
	if (style.bold !== undefined && typeof style.bold !== 'boolean' || style.italic !== undefined && typeof style.italic !== 'boolean'
		|| style.wrapText !== undefined && typeof style.wrapText !== 'boolean'
		|| style.fontSize !== undefined && (typeof style.fontSize !== 'number' || style.fontSize < 6 || style.fontSize > 72)
		|| style.fontColor !== undefined && !color(style.fontColor) || style.fillColor !== undefined && !color(style.fillColor)) {return false;}
	if (style.horizontalAlignment !== undefined && !['left', 'center', 'right', 'justify', 'distributed', 'general'].includes(String(style.horizontalAlignment))) {return false;}
	if (style.verticalAlignment !== undefined && !['top', 'center', 'bottom', 'justify', 'distributed'].includes(String(style.verticalAlignment))) {return false;}
	if (style.borders !== undefined) {
		if (typeof style.borders !== 'object' || style.borders === null) {return false;}
		for (const [side, border] of Object.entries(style.borders)) {
			if (!['top', 'right', 'bottom', 'left'].includes(side) || typeof border !== 'object' || border === null
				|| !('style' in border) || !['hair', 'dotted', 'dashed', 'thin', 'medium', 'thick', 'double'].includes(String(border.style))
				|| 'color' in border && border.color !== undefined && !color(border.color)) {return false;}
		}
	}
	return true;
}

function isFormula(row: number, column: number): boolean {
	return snapshot?.type === 'xlsxData' && snapshot.cellKinds[row]?.[column] === 'formula';
}

function canEditCell(row: number, column: number): boolean {
	if (!snapshot) {return false;}
	if (snapshot.readonly) {return false;}
	if (snapshot.type === 'csvData' && snapshot.rowKinds?.[row] === 'comment') {return false;}
	return snapshot.type !== 'xlsxData' || snapshot.cellCapabilities[row]?.[column]?.editable === true;
}

function canEditFormulaCell(row: number, column: number): boolean {
	return showFormulaEditing && snapshot?.type === 'xlsxData' && snapshot.fileFormat !== 'ods'
		&& snapshot.readonly !== true && snapshot.cellCapabilities[row]?.[column]?.formulaEditable === true;
}

function getFormulaCache(row: number, column: number): string {
	if (snapshot?.type !== 'xlsxData') {
		return '';
	}
	return snapshot.formulaCaches[`${columnName(column)}${row + 1}`] ?? '';
}

function getFormulaResult(row: number, column: number): FormulaEvaluation | undefined {
	if (snapshot?.type !== 'xlsxData') {return undefined;}
	return formulaResults[`${columnName(column)}${row + 1}`];
}

function isSaveStateMessage(value: unknown): value is SaveStateMessage {
	if (typeof value !== 'object' || value === null) {return false;}
	const candidate = value as Record<string, unknown>;
	return candidate.type === 'saveState'
		&& ['clean', 'pending', 'saving', 'saved', 'error'].includes(String(candidate.state))
		&& (candidate.message === undefined || typeof candidate.message === 'string');
}

function isReloadStateMessage(value: unknown): value is ReloadStateMessage {
	if (typeof value !== 'object' || value === null) {return false;}
	const candidate = value as Record<string, unknown>;
	return candidate.type === 'reloadState'
		&& ['loading', 'done', 'cancelled', 'error'].includes(String(candidate.state))
		&& (candidate.message === undefined || typeof candidate.message === 'string');
}

function updateReloadState(message: ReloadStateMessage): void {
	if (message.state === 'loading') {
		reloadFileButton.disabled = true;
		reloadFileButton.textContent = 'Recargando…';
		return;
	}
	if (reloadWatchdog !== undefined) {
		window.clearTimeout(reloadWatchdog);
		reloadWatchdog = undefined;
	}
	reloadFileButton.disabled = false;
	reloadFileButton.textContent = '↻ Recargar';
	if (message.state === 'done' && !snapshot) {
		dimensions.textContent = 'No se recibieron los datos del archivo. Puedes volver a intentar con Recargar.';
		saveStatus.textContent = 'La vista no recibió los datos del archivo.';
		saveStatus.classList.add('save-error');
	} else if ((message.state === 'cancelled' || message.state === 'error') && snapshot) {
		dimensions.textContent = `${snapshot.rowCount.toLocaleString()} filas · ${snapshot.columnCount.toLocaleString()} columnas`;
	} else if (message.state === 'error') {
		dimensions.textContent = 'No se pudo recargar el archivo.';
	}
	if (message.state === 'error') {
		saveStatus.textContent = `Error al recargar: ${message.message ?? 'error desconocido'}`;
		saveStatus.classList.add('save-error');
	}
}

function requiredElement<T extends HTMLElement>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (!element) {
		throw new Error(`No se encontró el elemento requerido ${selector}.`);
	}
	return element;
}

function requestInitialData(): void {
	if (snapshot) {return;}
	if (startupDataAttempts >= 5) {
		dimensions.textContent = 'No se recibió la tabla. Pulsa Recargar para volver a intentarlo.';
		saveStatus.textContent = 'La vista no recibió los datos del archivo.';
		saveStatus.classList.add('save-error');
		return;
	}
	startupDataAttempts++;
	vscodeApi.postMessage({ type: 'ready' });
	startupDataTimer = window.setTimeout(requestInitialData, 1000);
}

requestInitialData();

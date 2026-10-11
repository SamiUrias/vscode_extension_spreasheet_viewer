import type { CsvDataMessage, FormulaEvaluation, ReloadStateMessage, RestoreViewStateMessage, SaveStateMessage, WebviewToExtensionMessage, XlsxDataMessage } from '../protocol';
import { resolveCellReference } from '../cell-reference';
import { findSearchMatches } from '../search';
import { findRowAtOffset, gridTemplateColumns, rebuildRowOffsets, type RowLayout } from './grid-layout';
import { renderSpreadsheetGrid, type GridRendererState } from './grid-renderer';
import { selectGridCell } from './selection';
import { cycleSort, projectRows, type SortCriterion } from '../table-view';
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
const resetViewButton = requiredElement<HTMLButtonElement>('#reset-view');
const sheetControl = requiredElement<HTMLLabelElement>('#sheet-control');
const sheetSelector = requiredElement<HTMLSelectElement>('#sheet-selector');
const cellReferenceInput = requiredElement<HTMLInputElement>('#cell-reference-input');
const goToCellButton = requiredElement<HTMLButtonElement>('#go-to-cell');
const searchInput = requiredElement<HTMLInputElement>('#search-input');
const previousMatchButton = requiredElement<HTMLButtonElement>('#previous-match');
const nextMatchButton = requiredElement<HTMLButtonElement>('#next-match');
const searchStatus = requiredElement<HTMLOutputElement>('#search-status');
const cellEditor = requiredElement<HTMLTextAreaElement>('#cell-editor');
const applyCellEditButton = requiredElement<HTMLButtonElement>('#apply-cell-edit');
const cellEditorGroup = requiredElement<HTMLDivElement>('#cell-editor-group');

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
let reloadWatchdog: number | undefined;
let startupDataTimer: number | undefined;
let startupDataAttempts = 0;
const columnWidthsBySheet = new Map<number, number[]>();
const rowLayoutsBySheet = new Map<number, RowLayout>();
let selectedCell: { row: number; column: number } | undefined;
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
let showComments = false;
let viewMode: ViewMode = 'edit';
let pendingViewRestore: RestoreViewStateMessage | undefined;
let persistViewTimer: number | undefined;
let applyingViewRestore = false;
const viewSheets: Record<string, SheetViewState> = {};
let restoreScrollAfterSelection: { top: number; left: number } | undefined;
let viewStateNotice = '';

gridScroll.tabIndex = 0;
gridScroll.setAttribute('role', 'grid');
gridScroll.setAttribute('aria-label', 'Tabla de datos. Usa las flechas para moverte entre celdas y escribe para editar la celda seleccionada.');

window.addEventListener('message', (event: MessageEvent<unknown>) => {
	if (typeof event.data === 'object' && event.data !== null && 'type' in event.data && event.data.type === 'sortState'
		&& 'criteria' in event.data && Array.isArray(event.data.criteria)) {
		sortCriteria = event.data.criteria as SortCriterion[];
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
	const previousSheetIndex = snapshot?.type === 'xlsxData' ? snapshot.activeSheetIndex : undefined;
	const previousRevision = snapshot?.revision;
	if (snapshot && snapshot.documentId !== event.data.documentId) {
		showComments = false;
		toggleCommentsButton.textContent = 'Mostrar comentarios';
	}
	if (startupDataTimer !== undefined) {
		window.clearTimeout(startupDataTimer);
		startupDataTimer = undefined;
	}
	snapshot = event.data;
	formulaResults = {};
	const restoredView = restoreViewForSnapshot(snapshot);
	const changedContent = previousRevision !== undefined && previousRevision !== snapshot.revision;
	dimensions.textContent = `${snapshot.rowCount.toLocaleString()} filas · ${snapshot.columnCount.toLocaleString()} columnas`;
	toggleCommentsButton.hidden = snapshot.type !== 'csvData' || snapshot.rowKinds?.includes('comment') !== true;
	formatNote.textContent = snapshot.type === 'xlsxData'
		? snapshot.fileFormat === 'ods'
			? `Hoja: ${snapshot.sheetName}. Los valores se muestran sin formatos visuales de ODS; las fórmulas muestran su expresión y valor almacenado, sin recalcularse.${snapshot.warnings.length ? ` Avisos: ${snapshot.warnings.join(' ')}` : ''}`
			: `Hoja: ${snapshot.sheetName}. Los valores se muestran sin formatos de Excel; Formualizer calcula fórmulas solo para mostrarlas y no se pueden editar ni guardar sus resultados.${snapshot.warnings.length ? ` Avisos: ${snapshot.warnings.join(' ')}` : ''}`
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
		updateSheetOptions(snapshot.sheetNames, snapshot.activeSheetIndex);
		if (snapshot.requestId !== undefined) {
			pendingSheetRequestId = undefined;
			pendingSheetIndex = undefined;
		}
	} else {
		sheetControl.hidden = true;
	}
	const changedSheet = snapshot.type === 'xlsxData'
		&& (previousSheetIndex !== snapshot.activeSheetIndex || snapshot.requestId !== undefined);
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
	if (restoredView && restoreScrollAfterSelection) {
		gridScroll.scrollTop = restoreScrollAfterSelection.top;
		gridScroll.scrollLeft = restoreScrollAfterSelection.left;
		restoreScrollAfterSelection = undefined;
		renderGrid();
	}
	if (changedSheet || changedContent || restoredView) {
		scheduleSearch();
	}
	if (snapshot.type === 'xlsxData' && snapshot.fileFormat !== 'ods' && snapshot.workbookBase64 && snapshot.cellKinds.some(row => row.includes('formula'))) {
		const calculationSnapshot = snapshot;
		const generation = ++formulaCalculationGeneration;
		void import('./formula-calculator').then(({ calculateFormulaResults }) => calculateFormulaResults(
			calculationSnapshot.workbookBase64!,
			calculationSnapshot.revision,
			calculationSnapshot.sheetName,
			calculationSnapshot.cellKinds,
			calculationSnapshot.rows,
		)).then(results => {
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
	toggleCommentsButton.textContent = showComments ? 'Ocultar comentarios' : 'Mostrar comentarios';
	renderGrid();
	schedulePersistViewState();
});
resetViewButton.addEventListener('click', () => {if (snapshot) {resetCurrentView(snapshot);}});

sheetSelector.addEventListener('change', () => {
	if (snapshot?.type !== 'xlsxData') {
		return;
	}
	const sheetIndex = Number(sheetSelector.value);
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
});

goToCellButton.addEventListener('click', goToCell);
cellEditor.addEventListener('input', () => {
	editorDirty = true;
	sendDraftState(true);
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

searchInput.addEventListener('input', () => {scheduleSearch(); schedulePersistViewState();});
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

gridScroll.addEventListener('keydown', event => {
	if (event.target !== gridScroll || !snapshot || !selectedCell) {
		return;
	}
	let row = selectedCell.row;
	let column = selectedCell.column;
	switch (event.key) {
		case 'ArrowUp': row--; break;
		case 'ArrowDown': row++; break;
		case 'ArrowLeft': column--; break;
		case 'ArrowRight': column++; break;
		default: {
			const startsText = !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing
				&& Array.from(event.key).length === 1;
			if (!startsText || !canEditCell(row, column)) {return;}
			event.preventDefault();
			beginInlineEdit(row, column, event.key);
			return;
		}
	}
	event.preventDefault();
	selectCell(
		Math.max(0, Math.min(snapshot.rowCount - 1, row)),
		Math.max(0, Math.min(snapshot.columnCount - 1, column)),
	);
});

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
		getActiveColumnWidths, gridTemplateColumns: widths => gridTemplateColumns(widths, rowHeaderWidth),
		startColumnResize, resizeColumnWithKeyboard, updateGridColumnSizing, getActiveRowLayout,
		findRowAtOffset, startRowResize, resizeRowWithKeyboard, columnName, isSelected, isFormula,
		getFormulaCache, getFormulaResult, isEditing, isActiveSearchMatch, inlineEditValue,
		setInlineEditValue: value => {inlineEditValue = value;},
		sendDraftState, setInlineEditorDirty: value => {inlineEditorDirty = value;},
		commitInlineEdit, cancelInlineEdit, selectCell, beginInlineEdit,
		projection: getRowProjection(),
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
		schedulePersistViewState();
			gridRendererState.rowsViewport = undefined;
			renderGrid();
		},
		sortLabel: column => {
			const index = sortCriteria.findIndex(item => item.column === column);
			return index < 0 ? '' : ` ${sortCriteria[index]!.direction === 'asc' ? '↑' : '↓'}${sortCriteria.length > 1 ? index + 1 : ''}`;
		},
	});
	rowsViewport = gridRendererState.rowsViewport;
	renderedColumnCount = gridRendererState.renderedColumnCount;
}
function selectCell(row: number, column: number): void {
	if (!showComments && snapshot?.type === 'csvData' && snapshot.rowKinds?.[row] === 'comment') {
		showComments = true;
		toggleCommentsButton.textContent = 'Ocultar comentarios';
	}
	selectGridCell({
		snapshot, selectedCell, setSelectedCell: position => {selectedCell = position;}, commitSelectedEdit,
		columnName, getFormulaResult, getFormulaCache, cellReference, cellReferenceInput, cellState, cellValue,
		cellEditor, applyCellEditButton, setEditorDirty: value => {editorDirty = value;},
		ensureSelectionVisible, renderGrid,
	}, row, column);
	schedulePersistViewState();
}

function commitSelectedEdit(): void {
	if (!editorDirty || !snapshot || !selectedCell || !canEditCell(selectedCell.row, selectedCell.column)) {return;}
	sendCellEdit(selectedCell, cellEditor.value);
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
	});
}

function isEditing(row: number, column: number): boolean {
	return editingCell?.row === row && editingCell.column === column;
}

function updateSaveStatus(message: SaveStateMessage): void {
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
	selectCell(position.row, position.column);
	gridScroll.focus({ preventScroll: true });
}

function updateSheetOptions(names: string[], activeIndex: number): void {
	sheetSelector.replaceChildren();
	for (let index = 0; index < names.length; index++) {
		const option = document.createElement('option');
		option.value = String(index);
		option.textContent = names[index];
		sheetSelector.append(option);
	}
	sheetSelector.value = String(activeIndex);
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
	void findSearchMatches(
		sheet.rows,
		sheet.columnCount,
		query,
		() => generation !== searchGeneration || snapshot !== sheet,
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
			selectCell(Math.floor(firstMatch / sheet.columnCount), firstMatch % sheet.columnCount);
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
	selectCell(Math.floor(match / snapshot.columnCount), match % snapshot.columnCount);
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
	const visibleTop = gridScroll.scrollTop + headingHeight;
	const visibleBottom = gridScroll.scrollTop + gridScroll.clientHeight;
	if (cellTop < visibleTop) {
		gridScroll.scrollTop = cellTop - headingHeight;
	} else if (cellBottom > visibleBottom) {
		gridScroll.scrollTop = cellBottom - gridScroll.clientHeight;
	}
	const widths = getActiveColumnWidths();
	const cellLeft = rowHeaderWidth + widths.slice(0, column).reduce((total, width) => total + width, 0);
	const selectedColumnWidth = widths[column] ?? columnWidth;
	const visibleLeft = gridScroll.scrollLeft + rowHeaderWidth;
	const visibleRight = gridScroll.scrollLeft + gridScroll.clientWidth;
	if (cellLeft < visibleLeft) {
		gridScroll.scrollLeft = cellLeft - rowHeaderWidth;
	} else if (cellLeft + selectedColumnWidth > visibleRight) {
		gridScroll.scrollLeft = cellLeft + selectedColumnWidth - gridScroll.clientWidth;
	}
}

function getRowProjection() {
	const hidden = new Set<number>();
	const rowKinds = snapshot?.type === 'csvData' ? snapshot.rowKinds : undefined;
	for (let row = 0; !showComments && row < (rowKinds?.length ?? 0); row++) {
		if (rowKinds?.[row] === 'comment') {hidden.add(row);}
	}
	return projectRows(snapshot?.rows ?? [], sortCriteria, hidden);
}

function restoreViewForSnapshot(current: CsvDataMessage | XlsxDataMessage): boolean {
	const message = pendingViewRestore;
	pendingViewRestore = undefined;
	if (!message || message.mode !== viewMode || !message.state) {return false;}
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
	const columnWidths = Array.from({ length: columnCount }, (_, column) => Number(sheetState.columnWidths[String(column)]) || columnWidth);
	columnWidthsBySheet.set(sheetIndex, columnWidths);
	const rowLayout = { heights: Array.from({ length: rowCount }, (_, row) => Number(sheetState.rowHeights[String(row)]) || defaultRowHeight), offsets: [] as number[] };
	const selection = sheetState.selection && rowCount && columnCount
		? { row: Math.min(sheetState.selection.row, rowCount - 1), column: Math.min(sheetState.selection.column, columnCount - 1) }
		: undefined;
	const columnSchemaChanged = sheetState.schema !== sheetSchema(current);
	sortCriteria = columnSchemaChanged ? sheetState.sort.filter(item => item.column < columnCount) : [...sheetState.sort];
	if (columnSchemaChanged) {
		for (const key of Object.keys(sheetState.columnWidths)) {if (Number(key) >= columnCount) {delete sheetState.columnWidths[key];}}
	}
	searchInput.value = sheetState.query;
	showComments = sheetState.showComments;
	toggleCommentsButton.textContent = showComments ? 'Ocultar comentarios' : 'Mostrar comentarios';
	rowLayoutsBySheet.set(sheetIndex, rowLayout);
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
	searchInput.value = '';
	showComments = false;
	resetSheetView(current);
	gridScroll.scrollTop = 0;
	gridScroll.scrollLeft = 0;
	invalidateSearch();
	applyingViewRestore = false;
	if (keepDraftCell && draftSelection) {selectedCell = draftSelection; renderGrid();}
	else if (current.rowCount && current.columnCount) {selectedCell = undefined; selectCell(0, 0);}
	else {renderGrid();}
	if (persistViewTimer !== undefined) {window.clearTimeout(persistViewTimer); persistViewTimer = undefined;}
	void vscodeApi.postMessage({ type: 'resetView', mode: viewMode });
}

function resetSheetView(current: CsvDataMessage | XlsxDataMessage): void {
	const sheetIndex = current.type === 'xlsxData' ? current.activeSheetIndex : 0;
	columnWidthsBySheet.delete(sheetIndex);
	rowLayoutsBySheet.delete(sheetIndex);
	selectedCell = undefined;
	sortCriteria = [];
	searchInput.value = '';
	showComments = false;
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
	widths.forEach((width, index) => {if (width !== columnWidth) {columnWidthOverrides[String(index)] = width;}});
	const rowHeightOverrides: Record<string, number> = {};
	layout.heights.forEach((height, index) => {if (height !== defaultRowHeight) {rowHeightOverrides[String(index)] = height;}});
	viewSheets[sheetId] = {
		schema: sheetSchema(snapshot), query: searchInput.value.slice(0, 2048),
		...(selectedCell ? { selection: { ...selectedCell } } : {}),
		scroll: { top: Math.max(0, gridScroll.scrollTop), left: Math.max(0, gridScroll.scrollLeft) },
		sort: [...sortCriteria], columnWidths: columnWidthOverrides, rowHeights: rowHeightOverrides, showComments,
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
		if (!Number.isFinite(widths[column])) {widths[column] = columnWidth;}
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
	for (const row of rowsViewport.children) {
		(row as HTMLDivElement).style.gridTemplateColumns = template;
	}
	rowsViewport.style.width = `${totalWidth}px`;
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
			if (!Number.isFinite(layout.heights[row])) {layout.heights[row] = defaultRowHeight;}
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
		schedulePersistViewState();
	};
	handle.addEventListener('pointermove', onMove);
	handle.addEventListener('pointerup', finish);
	handle.addEventListener('pointercancel', finish);
}

function updateGridRowSizing(layout: { heights: number[]; offsets: number[] }): void {
	if (!snapshot || !rowsViewport) {return;}
	rowsViewport.style.height = `${layout.offsets[snapshot.rowCount] ?? 0}px`;
	for (const element of rowsViewport.children) {
		const row = element as HTMLDivElement;
		const index = Number(row.dataset.rowIndex);
		row.style.top = `${layout.offsets[index] ?? 0}px`;
		row.style.height = `${layout.heights[index] ?? defaultRowHeight}px`;
	}
}

function resizeRowWithKeyboard(event: KeyboardEvent, row: number): void {
	if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {return;}
	event.preventDefault();
	event.stopPropagation();
	const layout = getActiveRowLayout();
	const amount = event.shiftKey ? 32 : 8;
	const direction = event.key === 'ArrowDown' ? 1 : -1;
	layout.heights[row] = Math.max(minimumRowHeight, Math.min(maximumRowHeight, (layout.heights[row] ?? defaultRowHeight) + direction * amount));
	rebuildRowOffsets(layout);
	updateGridRowSizing(layout);
	schedulePersistViewState();
}

function isSelected(row: number, column: number): boolean {
	return selectedCell?.row === row && selectedCell.column === column;
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
		&& (candidate.fileFormat === 'ods' || typeof candidate.workbookBase64 === 'string')
		&& Array.isArray(candidate.warnings);
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

import type { CsvDataMessage, FormulaEvaluation, ReloadStateMessage, SaveStateMessage, WebviewToExtensionMessage, XlsxDataMessage } from '../protocol';
import { resolveCellReference } from '../cell-reference';
import { findSearchMatches } from '../search';

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
const rowLayoutsBySheet = new Map<number, { heights: number[]; offsets: number[] }>();
let selectedCell: { row: number; column: number } | undefined;
let renderScheduled = false;
let rowsViewport: HTMLDivElement | undefined;
let renderedColumnCount = 0;
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

gridScroll.tabIndex = 0;
gridScroll.setAttribute('role', 'grid');
gridScroll.setAttribute('aria-label', 'Tabla de datos. Usa las flechas para moverte entre celdas.');

window.addEventListener('message', (event: MessageEvent<unknown>) => {
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
	if (startupDataTimer !== undefined) {
		window.clearTimeout(startupDataTimer);
		startupDataTimer = undefined;
	}
	snapshot = event.data;
	formulaResults = {};
	const changedContent = previousRevision !== undefined && previousRevision !== snapshot.revision;
	dimensions.textContent = `${snapshot.rowCount.toLocaleString()} filas · ${snapshot.columnCount.toLocaleString()} columnas`;
	formatNote.textContent = snapshot.type === 'xlsxData'
		? snapshot.fileFormat === 'ods'
			? `Hoja: ${snapshot.sheetName}. Los valores se muestran sin formatos visuales de ODS; las fórmulas muestran su expresión y valor almacenado, sin recalcularse.${snapshot.warnings.length ? ` Avisos: ${snapshot.warnings.join(' ')}` : ''}`
			: `Hoja: ${snapshot.sheetName}. Los valores se muestran sin formatos de Excel; Formualizer calcula fórmulas solo para mostrarlas y no se pueden editar ni guardar sus resultados.${snapshot.warnings.length ? ` Avisos: ${snapshot.warnings.join(' ')}` : ''}`
		: '';
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
	if (changedSheet) {
		gridScroll.scrollTop = 0;
		gridScroll.scrollLeft = 0;
		selectedCell = undefined;
	}
	if (snapshot.rowCount > 0 && snapshot.columnCount > 0) {
		if (changedSheet || !selectedCell) {
			selectCell(0, 0);
		} else if (changedContent) {
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
	if (changedSheet || changedContent) {
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
	pendingSheetRequestId = requestId;
	pendingSheetIndex = sheetIndex;
	invalidateSearch();
	updateSearchStatus();
	renderGrid();
	vscodeApi.postMessage({ type: 'selectSheet', sheetIndex, requestId });
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

searchInput.addEventListener('input', scheduleSearch);
previousMatchButton.addEventListener('click', () => navigateSearch(-1));
nextMatchButton.addEventListener('click', () => navigateSearch(1));

gridScroll.addEventListener('scroll', () => {
	if (renderScheduled) {
		return;
	}
	renderScheduled = true;
	window.requestAnimationFrame(() => {
		renderScheduled = false;
		renderGrid();
	});
});

gridScroll.addEventListener('keydown', event => {
	if (!snapshot || !selectedCell) {
		return;
	}
	let row = selectedCell.row;
	let column = selectedCell.column;
	switch (event.key) {
		case 'ArrowUp': row--; break;
		case 'ArrowDown': row++; break;
		case 'ArrowLeft': column--; break;
		case 'ArrowRight': column++; break;
		default: return;
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
	if (!snapshot || snapshot.rowCount === 0 || snapshot.columnCount === 0) {
		rowsViewport = undefined;
		renderedColumnCount = 0;
		gridRoot.replaceChildren();
		const empty = document.createElement('p');
		empty.className = 'empty-state';
		empty.textContent = snapshot?.type === 'xlsxData' ? 'La hoja XLSX no contiene celdas.' : 'El CSV no contiene celdas.';
		gridRoot.append(empty);
		return;
	}

	gridScroll.setAttribute('aria-rowcount', String(snapshot.rowCount + 1));
	gridScroll.setAttribute('aria-colcount', String(snapshot.columnCount + 1));
	const widths = getActiveColumnWidths();
	const templateColumns = gridTemplateColumns(widths);
	if (!rowsViewport || renderedColumnCount !== snapshot.columnCount) {
		const headerRow = document.createElement('div');
		headerRow.className = 'grid-row grid-header';
		headerRow.setAttribute('role', 'row');
		headerRow.style.gridTemplateColumns = templateColumns;
		const corner = document.createElement('div');
		corner.className = 'corner-header';
		corner.setAttribute('role', 'columnheader');
		corner.setAttribute('aria-hidden', 'true');
		headerRow.append(corner);
		for (let column = 0; column < snapshot.columnCount; column++) {
			const heading = document.createElement('div');
			heading.className = 'column-header';
			heading.setAttribute('role', 'columnheader');
			heading.append(columnName(column));
			const resizeHandle = document.createElement('span');
			resizeHandle.className = 'column-resize-handle';
			resizeHandle.setAttribute('role', 'separator');
			resizeHandle.setAttribute('aria-orientation', 'vertical');
			resizeHandle.setAttribute('aria-label', `Redimensionar columna ${columnName(column)}`);
			resizeHandle.tabIndex = 0;
			resizeHandle.addEventListener('pointerdown', event => startColumnResize(event, column, resizeHandle));
			resizeHandle.addEventListener('keydown', event => resizeColumnWithKeyboard(event, column));
			heading.append(resizeHandle);
			headerRow.append(heading);
		}
		rowsViewport = document.createElement('div');
		rowsViewport.className = 'rows-viewport';
		rowsViewport.style.width = `${rowHeaderWidth + widths.reduce((total, width) => total + width, 0)}px`;
		gridRoot.style.width = 'max-content';
		gridRoot.style.minWidth = '100%';
		gridRoot.replaceChildren(headerRow, rowsViewport);
		renderedColumnCount = snapshot.columnCount;
	}
	updateGridColumnSizing();

	const rowLayout = getActiveRowLayout();
	const firstViewportRow = findRowAtOffset(rowLayout.offsets, Math.max(0, gridScroll.scrollTop - headingHeight));
	const lastViewportRow = findRowAtOffset(rowLayout.offsets, Math.max(0, gridScroll.scrollTop + gridScroll.clientHeight - headingHeight));
	const firstVisibleRow = Math.max(0, firstViewportRow - overscan);
	const endVisibleRow = Math.min(snapshot.rowCount, lastViewportRow + overscan + 1);
	rowsViewport.style.height = `${rowLayout.offsets[snapshot.rowCount] ?? 0}px`;
	rowsViewport.replaceChildren();
	for (let rowIndex = firstVisibleRow; rowIndex < endVisibleRow; rowIndex++) {
		const row = document.createElement('div');
		row.className = 'grid-row';
		row.style.gridTemplateColumns = templateColumns;
		row.style.top = `${rowLayout.offsets[rowIndex] ?? 0}px`;
		row.style.height = `${rowLayout.heights[rowIndex] ?? defaultRowHeight}px`;
		row.dataset.rowIndex = String(rowIndex);
		row.setAttribute('role', 'row');
		row.setAttribute('aria-rowindex', String(rowIndex + 2));
		const rowHeader = document.createElement('div');
		rowHeader.className = 'row-header';
		rowHeader.setAttribute('role', 'rowheader');
		rowHeader.textContent = String(rowIndex + 1);
		const rowResizeHandle = document.createElement('span');
		rowResizeHandle.className = 'row-resize-handle';
		rowResizeHandle.setAttribute('role', 'separator');
		rowResizeHandle.setAttribute('aria-orientation', 'horizontal');
		rowResizeHandle.setAttribute('aria-label', `Redimensionar fila ${rowIndex + 1}`);
		rowResizeHandle.tabIndex = 0;
		rowResizeHandle.addEventListener('pointerdown', event => startRowResize(event, rowIndex, rowResizeHandle));
		rowResizeHandle.addEventListener('keydown', event => resizeRowWithKeyboard(event, rowIndex));
		rowHeader.append(rowResizeHandle);
		row.append(rowHeader);

		const values = snapshot.rows[rowIndex];
		for (let column = 0; column < snapshot.columnCount; column++) {
			const valueCell = document.createElement('div');
			const present = column < values.length;
			const value = present ? values[column] : '';
			valueCell.className = 'grid-cell';
			valueCell.textContent = value;
			valueCell.title = value;
			valueCell.setAttribute('role', 'gridcell');
			valueCell.setAttribute('aria-selected', String(isSelected(rowIndex, column)));
			if (!present) {
				valueCell.classList.add('missing-cell');
			}
			if (isFormula(rowIndex, column)) {
				valueCell.classList.add('formula-cell');
				const cache = getFormulaCache(rowIndex, column) || 'Sin valor almacenado';
				const result = getFormulaResult(rowIndex, column);
				const calculated = result?.status === 'calculated' ? `Fórmula (calculada): ${result.value}`
					: result?.status === 'unsupported' ? 'Fórmula NO compatible'
						: result ? `Error de cálculo: ${result.value}` : 'Fórmula calculándose…';
				valueCell.title = `${value}\nValor almacenado en caché: ${cache}\n${calculated}`;
			}
			if (isEditing(rowIndex, column)) {
				const inlineEditor = document.createElement('textarea');
				inlineEditor.className = 'cell-inline-editor';
				inlineEditor.rows = 1;
				inlineEditor.spellcheck = false;
				inlineEditor.setAttribute('aria-label', `Editar ${columnName(column)}${rowIndex + 1}`);
				inlineEditor.value = inlineEditValue;
				inlineEditor.addEventListener('input', () => {
					inlineEditValue = inlineEditor.value;
					inlineEditorDirty = true;
					sendDraftState(true, inlineEditValue);
				});
				inlineEditor.addEventListener('blur', commitInlineEdit);
				inlineEditor.addEventListener('keydown', event => {
					if (event.key === 'Escape') {
						event.preventDefault();
						cancelInlineEdit();
					} else if (event.key === 'Enter' && !event.shiftKey) {
						event.preventDefault();
						commitInlineEdit();
						gridScroll.focus({ preventScroll: true });
					}
				});
				inlineEditor.addEventListener('click', event => event.stopPropagation());
				valueCell.append(inlineEditor);
			}
			if (isSelected(rowIndex, column)) {
				valueCell.classList.add('selected-cell');
			}
			if (isActiveSearchMatch(rowIndex, column)) {
				valueCell.classList.add('active-search-match');
			}
			valueCell.addEventListener('click', () => {
				gridScroll.focus({ preventScroll: true });
				selectCell(rowIndex, column);
			});
			valueCell.addEventListener('dblclick', () => beginInlineEdit(rowIndex, column));
			row.append(valueCell);
		}
		rowsViewport.append(row);
	}
}

function selectCell(row: number, column: number): void {
	if (!snapshot) {
		return;
	}
	if (selectedCell && (selectedCell.row !== row || selectedCell.column !== column)) {commitSelectedEdit();}
	selectedCell = { row, column };
	const reference = `${columnName(column)}${row + 1}`;
	cellReference.textContent = reference;
	cellReferenceInput.value = reference;
	const values = snapshot.rows[row];
	const exists = column < values.length;
	const kind = snapshot.type === 'xlsxData' ? snapshot.cellKinds[row]?.[column] : undefined;
	const formulaResult = kind === 'formula' ? getFormulaResult(row, column) : undefined;
	cellState.textContent = kind === 'formula'
		? snapshot.type === 'xlsxData' && snapshot.fileFormat === 'ods' ? 'Fórmula (no recalculada)'
			: formulaResult?.status === 'calculated' ? 'Fórmula (calculada)'
			: formulaResult?.status === 'unsupported' ? 'Fórmula NO compatible'
				: formulaResult ? 'Fórmula (error de cálculo)' : 'Calculando fórmula…'
		: kind === 'empty' || (exists && values[column] === '')
			? 'Celda vacía almacenada'
			: kind === 'missing' || !exists ? 'Celda ausente' : 'Valor crudo';
	cellState.dataset.state = kind === 'formula'
		? snapshot.type === 'xlsxData' && snapshot.fileFormat === 'ods' ? 'formula'
			: formulaResult?.status ?? 'calculating'
		: kind === 'empty' || kind === 'missing' || !exists ? 'empty' : 'raw';
	cellValue.textContent = exists ? values[column] : '';
	if (kind === 'formula') {
		const cache = getFormulaCache(row, column) || 'Sin valor almacenado';
		cellValue.textContent += `\nValor almacenado en caché: ${cache}`;
		if (formulaResult?.status === 'calculated') {
			cellValue.textContent += `\n\nFórmula (calculada)\n${formulaResult.value}`;
		} else if (snapshot.type === 'xlsxData' && snapshot.fileFormat === 'ods') {
			cellValue.textContent += '\n\nFórmula (no recalculada)';
		} else if (formulaResult?.status === 'unsupported') {
			cellValue.textContent += '\n\nFórmula NO compatible';
		} else if (formulaResult) {
			cellValue.textContent += `\n\nError al calcular: ${formulaResult.value}`;
		} else {
			cellValue.textContent += '\n\nCalculando fórmula…';
		}
	}
	cellEditor.value = exists ? values[column] : '';
	editorDirty = false;
	cellEditor.disabled = kind === 'formula';
	applyCellEditButton.disabled = kind === 'formula';
	ensureSelectionVisible(row, column);
	renderGrid();
}

function commitSelectedEdit(): void {
	if (!editorDirty || !snapshot || !selectedCell || isFormula(selectedCell.row, selectedCell.column)) {return;}
	sendCellEdit(selectedCell, cellEditor.value);
	editorDirty = false;
	saveStatus.textContent = 'Cambios pendientes…';
}

function beginInlineEdit(row: number, column: number): void {
	if (!snapshot || isFormula(row, column)) {return;}
	selectCell(row, column);
	editingCell = { row, column };
	inlineEditValue = snapshot.rows[row]?.[column] ?? '';
	inlineEditorDirty = false;
	renderGrid();
	const inlineEditor = gridRoot.querySelector<HTMLTextAreaElement>('.cell-inline-editor');
	inlineEditor?.focus({ preventScroll: true });
	inlineEditor?.setSelectionRange(inlineEditor.value.length, inlineEditor.value.length);
}

function commitInlineEdit(): void {
	if (!editingCell) {return;}
	const position = editingCell;
	editingCell = undefined;
	if (inlineEditorDirty && !isFormula(position.row, position.column)) {
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
	if (!snapshot) {return;}
	const sheetIndex = snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0;
	sendDraftState(false, value, position);
	vscodeApi.postMessage({ type: 'editCell', sheetIndex, ...position, value });
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
	if (!snapshot || !position) {return;}
	vscodeApi.postMessage({
		type: 'draftState', dirty,
		sheetIndex: snapshot.type === 'xlsxData' ? snapshot.activeSheetIndex : 0,
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
	const cellTop = headingHeight + (rowLayout.offsets[row] ?? 0);
	const cellBottom = headingHeight + (rowLayout.offsets[row + 1] ?? ((rowLayout.offsets[row] ?? 0) + defaultRowHeight));
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

function gridTemplateColumns(widths: number[]): string {
	return `${rowHeaderWidth}px ${widths.map(width => `${width}px`).join(' ')}`;
}

function updateGridColumnSizing(): void {
	if (!snapshot || !rowsViewport) {return;}
	const widths = getActiveColumnWidths();
	const template = gridTemplateColumns(widths);
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

function rebuildRowOffsets(layout: { heights: number[]; offsets: number[] }): void {
	layout.offsets.length = layout.heights.length + 1;
	layout.offsets[0] = 0;
	for (let row = 0; row < layout.heights.length; row++) {
		layout.offsets[row + 1] = layout.offsets[row]! + layout.heights[row]!;
	}
}

function findRowAtOffset(offsets: readonly number[], offset: number): number {
	const rowCount = offsets.length - 1;
	if (rowCount <= 0) {return 0;}
	let low = 0;
	let high = rowCount - 1;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if ((offsets[middle + 1] ?? 0) <= offset) {low = middle + 1;} else {high = middle;}
	}
	return low;
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

function isXlsxDataMessage(value: unknown): value is XlsxDataMessage {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return candidate.type === 'xlsxData'
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

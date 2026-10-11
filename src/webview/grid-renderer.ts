import type { CsvDataMessage, XlsxDataMessage, FormulaEvaluation } from '../protocol';
import type { RowLayout } from './grid-layout';
import type { RowProjection } from '../table-view';

export interface GridRendererState { rowsViewport: HTMLDivElement | undefined; renderedColumnCount: number; }
export interface GridRenderContext {
	snapshot: CsvDataMessage | XlsxDataMessage | undefined;
	state: GridRendererState;
	gridScroll: HTMLDivElement; gridRoot: HTMLDivElement;
	defaultRowHeight: number; headingHeight: number; rowHeaderWidth: number; overscan: number;
	getActiveColumnWidths(): number[]; gridTemplateColumns(widths: number[]): string;
	startColumnResize(event: PointerEvent, column: number, handle: HTMLSpanElement): void;
	resizeColumnWithKeyboard(event: KeyboardEvent, column: number): void;
	updateGridColumnSizing(): void; getActiveRowLayout(): RowLayout;
	findRowAtOffset(offsets: readonly number[], offset: number): number;
	startRowResize(event: PointerEvent, row: number, handle: HTMLSpanElement): void;
	resizeRowWithKeyboard(event: KeyboardEvent, row: number): void;
	columnName(index: number): string; isSelected(row: number, column: number): boolean;
	isFormula(row: number, column: number): boolean; getFormulaCache(row: number, column: number): string;
	getFormulaResult(row: number, column: number): FormulaEvaluation | undefined;
	isEditing(row: number, column: number): boolean; isActiveSearchMatch(row: number, column: number): boolean;
	inlineEditValue: string; setInlineEditValue(value: string): void; sendDraftState(dirty: boolean, value?: string): void;
	setInlineEditorDirty(value: boolean): void; commitInlineEdit(): void; cancelInlineEdit(): void;
	selectCell(row: number, column: number): void; beginInlineEdit(row: number, column: number): void;
	projection: RowProjection; sortHeader(column: number, event: MouseEvent): void; sortLabel(column: number): string;
	openFilter(column: number, button: HTMLButtonElement): void; isFiltered(column: number): boolean;
}

export function renderSpreadsheetGrid(context: GridRenderContext): void {
	const { state, snapshot, gridScroll, gridRoot, defaultRowHeight, headingHeight, rowHeaderWidth, overscan,
		getActiveColumnWidths, gridTemplateColumns, startColumnResize, resizeColumnWithKeyboard,
		updateGridColumnSizing, getActiveRowLayout, findRowAtOffset, startRowResize,
		resizeRowWithKeyboard, columnName, isSelected, isFormula, getFormulaCache, getFormulaResult,
		isEditing, isActiveSearchMatch, inlineEditValue, setInlineEditValue, sendDraftState, setInlineEditorDirty,
		commitInlineEdit, cancelInlineEdit, selectCell, beginInlineEdit, projection, sortHeader, sortLabel, openFilter, isFiltered } = context;
	let { rowsViewport, renderedColumnCount } = state;

	if (!snapshot || snapshot.rowCount === 0 || snapshot.columnCount === 0) {
		state.rowsViewport = undefined;
		state.renderedColumnCount = 0;
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
			const ordinal = document.createElement('span');
			ordinal.className = 'column-ordinal';
			ordinal.textContent = `${columnName(column)}${sortLabel(column)}`;
			heading.append(ordinal);
			const label = snapshot.type === 'csvData' ? snapshot.headerLabels?.[column] : undefined;
			if (label) {
				const headerLabel = document.createElement('span');
				headerLabel.className = 'column-label';
				headerLabel.textContent = label;
				heading.append(headerLabel);
			}
			heading.title = 'Click: ascendente, descendente, quitar; Shift+click: añadir criterio; Ctrl/Cmd+click: quitar criterio; Alt+click: alternar texto/número. El número indica prioridad.';
			heading.addEventListener('click', event => sortHeader(column, event));
			const filterButton = document.createElement('button');
			filterButton.className = 'column-filter-button';
			filterButton.type = 'button';
			filterButton.textContent = isFiltered(column) ? '▼' : '▽';
			filterButton.setAttribute('aria-label', `Filtrar columna ${columnName(column)}${label ? ` (${label})` : ''}`);
			filterButton.setAttribute('aria-haspopup', 'dialog');
			filterButton.setAttribute('aria-expanded', 'false');
			filterButton.title = isFiltered(column) ? 'Editar o limpiar filtro' : 'Filtrar esta columna';
			filterButton.addEventListener('click', event => {event.stopPropagation(); openFilter(column, filterButton);});
			heading.append(filterButton);
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
	const projectedHeights = projection.visibleRows.map(sourceRow => rowLayout.heights[sourceRow] ?? defaultRowHeight);
	const projectedOffsets = [0];
	for (const height of projectedHeights) {projectedOffsets.push(projectedOffsets[projectedOffsets.length - 1]! + height);}
	const visibleRowCount = projection.visibleRows.length;
	gridScroll.setAttribute('aria-rowcount', String(visibleRowCount + 1));
	const firstViewportRow = findRowAtOffset(projectedOffsets, Math.max(0, gridScroll.scrollTop - headingHeight));
	const lastViewportRow = findRowAtOffset(projectedOffsets, Math.max(0, gridScroll.scrollTop + gridScroll.clientHeight - headingHeight));
	const firstVisibleRow = Math.max(0, firstViewportRow - overscan);
	const endVisibleRow = Math.min(visibleRowCount, lastViewportRow + overscan + 1);
	rowsViewport.style.height = `${projectedOffsets[visibleRowCount] ?? 0}px`;
	rowsViewport.replaceChildren();
	if (visibleRowCount === 0) {
		rowsViewport.style.height = 'auto';
		const empty = document.createElement('p');
		empty.className = 'empty-state';
		empty.textContent = 'Ninguna fila coincide con los filtros. Puedes ajustar o limpiar el filtro en los encabezados.';
		rowsViewport.append(empty);
		return;
	}
	for (let rowIndex = firstVisibleRow; rowIndex < endVisibleRow; rowIndex++) {
		const sourceRow = projection.visibleRows[rowIndex]!;
		const row = document.createElement('div');
		row.className = 'grid-row';
		row.style.gridTemplateColumns = templateColumns;
		row.style.top = `${projectedOffsets[rowIndex] ?? 0}px`;
		row.style.height = `${projectedHeights[rowIndex] ?? defaultRowHeight}px`;
		row.dataset.rowIndex = String(rowIndex);
		row.setAttribute('role', 'row');
		row.setAttribute('aria-rowindex', String(rowIndex + 2));
		const rowHeader = document.createElement('div');
		rowHeader.className = 'row-header';
		rowHeader.setAttribute('role', 'rowheader');
		rowHeader.textContent = String(sourceRow + 1);
		if (snapshot.type === 'csvData' && snapshot.physicalLines?.[sourceRow]) {
			rowHeader.title = `Registro ${sourceRow + 1} · línea física ${snapshot.physicalLines[sourceRow]}`;
		}
		const rowResizeHandle = document.createElement('span');
		rowResizeHandle.className = 'row-resize-handle';
		rowResizeHandle.setAttribute('role', 'separator');
		rowResizeHandle.setAttribute('aria-orientation', 'horizontal');
		rowResizeHandle.setAttribute('aria-label', `Redimensionar fila ${sourceRow + 1}`);
		rowResizeHandle.tabIndex = 0;
		rowResizeHandle.addEventListener('pointerdown', event => startRowResize(event, sourceRow, rowResizeHandle));
		rowResizeHandle.addEventListener('keydown', event => resizeRowWithKeyboard(event, sourceRow));
		rowHeader.append(rowResizeHandle);
		row.append(rowHeader);

		const values = snapshot.rows[sourceRow];
		for (let column = 0; column < snapshot.columnCount; column++) {
			const valueCell = document.createElement('div');
			const present = column < values.length;
			const value = present ? values[column] : '';
			valueCell.className = 'grid-cell';
			valueCell.textContent = value;
			valueCell.title = value;
			valueCell.setAttribute('role', 'gridcell');
			valueCell.setAttribute('aria-selected', String(isSelected(sourceRow, column)));
			if (!present) {
				valueCell.classList.add('missing-cell');
			}
			if (isFormula(sourceRow, column)) {
				valueCell.classList.add('formula-cell');
				const cache = getFormulaCache(sourceRow, column) || 'Sin valor almacenado';
				const result = getFormulaResult(sourceRow, column);
				const calculated = result?.status === 'calculated' ? `Fórmula (calculada): ${result.value}`
					: result?.status === 'unsupported' ? 'Fórmula NO compatible'
						: result ? `Error de cálculo: ${result.value}` : 'Fórmula calculándose…';
				valueCell.title = `${value}\nValor almacenado en caché: ${cache}\n${calculated}`;
			}
			if (isEditing(sourceRow, column)) {
				const inlineEditor = document.createElement('textarea');
				inlineEditor.className = 'cell-inline-editor';
				inlineEditor.rows = 1;
				inlineEditor.spellcheck = false;
				inlineEditor.setAttribute('aria-label', `Editar ${columnName(column)}${sourceRow + 1}`);
				inlineEditor.value = inlineEditValue;
				inlineEditor.addEventListener('input', () => {
					setInlineEditValue(inlineEditor.value);
					setInlineEditorDirty(true);
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
			if (isSelected(sourceRow, column)) {
				valueCell.classList.add('selected-cell');
			}
			if (isActiveSearchMatch(sourceRow, column)) {
				valueCell.classList.add('active-search-match');
			}
			valueCell.addEventListener('click', () => {
				gridScroll.focus({ preventScroll: true });
				selectCell(sourceRow, column);
			});
			valueCell.addEventListener('dblclick', () => beginInlineEdit(sourceRow, column));
			row.append(valueCell);
		}
		rowsViewport.append(row);
	}
	state.rowsViewport = rowsViewport;
	state.renderedColumnCount = renderedColumnCount;
}

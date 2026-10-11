import type { CsvDataMessage, FormulaEvaluation, XlsxDataMessage } from '../protocol';

import type { CellPosition, CellRange } from '../range-selection';
export type { CellPosition, CellRange } from '../range-selection';

export interface CellSelectionContext {
	snapshot: CsvDataMessage | XlsxDataMessage | undefined;
	selectedCell: CellPosition | undefined;
	setSelectedCell(position: CellPosition): void;
	commitSelectedEdit(): void;
	columnName(index: number): string;
	getFormulaResult(row: number, column: number): FormulaEvaluation | undefined;
	getFormulaCache(row: number, column: number): string;
	cellReference: HTMLElement; cellReferenceInput: HTMLInputElement;
	cellState: HTMLParagraphElement; cellValue: HTMLPreElement;
	cellEditor: HTMLTextAreaElement; applyCellEditButton: HTMLButtonElement;
	setEditorDirty(value: boolean): void;
	ensureSelectionVisible(row: number, column: number): void;
	renderGrid(): void;
}

export function selectGridCell(context: CellSelectionContext, row: number, column: number): void {
	const { snapshot } = context;
	if (!snapshot) {return;}
	if (context.selectedCell && (context.selectedCell.row !== row || context.selectedCell.column !== column)) {
		context.commitSelectedEdit();
	}
	context.setSelectedCell({ row, column });
	const reference = `${context.columnName(column)}${row + 1}`;
	context.cellReference.textContent = reference;
	context.cellReferenceInput.value = reference;
	const values = snapshot.rows[row]!;
	const exists = column < values.length;
	const kind = snapshot.type === 'xlsxData' ? snapshot.cellKinds[row]?.[column] : undefined;
	const capability = snapshot.type === 'xlsxData' ? snapshot.cellCapabilities[row]?.[column] : undefined;
	const result = kind === 'formula' ? context.getFormulaResult(row, column) : undefined;
	context.cellState.textContent = kind === 'formula'
		? snapshot.type === 'xlsxData' && snapshot.fileFormat === 'ods' ? 'Fórmula (no recalculada)'
			: result?.status === 'calculated' ? 'Fórmula (calculada)'
			: result?.status === 'unsupported' ? unsupportedFormulaLabel(result.reason)
				: result ? 'Fórmula (error de cálculo)' : 'Calculando fórmula…'
		: kind === 'empty' || (exists && values[column] === '')
			? 'Celda vacía almacenada'
			: kind === 'missing' || !exists ? 'Celda ausente' : 'Valor crudo';
	if (snapshot.type === 'csvData' && snapshot.physicalLines?.[row]) {
		context.cellState.textContent += ` · Registro ${row + 1}, línea física ${snapshot.physicalLines[row]}`;
	}
	if (capability?.reason) {context.cellState.textContent += ` · ${capability.reason}`;}
	context.cellState.dataset.state = kind === 'formula'
		? snapshot.type === 'xlsxData' && snapshot.fileFormat === 'ods' ? 'formula'
			: result?.status ?? 'calculating'
		: kind === 'empty' || kind === 'missing' || !exists ? 'empty' : 'raw';
	context.cellValue.textContent = exists ? values[column]! : '';
	if (snapshot.type === 'csvData' && snapshot.rowKinds?.[row] === 'comment') {
		context.cellValue.textContent = snapshot.rowComments?.[row] ?? '';
		context.cellState.textContent = 'Registro de comentario';
		if (snapshot.physicalLines?.[row]) {context.cellState.textContent += ` · Registro ${row + 1}, línea física ${snapshot.physicalLines[row]}`;}
	}
	if (kind === 'formula') {
		const cache = context.getFormulaCache(row, column) || 'Sin valor almacenado';
		context.cellValue.textContent += `\nValor almacenado en caché: ${cache}`;
		if (result?.status === 'calculated') {context.cellValue.textContent += `\n\nFórmula (calculada)\n${result.value}`;}
		else if (snapshot.type === 'xlsxData' && snapshot.fileFormat === 'ods') {context.cellValue.textContent += '\n\nFórmula (no recalculada)';}
		else if (result?.status === 'unsupported') {context.cellValue.textContent += `\n\n${unsupportedFormulaLabel(result.reason)}`;}
		else if (result) {context.cellValue.textContent += `\n\nError al calcular: ${result.value}`;}
		else {context.cellValue.textContent += '\n\nCalculando fórmula…';}
	}
	if (snapshot.type === 'xlsxData') {
		const note = snapshot.cellNotes?.find(item => item.reference.toUpperCase() === reference);
		const hyperlink = snapshot.cellHyperlinks?.find(item => item.reference.toUpperCase() === reference);
		if (note) {
			context.cellState.textContent += ' · Tiene una nota';
			context.cellValue.textContent += `\n\nNota${note.author ? ` (${note.author})` : ''}\n${note.text}`;
		}
		if (hyperlink) {
			context.cellState.textContent += ' · Tiene un vínculo';
			context.cellValue.textContent += `\n\nVínculo (texto sin abrir)\n${hyperlink.target ?? ''}${hyperlink.location ? `#${hyperlink.location}` : ''}`;
		}
	}
	context.cellEditor.value = exists ? values[column]! : '';
	context.setEditorDirty(false);
	context.cellEditor.disabled = snapshot.readonly === true
		|| (snapshot.type === 'csvData' && snapshot.rowKinds?.[row] === 'comment')
		|| (capability ? !capability.editable : false);
	context.applyCellEditButton.disabled = context.cellEditor.disabled;
	context.ensureSelectionVisible(row, column);
	context.renderGrid();
}

function unsupportedFormulaLabel(reason: FormulaEvaluation['reason']): string {
	switch (reason) {
		case 'spill': return 'Fórmula NO compatible: requiere un resultado matricial derramado.';
		case 'date-format': return 'Fórmula NO compatible: el motor formatea esta fecha de forma incorrecta.';
		case 'date-system': return 'Fórmula NO compatible: no respeta el sistema de fechas 1904 del libro.';
		default: return 'Fórmula NO compatible: función no implementada.';
	}
}

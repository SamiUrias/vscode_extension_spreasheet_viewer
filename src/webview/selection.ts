import type { CsvDataMessage, FormulaEvaluation, XlsxDataMessage } from '../protocol';

import type { CellPosition, CellRange } from '../range-selection';
import { t } from '../i18n';
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
		? snapshot.type === 'xlsxData' && (snapshot.fileFormat === 'ods' || snapshot.fileFormat === 'xlsm') ? t('webview.formula.notRecalculated')
			: result?.status === 'calculated' ? t('webview.formula.result')
			: result?.status === 'unsupported' ? unsupportedFormulaLabel(result.reason)
				: result ? t('webview.formula.error', result.value) : t('webview.formula.calculating')
		: kind === 'empty' || (exists && values[column] === '')
			? t('webview.formula.cellEmpty')
			: kind === 'missing' || !exists ? t('webview.formula.cellMissing') : t('webview.formula.rawValue');
	if (snapshot.type === 'csvData' && snapshot.physicalLines?.[row]) {
		context.cellState.textContent += ` · ${t('webview.formula.recordLine', row + 1, snapshot.physicalLines[row])}`;
	}
	if (capability?.reason) {context.cellState.textContent += ` · ${capability.reason}`;}
	context.cellState.dataset.state = kind === 'formula'
		? snapshot.type === 'xlsxData' && (snapshot.fileFormat === 'ods' || snapshot.fileFormat === 'xlsm') ? 'formula'
			: result?.status ?? 'calculating'
		: kind === 'empty' || kind === 'missing' || !exists ? 'empty' : 'raw';
	context.cellValue.textContent = exists ? values[column]! : '';
	if (snapshot.type === 'csvData' && snapshot.rowKinds?.[row] === 'comment') {
		context.cellValue.textContent = snapshot.rowComments?.[row] ?? '';
		context.cellState.textContent = t('webview.formula.commentRecord');
		if (snapshot.physicalLines?.[row]) {context.cellState.textContent += ` · ${t('webview.formula.recordLine', row + 1, snapshot.physicalLines[row])}`;}
	}
	if (kind === 'formula') {
		const cache = context.getFormulaCache(row, column) || t('webview.formula.stored');
		context.cellValue.textContent += `\n${t('webview.formula.cache')}: ${cache}`;
		if (result?.status === 'calculated') {context.cellValue.textContent += `\n\n${t('webview.formula.result')}\n${result.value}`;}
		else if (snapshot.type === 'xlsxData' && (snapshot.fileFormat === 'ods' || snapshot.fileFormat === 'xlsm')) {context.cellValue.textContent += `\n\n${t('webview.formula.notRecalculated')}`;}
		else if (result?.status === 'unsupported') {context.cellValue.textContent += `\n\n${unsupportedFormulaLabel(result.reason)}`;}
		else if (result) {context.cellValue.textContent += `\n\n${t('webview.formula.error', result.value)}`;}
		else {context.cellValue.textContent += `\n\n${t('webview.formula.calculating')}`;}
	}
	if (snapshot.type === 'xlsxData') {
		const note = snapshot.cellNotes?.find(item => item.reference.toUpperCase() === reference);
		const hyperlink = snapshot.cellHyperlinks?.find(item => item.reference.toUpperCase() === reference);
		if (note) {
			context.cellState.textContent += ` · ${t('webview.formula.notePresent')}`;
			context.cellValue.textContent += `\n\n${t('webview.formula.note')}${note.author ? ` (${note.author})` : ''}\n${note.text}`;
		}
		if (hyperlink) {
			context.cellState.textContent += ` · ${t('webview.formula.linkPresent')}`;
			context.cellValue.textContent += `\n\n${t('webview.formula.link')}\n${hyperlink.target ?? ''}${hyperlink.location ? `#${hyperlink.location}` : ''}`;
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
		case 'spill': return t('webview.formula.unsupported', t('webview.formula.unsupportedSpill'));
		case 'date-format': return t('webview.formula.unsupported', t('webview.formula.unsupportedDateFormat'));
		case 'date-system': return t('webview.formula.unsupported', t('webview.formula.unsupportedDateSystem'));
		default: return t('webview.formula.unsupported', t('webview.formula.unsupportedFunction'));
	}
}

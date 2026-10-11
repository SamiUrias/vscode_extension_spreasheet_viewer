import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { unzipSync, zipSync } from 'fflate';
import { parseCellRangeBounds } from '../cell-reference';
import { parseXlsxBytes, type XlsxSheet, type XlsxWorkbook } from './xlsx';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const BUILTIN_FORMATS: Record<string, number> = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, 'mm-dd-yy': 14 };

export type XlsxStyleOperation =
	| { readonly kind: 'format'; readonly sheetIndex: number; readonly startRow: number; readonly startColumn: number; readonly endRow: number; readonly endColumn: number; readonly property: 'bold' | 'italic' | 'wrapText'; readonly value?: boolean }
	| { readonly kind: 'alignment'; readonly sheetIndex: number; readonly startRow: number; readonly startColumn: number; readonly endRow: number; readonly endColumn: number; readonly value: 'general' | 'left' | 'center' | 'right' }
	| { readonly kind: 'numberFormat'; readonly sheetIndex: number; readonly startRow: number; readonly startColumn: number; readonly endRow: number; readonly endColumn: number; readonly value: keyof typeof BUILTIN_FORMATS }
	| { readonly kind: 'merge' | 'unmerge'; readonly sheetIndex: number; readonly startRow: number; readonly startColumn: number; readonly endRow: number; readonly endColumn: number }
	| { readonly kind: 'freeze'; readonly sheetIndex: number; readonly rows: number; readonly columns: number };
type CellFormattingOperation = Extract<XlsxStyleOperation, { readonly kind: 'format' | 'alignment' | 'numberFormat' }>;

export interface XlsxStyleSnapshot { readonly before: Uint8Array; readonly after: Uint8Array; readonly operation: XlsxStyleOperation; }

export function applyXlsxStyleOperation(bytes: Uint8Array, operation: XlsxStyleOperation): XlsxStyleSnapshot {
	const workbook = parseXlsxBytes(bytes);
	assertBaseProfile(workbook);
	const sheet = workbook.sheets[operation.sheetIndex];
	if (!sheet || sheet.metadata?.protected) {throw new Error('La hoja XLSX no existe o está protegida.');}
	const files = unzipSync(bytes);
	const workbookXml = parseXml(required(files, 'xl/workbook.xml'), 'xl/workbook.xml');
	const relationships = parseXml(required(files, 'xl/_rels/workbook.xml.rels'), 'xl/_rels/workbook.xml.rels');
	const sheetNode = directChildren(descendants(requireRoot(workbookXml, 'xl/workbook.xml'), 'sheets')[0] ?? requireRoot(workbookXml, 'xl/workbook.xml'), 'sheet')[operation.sheetIndex];
	const relationId = sheetNode?.getAttribute('r:id') ?? '';
	const relation = descendants(relationships, 'Relationship').find(item => item.getAttribute('Id') === relationId);
	const target = relation?.getAttribute('Target');
	if (!target || relation?.getAttribute('TargetMode')?.toLowerCase() === 'external') {throw new Error('No se pudo resolver la hoja XLSX seleccionada.');}
	const worksheetPath = resolvePart('xl/workbook.xml', target);
	const worksheet = parseXml(required(files, worksheetPath), worksheetPath);
	const root = requireRoot(worksheet, worksheetPath);
	if (descendants(root, 'extLst').length || descendants(root, 'tableParts').length || descendants(root, 'drawing').length
		|| descendants(root, 'hyperlinks').length || descendants(root, 'dataValidations').length) {
		throw new Error('La hoja contiene tablas, vínculos o extensiones que esta operación no actualiza.');
	}
	const range = operation.kind === 'freeze' ? undefined : validateRange(operation, sheet);
	if (operation.kind === 'freeze') {
		if (!Number.isSafeInteger(operation.rows) || !Number.isSafeInteger(operation.columns) || operation.rows < 0 || operation.columns < 0
			|| operation.rows > sheet.rowCount || operation.columns > sheet.columnCount) {throw new Error('La cantidad de filas o columnas fijas está fuera de la hoja.');}
		applyFreezePane(worksheet, root, operation.rows, operation.columns);
	} else if (operation.kind === 'merge' || operation.kind === 'unmerge') {
		if (operation.kind === 'merge' && (workbook.definedNames?.length || workbook.sheets.some(item => item.cellTypes.some(row => row.includes('formula'))))) {
			throw new Error('Combinar celdas requiere un libro sin fórmulas ni nombres definidos en esta etapa.');
		}
		applyMergeOperation(sheet, worksheet, root, operation, range!);
	} else {
		if ((sheet.metadata?.mergedRanges ?? []).some(reference => overlaps(parseCellRangeBounds(reference), range!))) {throw new Error('El rango de formato cruza celdas combinadas.');}
		if (descendants(worksheet, 'conditionalFormatting').length) {throw new Error('La hoja tiene formato condicional que esta operación no actualiza.');}
		if (descendants(worksheet, 'rPr').length || files['xl/sharedStrings.xml'] && descendants(parseXml(files['xl/sharedStrings.xml']!, 'xl/sharedStrings.xml'), 'rPr').length) {throw new Error('El libro contiene texto enriquecido que esta operación no modifica.');}
		const styles = parseXml(required(files, 'xl/styles.xml'), 'xl/styles.xml');
		applyCellFormatting(workbook, sheet, worksheet, root, styles, operation as CellFormattingOperation, range!);
		files['xl/styles.xml'] = encodeXml(styles);
	}
	files[worksheetPath] = encodeXml(worksheet);
	const after = zipSync(files);
	const reopened = parseXlsxBytes(after);
	if (operation.kind === 'merge' && !reopened.sheets[operation.sheetIndex]?.metadata?.mergedRanges.includes(range!.reference)) {throw new Error('La combinación no pasó la validación de lectura posterior.');}
	if (operation.kind === 'freeze') {
		const pane = reopened.sheets[operation.sheetIndex]?.metadata?.frozenPane;
		if (operation.rows + operation.columns > 0 && (!pane || pane.ySplit !== operation.rows || pane.xSplit !== operation.columns)) {throw new Error('Los paneles fijos no pasaron la validación de lectura posterior.');}
	}
	return { before: bytes.slice(), after, operation: { ...operation } };
}

interface Range { readonly startRow: number; readonly startColumn: number; readonly endRow: number; readonly endColumn: number; readonly reference: string; }
function validateRange(operation: Exclude<XlsxStyleOperation, { kind: 'freeze' }>, sheet: XlsxSheet): Range {
	const values = [operation.startRow, operation.startColumn, operation.endRow, operation.endColumn];
	if (!values.every(Number.isSafeInteger) || operation.startRow < 0 || operation.startColumn < 0 || operation.endRow < operation.startRow
		|| operation.endColumn < operation.startColumn || operation.endRow >= sheet.rowCount || operation.endColumn >= sheet.columnCount
		|| (operation.endRow - operation.startRow + 1) * (operation.endColumn - operation.startColumn + 1) > 100_000) {
		throw new Error('El rango está fuera de la hoja o supera el límite de 100 000 celdas.');
	}
	return { startRow: operation.startRow, startColumn: operation.startColumn, endRow: operation.endRow, endColumn: operation.endColumn,
		reference: `${columnName(operation.startColumn + 1)}${operation.startRow + 1}:${columnName(operation.endColumn + 1)}${operation.endRow + 1}` };
}

function applyCellFormatting(workbook: XlsxWorkbook, sheet: XlsxSheet, worksheet: Document, root: Element, styles: Document,
	operation: CellFormattingOperation, range: Range): void {
	const fonts = directChildren(descendants(styles, 'fonts')[0]!, 'font');
	const cellXfs = directChildren(descendants(styles, 'cellXfs')[0]!, 'xf');
	if (!fonts.length || !cellXfs.length) {throw new Error('El XLSX no contiene una colección de estilos que se pueda extender con seguridad.');}
	const targets = coordinates(range);
	let desired: boolean | undefined;
	if (operation.kind === 'format' && operation.value === undefined) {
		const getFlag = (row: number, column: number) => Boolean(workbook.styles?.cellVisualStyles[sheet.cellStyleIndexes?.[row]?.[column] ?? 0]?.[operation.property]);
		desired = !targets.every(cell => getFlag(cell.row, cell.column));
	}
	const sheetData = directChildren(root, 'sheetData')[0];
	if (!sheetData) {throw new Error('La hoja no contiene sheetData.');}
	for (const cell of targets) {
		const cellNode = getOrCreateCell(worksheet, sheetData, cell.row, cell.column);
		const styleIndex = parseIndex(cellNode.getAttribute('s')) ?? 0;
		const sourceXf = cellXfs[styleIndex];
		if (!sourceXf) {throw new Error(`La celda usa el estilo inexistente ${styleIndex}.`);}
		const nextXf = sourceXf.cloneNode(true) as Element;
		if (operation.kind === 'format') {
			if (operation.property === 'bold' || operation.property === 'italic') {
				const fontIndex = parseIndex(sourceXf.getAttribute('fontId')) ?? 0;
				const oldFont = fonts[fontIndex];
				if (!oldFont) {throw new Error(`El estilo usa la fuente inexistente ${fontIndex}.`);}
				const nextFont = oldFont.cloneNode(true) as Element;
				setBooleanChild(styles, nextFont, operation.property === 'bold' ? 'b' : 'i', operation.value ?? desired!);
				const fontId = getOrAppendEquivalent(descendants(styles, 'fonts')[0]!, nextFont, 'font');
				nextXf.setAttribute('fontId', String(fontId)); nextXf.setAttribute('applyFont', '1');
			} else {
				const alignment = directChildren(nextXf, 'alignment')[0] ?? styles.createElementNS(MAIN_NS, 'alignment');
				alignment.setAttribute('wrapText', String(operation.value ?? desired!) === 'true' ? '1' : '0');
				if (!alignment.parentNode) {insertOrderedChild(nextXf, alignment, ['alignment', 'protection', 'extLst']);}
				nextXf.setAttribute('applyAlignment', '1');
			}
		} else if (operation.kind === 'alignment') {
			const alignment = directChildren(nextXf, 'alignment')[0] ?? styles.createElementNS(MAIN_NS, 'alignment');
			if (operation.value === 'general') {alignment.removeAttribute('horizontal');} else {alignment.setAttribute('horizontal', operation.value);}
			if (!alignment.parentNode) {insertOrderedChild(nextXf, alignment, ['alignment', 'protection', 'extLst']);}
			nextXf.setAttribute('applyAlignment', '1');
		} else {
			nextXf.setAttribute('numFmtId', String(BUILTIN_FORMATS[operation.value])); nextXf.setAttribute('applyNumberFormat', '1');
		}
		const styleId = getOrAppendEquivalent(descendants(styles, 'cellXfs')[0]!, nextXf, 'xf');
		cellNode.setAttribute('s', String(styleId));
	}
	descendants(styles, 'fonts')[0]!.setAttribute('count', String(directChildren(descendants(styles, 'fonts')[0]!, 'font').length));
	descendants(styles, 'cellXfs')[0]!.setAttribute('count', String(directChildren(descendants(styles, 'cellXfs')[0]!, 'xf').length));
}

function applyMergeOperation(sheet: XlsxSheet, worksheet: Document, root: Element,
	operation: Extract<XlsxStyleOperation, { kind: 'merge' | 'unmerge' }>, range: Range): void {
	const existing = sheet.metadata?.mergedRanges ?? [];
	if (operation.kind === 'merge') {
		if (range.startRow === range.endRow && range.startColumn === range.endColumn) {throw new Error('Selecciona al menos dos celdas para combinarlas.');}
		if (existing.some(reference => overlaps(parseCellRangeBounds(reference), range))) {throw new Error('El rango se cruza con una combinación existente.');}
		for (let row = range.startRow; row <= range.endRow; row++) {for (let column = range.startColumn; column <= range.endColumn; column++) {
			if (row === range.startRow && column === range.startColumn) {continue;}
			const type = sheet.cellTypes[row]?.[column] ?? 'missing';
			if (!['missing', 'empty'].includes(type) || (sheet.rows[row]?.[column] ?? '') !== '') {throw new Error('Solo se combinan celdas vacías además del ancla; borra primero el contenido cubierto.');}
		}}
		let container = directChildren(root, 'mergeCells')[0];
		if (!container) {container = worksheet.createElementNS(MAIN_NS, 'mergeCells'); insertAfterSheetData(root, container);}
		const node = worksheet.createElementNS(MAIN_NS, 'mergeCell'); node.setAttribute('ref', range.reference); container.appendChild(node);
		container.setAttribute('count', String(directChildren(container, 'mergeCell').length));
	} else {
		const container = directChildren(root, 'mergeCells')[0];
		const node = container && directChildren(container, 'mergeCell').find(item => normalizeRange(item.getAttribute('ref') ?? '') === range.reference);
		if (!node) {throw new Error('El rango seleccionado no coincide con una combinación existente.');}
		container!.removeChild(node);
		if (!directChildren(container!, 'mergeCell').length) {root.removeChild(container!);}
		else {container!.setAttribute('count', String(directChildren(container!, 'mergeCell').length));}
	}
}

function applyFreezePane(document: Document, root: Element, rows: number, columns: number): void {
	let views = directChildren(root, 'sheetViews')[0];
	if (!views) {views = document.createElementNS(MAIN_NS, 'sheetViews'); insertBeforeSheetFormat(root, views);}
	const sheets = directChildren(views, 'sheetView');
	if (sheets.length > 1) {throw new Error('No se modifican libros con múltiples vistas de hoja en esta etapa.');}
	let view = sheets[0];
	if (!view) {view = document.createElementNS(MAIN_NS, 'sheetView'); view.setAttribute('workbookViewId', '0'); views.appendChild(view);}
	const selections = directChildren(view, 'selection');
	if (selections.length > 1) {throw new Error('No se modifican vistas con selecciones guardadas en varios paneles.');}
	let selection = selections[0];
	const priorPane = directChildren(view, 'pane')[0];
	if (priorPane) {view.removeChild(priorPane);}
	selection?.removeAttribute('pane');
	if (rows === 0 && columns === 0) {return;}
	const pane = document.createElementNS(MAIN_NS, 'pane');
	if (columns) {pane.setAttribute('xSplit', String(columns));}
	if (rows) {pane.setAttribute('ySplit', String(rows));}
	pane.setAttribute('topLeftCell', `${columnName(columns + 1)}${rows + 1}`);
	let activePane = rows && columns ? 'bottomRight' : rows ? 'bottomLeft' : 'topRight';
	const selectedCell = parseCellCoordinate(selection?.getAttribute('activeCell') ?? '');
	if (selectedCell) {
		const bottom = rows > 0 && selectedCell.row > rows;
		const right = columns > 0 && selectedCell.column > columns;
		activePane = bottom ? right ? 'bottomRight' : 'bottomLeft' : right ? 'topRight' : 'topLeft';
	}
	pane.setAttribute('activePane', activePane); pane.setAttribute('state', 'frozen');
	view.insertBefore(pane, selection ?? null);
	if (!selection) {selection = document.createElementNS(MAIN_NS, 'selection'); view.appendChild(selection);}
	selection.setAttribute('pane', activePane);
	if (!selection.hasAttribute('activeCell')) {selection.setAttribute('activeCell', `${columnName(columns + 1)}${rows + 1}`);}
	if (!selection.hasAttribute('sqref')) {selection.setAttribute('sqref', selection.getAttribute('activeCell') ?? `${columnName(columns + 1)}${rows + 1}`);}
}

function assertBaseProfile(workbook: XlsxWorkbook): void {
	if (workbook.macroEnabled || workbook.hasVbaProject || workbook.hasDigitalSignatures) {throw new Error('El libro contiene macros o firmas y no admite cambios de formato.');}
	if (workbook.unknownParts?.length || workbook.hasExternalReferences) {throw new Error('El libro contiene partes o referencias que esta operación no puede validar.');}
	for (const sheet of workbook.sheets) {
		if (sheet.cellTypes.some(row => row.includes('unsupported')) || sheet.metadata?.hasDrawings || sheet.metadata?.hasNotes || sheet.metadata?.hyperlinkCount || sheet.metadata?.tableCount) {
			throw new Error('El libro contiene celdas o estructuras que esta operación no puede preservar con seguridad.');
		}
	}
}

function getOrCreateCell(document: Document, sheetData: Element, row: number, column: number): Element {
	const rowNumber = row + 1;
	let rowNode = directChildren(sheetData, 'row').find(item => Number(item.getAttribute('r')) === rowNumber);
	if (!rowNode) {rowNode = document.createElementNS(MAIN_NS, 'row'); rowNode.setAttribute('r', String(rowNumber)); insertSorted(sheetData, rowNode, item => Number(item.getAttribute('r')));}
	const reference = `${columnName(column + 1)}${rowNumber}`;
	let cell = directChildren(rowNode, 'c').find(item => item.getAttribute('r') === reference);
	if (!cell) {cell = document.createElementNS(MAIN_NS, 'c'); cell.setAttribute('r', reference); insertSorted(rowNode, cell, item => columnNumber((item.getAttribute('r') ?? '').replace(/\d+$/, '')));}
	return cell;
}
function setBooleanChild(document: Document, font: Element, name: 'b' | 'i', value: boolean): void {
	let node = directChildren(font, name)[0];
	if (value) {if (!node) {node = document.createElementNS(MAIN_NS, name); insertOrderedChild(font, node, ['name', 'charset', 'family', 'b', 'i', 'strike', 'outline', 'shadow', 'condense', 'extend', 'color', 'sz', 'u', 'vertAlign', 'scheme']);} node.removeAttribute('val');}
	else if (node) {font.removeChild(node);}
}
function insertOrderedChild(parent: Element, node: Element, order: readonly string[]): void {
	const rank = order.indexOf(node.localName ?? node.nodeName);
	const next = Array.from(parent.childNodes).find((item): item is Element => item.nodeType === 1 && order.indexOf((item as Element).localName ?? '') > rank);
	parent.insertBefore(node, next ?? null);
}
function getOrAppendEquivalent(parent: Element, candidate: Element, name: string): number {
	const serializer = new XMLSerializer(); const value = serializer.serializeToString(candidate);
	const existing = directChildren(parent, name); const index = existing.findIndex(item => serializer.serializeToString(item) === value);
	if (index >= 0) {return index;}
	parent.appendChild(candidate); return existing.length;
}
function coordinates(range: Range): Array<{ row: number; column: number }> {
	const result: Array<{ row: number; column: number }> = [];
	for (let row = range.startRow; row <= range.endRow; row++) {for (let column = range.startColumn; column <= range.endColumn; column++) {result.push({ row, column });}}
	return result;
}
function overlaps(bounds: ReturnType<typeof parseCellRangeBounds>, range: Range): boolean {
	return Boolean(bounds && bounds.top <= range.endRow && range.startRow <= bounds.bottom && bounds.left <= range.endColumn && range.startColumn <= bounds.right);
}
function normalizeRange(value: string): string {return value.split(':').map(part => part.replaceAll('$', '').toUpperCase()).join(':');}
function insertAfterSheetData(root: Element, node: Element): void {
	if (!directChildren(root, 'sheetData')[0]) {throw new Error('La hoja no contiene sheetData.');}
	const order = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];
	const rank = order.indexOf('mergeCells');
	const next = Array.from(root.childNodes).find((item): item is Element => item.nodeType === 1 && order.indexOf((item as Element).localName ?? '') > rank);
	root.insertBefore(node, next ?? null);
}
function insertBeforeSheetFormat(root: Element, node: Element): void {const next = ['sheetFormatPr', 'cols', 'sheetData'].map(name => directChildren(root, name)[0]).find(Boolean); root.insertBefore(node, next ?? null);}
function insertSorted(parent: Element, node: Element, value: (node: Element) => number): void {
	const next = directChildren(parent, node.localName ?? node.nodeName).find(item => value(item) > value(node)); parent.insertBefore(node, next ?? null);
}
function columnName(column: number): string {let value = ''; for (; column > 0; column = Math.floor((column - 1) / 26)) {value = String.fromCharCode(65 + (column - 1) % 26) + value;} return value;}
function columnNumber(value: string): number {let result = 0; for (const character of value.toUpperCase()) {result = result * 26 + character.charCodeAt(0) - 64;} return result;}
function parseCellCoordinate(value: string): { row: number; column: number } | undefined {
	const match = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(value);
	if (!match) {return undefined;}
	const row = Number(match[2]), column = columnNumber(match[1]!);
	return Number.isSafeInteger(row) && row > 0 && column > 0 ? { row, column } : undefined;
}
function parseIndex(value: string | null): number | undefined {if (!value || !/^\d+$/.test(value)) {return undefined;} const result = Number(value); return Number.isSafeInteger(result) ? result : undefined;}
function resolvePart(source: string, target: string): string {
	const parts = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
	for (const component of target.replaceAll('\\', '/').replace(/^\//, '').split('/')) {if (!component || component === '.') {continue;} if (component === '..') {parts.pop();} else {parts.push(component);}}
	return parts.join('/');
}
function required(files: Record<string, Uint8Array>, path: string): Uint8Array {const bytes = files[path]; if (!bytes) {throw new Error(`Falta la parte ${path}.`);} return bytes;}
function parseXml(bytes: Uint8Array, path: string): Document {
	const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (/<!DOCTYPE|<!ENTITY/i.test(text)) {throw new Error(`${path} contiene declaraciones XML no permitidas.`);}
	let error: string | undefined; const result = new DOMParser({ onError: (_level, message) => {error ??= message;} }).parseFromString(text, 'application/xml');
	if (error || !result.documentElement) {throw new Error(`XML inválido en ${path}: ${error ?? 'documento vacío'}`);} return result;
}
function encodeXml(document: Document): Uint8Array<ArrayBuffer> {return new TextEncoder().encode(new XMLSerializer().serializeToString(document));}
function requireRoot(document: Document, path: string): Element {if (!document.documentElement) {throw new Error(`Falta el elemento raíz de ${path}.`);} return document.documentElement;}
function descendants(parent: Document | Element, name: string): Element[] {return Array.from(parent.getElementsByTagName('*')).filter(node => (node.localName || node.nodeName.split(':').pop()) === name);}
function directChildren(parent: Element, name: string): Element[] {return Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1 && (node as Element).localName === name);}

import { t } from '../i18n';
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { XlsxCellEdit, XlsxCellKind, XlsxSheet, XlsxStoredType, XlsxWorkbook } from './xlsx';

export const MAX_ODS_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_PARTS = 10_000;
const MAX_SHEETS = 50;
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 256;
const MAX_RECTANGLE_CELLS = 1_000_000;
const MAX_PRESENT_CELLS = 500_000;
const ODS_MIMETYPE = 'application/vnd.oasis.opendocument.spreadsheet';
const TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';

export interface OdsSheetMetadata {
	readonly state: 'visible' | 'hidden';
	readonly protected: boolean;
	readonly styleName?: string;
	readonly mergedRanges: string[];
	readonly rowGeometry: Array<{ readonly row: number; readonly repeated: number; readonly hidden: boolean; readonly styleName?: string }>;
	readonly columnGeometry: Array<{ readonly repeated: number; readonly hidden: boolean; readonly styleName?: string }>;
}

interface OdsSheet extends XlsxSheet { readonly odsMetadata?: OdsSheetMetadata; }
export interface OdsWorkbook extends XlsxWorkbook { readonly sheets: OdsSheet[]; }

/** Reads ODS table values and formula caches from content.xml without using display styles. */
export function parseOdsBytes(bytes: Uint8Array): OdsWorkbook {
	if (bytes.byteLength > MAX_ODS_BYTES) {throw new Error(`El ODS excede el límite de ${MAX_ODS_BYTES / (1024 * 1024)} MiB.`);}
	let expandedBytes = 0;
	let archiveParts = 0;
	const files = unzipSync(bytes, { filter: file => {
		archiveParts++;
		if (archiveParts > MAX_ARCHIVE_PARTS) {throw new Error(`El ODS excede el límite de ${MAX_ARCHIVE_PARTS.toLocaleString()} componentes.`);}
		expandedBytes += file.originalSize;
		if (expandedBytes > MAX_UNCOMPRESSED_BYTES) {throw new Error(`El ODS excede el límite de ${MAX_UNCOMPRESSED_BYTES / (1024 * 1024)} MiB descomprimidos.`);}
		return true;
	} });
	const mimetype = files.mimetype && decodeUtf8(files.mimetype, 'mimetype').trim();
	if (mimetype !== ODS_MIMETYPE) {throw new Error('El archivo no es una hoja de cálculo ODS válida.');}
	const content = files['content.xml'];
	if (!content) {throw new Error('El ODS no contiene content.xml.');}
	const xml = parseXml(content);
	const spreadsheet = descendants(xml.documentElement!, 'spreadsheet')[0];
	if (!spreadsheet) {throw new Error('El ODS no contiene una hoja de cálculo.');}
	const tables = childElements(spreadsheet).filter(node => local(node) === 'table');
	if (tables.length > MAX_SHEETS) {throw new Error(`El ODS excede el límite de ${MAX_SHEETS} hojas.`);}
	const warnings: string[] = [];
	const sheets: OdsSheet[] = [];
	let totalPresent = 0;
	for (let index = 0; index < tables.length; index++) {
		const sheet = parseSheet(tables[index]!, index, warnings);
		totalPresent += sheet.cellTypes.reduce((total, row) => total + row.filter(type => type !== 'missing').length, 0);
		if (totalPresent > MAX_PRESENT_CELLS) {throw new Error(`El ODS excede el límite de ${MAX_PRESENT_CELLS.toLocaleString()} celdas con datos.`);}
		sheets.push(sheet);
	}
	return { sheets, warnings };
}

/** Rewrites only content.xml and retains all other ODS package parts. */
export function serializeOdsEdits(bytes: Uint8Array, edits: readonly XlsxCellEdit[]): Uint8Array {
	if (!edits.length) {return bytes.slice();}
	const workbook = parseOdsBytes(bytes);
	const files = unzipSync(bytes);
	const content = files['content.xml'];
	if (!content) {throw new Error('El ODS no contiene content.xml.');}
	const xml = parseXml(content);
	const spreadsheet = descendants(xml.documentElement!, 'spreadsheet')[0];
	const tables = spreadsheet ? childElements(spreadsheet).filter(node => local(node) === 'table') : [];
	const bySheet = new Map<number, XlsxCellEdit[]>();
	for (const edit of edits) {
		const sheet = workbook.sheets[edit.sheetIndex];
		if (!sheet || !Number.isInteger(edit.row) || !Number.isInteger(edit.column) || edit.row < 0 || edit.column < 0
			|| edit.row >= sheet.rowCount || edit.column >= sheet.columnCount) {throw new Error('La celda ODS está fuera del rango actual.');}
		if (sheet.odsMetadata?.protected) {throw new Error('La hoja ODS está protegida y no se puede editar.');}
		if (sheet.cellTypes[edit.row]?.[edit.column] === 'formula' || sheet.cellTypes[edit.row]?.[edit.column] === 'error'
			|| sheet.cellTypes[edit.row]?.[edit.column] === 'unsupported' || sheet.cellTypes[edit.row]?.[edit.column] === 'duration') {throw new Error('Esta celda ODS no se puede editar de forma segura.');}
		validateValue(edit.type, edit.value);
		const sheetEdits = bySheet.get(edit.sheetIndex) ?? [];
		sheetEdits.push(edit);
		bySheet.set(edit.sheetIndex, sheetEdits);
	}
	for (const [sheetIndex, sheetEdits] of bySheet) {
		const table = tables[sheetIndex];
		if (!table) {throw new Error('No se pudo localizar la hoja ODS para editar.');}
		for (const edit of sheetEdits) {writeCell(xml, table, edit);}
	}
	files['content.xml'] = new TextEncoder().encode(new XMLSerializer().serializeToString(xml));
	// ODF requires the mimetype member to be first and stored without compression.
	const zipEntries: Zippable = { mimetype: [files.mimetype!, { level: 0 }] };
	for (const [name, data] of Object.entries(files)) {if (name !== 'mimetype') {zipEntries[name] = data;}}
	return zipSync(zipEntries);
}

function parseSheet(table: Element, index: number, warnings: string[]): OdsSheet {
	const name = table.getAttributeNS(TABLE_NS, 'name') || table.getAttribute('table:name') || `Hoja ${index + 1}`;
	const rowNodes = descendants(table, 'table-row').filter(row => nearestTable(row) === table);
	const mergedRanges: string[] = [];
	let geometryRow = 1;
	const rowGeometry = rowNodes.map(rowNode => {
		const repeated = positiveInteger(attr(rowNode, TABLE_NS, 'number-rows-repeated', 'table:number-rows-repeated') || '1', 'filas repetidas');
		const item = { row: geometryRow, repeated,
			hidden: attr(rowNode, TABLE_NS, 'visibility', 'table:visibility') === 'collapse',
			...(attr(rowNode, TABLE_NS, 'style-name', 'table:style-name') ? { styleName: attr(rowNode, TABLE_NS, 'style-name', 'table:style-name') } : {}),
		};
		geometryRow += repeated;
		return item;
	});
	const columnGeometry = descendants(table, 'table-column').filter(column => nearestTable(column) === table).map(column => ({
		repeated: positiveInteger(attr(column, TABLE_NS, 'number-columns-repeated', 'table:number-columns-repeated') || '1', 'columnas repetidas'),
		hidden: attr(column, TABLE_NS, 'visibility', 'table:visibility') === 'collapse',
		...(attr(column, TABLE_NS, 'style-name', 'table:style-name') ? { styleName: attr(column, TABLE_NS, 'style-name', 'table:style-name') } : {}),
	}));
	let sourceRowOffset = 0;
	let lastMeaningfulRow = 0;
	for (const rowNode of rowNodes) {
		const repeats = positiveInteger(attr(rowNode, TABLE_NS, 'number-rows-repeated', 'table:number-rows-repeated') || '1', 'filas repetidas');
		const meaningful = childElements(rowNode).some(cell => {
			if (local(cell) !== 'table-cell') {return false;}
			const { value } = cellValue(cell);
			return Boolean(attr(cell, TABLE_NS, 'formula', 'table:formula')) || value !== '';
		});
		if (meaningful) {lastMeaningfulRow = sourceRowOffset + repeats;}
		sourceRowOffset += repeats;
	}
	const cells = new Map<number, Map<number, { value: string; kind: XlsxCellKind; type: XlsxStoredType; cache?: string; ref: string }>>();
	let rowIndex = 0;
	let maxRow = 0;
	let maxColumn = 0;
	let presentCount = 0;
	for (const rowNode of rowNodes) {
		const sourceRepeatRows = positiveInteger(rowNode.getAttributeNS(TABLE_NS, 'number-rows-repeated') || rowNode.getAttribute('table:number-rows-repeated') || '1', 'filas repetidas');
		const repeatRows = Math.max(0, Math.min(sourceRepeatRows, lastMeaningfulRow - rowIndex));
		if (repeatRows === 0) {break;}
		if (rowIndex + repeatRows > MAX_ROWS) {throw new Error(`La hoja «${name}» excede el límite de ${MAX_ROWS} filas.`);}
		const rowCells = childElements(rowNode).filter(node => local(node) === 'table-cell' || local(node) === 'covered-table-cell');
		let columnIndex = 0;
		const values = new Map<number, { value: string; kind: XlsxCellKind; type: XlsxStoredType; cache?: string; ref: string }>();
		for (const cell of rowCells) {
			const repeatColumns = positiveInteger(cell.getAttributeNS(TABLE_NS, 'number-columns-repeated') || cell.getAttribute('table:number-columns-repeated') || '1', 'columnas repetidas');
			const columnSpan = positiveInteger(attr(cell, TABLE_NS, 'number-columns-spanned', 'table:number-columns-spanned') || '1', 'combinaciones de columnas');
			const rowSpan = positiveInteger(attr(cell, TABLE_NS, 'number-rows-spanned', 'table:number-rows-spanned') || '1', 'combinaciones de filas');
			if (columnSpan > 1 || rowSpan > 1) {
				const endRow = rowIndex + rowSpan;
				const endColumn = columnIndex + columnSpan;
				mergedRanges.push(`${columnName(columnIndex)}${rowIndex + 1}:${columnName(endColumn - 1)}${endRow}`);
			}
			if (columnIndex + repeatColumns > MAX_COLUMNS) {throw new Error(`La hoja «${name}» excede el límite de ${MAX_COLUMNS} columnas.`);}
				if (local(cell) === 'table-cell') {
				const formula = attr(cell, TABLE_NS, 'formula', 'table:formula');
				const { value, type } = cellValue(cell);
				const kind: XlsxCellKind = formula ? 'formula' : value === '' ? 'empty' : 'value';
				for (let column = columnIndex; column < columnIndex + repeatColumns; column++) {
					values.set(column, { value: formula ? formula : value, kind, type: formula ? 'formula' : type, ...(formula ? { cache: value } : {}), ref: `${columnName(column)}${rowIndex + 1}` });
				}
			} else {
				for (let column = columnIndex; column < columnIndex + repeatColumns; column++) {
					values.set(column, { value: '', kind: 'empty', type: 'unsupported', ref: `${columnName(column)}${rowIndex + 1}` });
				}
			}
			columnIndex += repeatColumns;
		}
		for (let repeat = 0; repeat < repeatRows; repeat++) {
			const currentRow = rowIndex + repeat;
			if (values.size) {
				const expanded = new Map<number, { value: string; kind: XlsxCellKind; type: XlsxStoredType; cache?: string; ref: string }>();
				for (const [column, cell] of values) {
					expanded.set(column, { ...cell, ...(cell.type === 'formula' ? { value: translateOdsFormula(cell.value, repeat) } : {}), ref: `${columnName(column)}${currentRow + 1}` });
				}
				cells.set(currentRow, expanded);
			}
			if (values.size) {maxColumn = Math.max(maxColumn, columnIndex); presentCount += values.size;}
		}
		rowIndex += repeatRows;
		if (values.size) {maxRow = rowIndex;}
		if (maxRow * maxColumn > MAX_RECTANGLE_CELLS || presentCount > MAX_PRESENT_CELLS) {throw new Error(`La hoja «${name}» excede el límite de celdas que se pueden mostrar.`);}
	}
	if (rowIndex > MAX_ROWS) {warnings.push(t('domain.ods.warning.repeatedRows', name));}
	const rows: string[][] = [];
	const cellKinds: XlsxCellKind[][] = [];
	const cellTypes: XlsxStoredType[][] = [];
	const formulaCaches: Record<string, string> = {};
	for (let row = 0; row < maxRow; row++) {
		const values = cells.get(row);
		const text: string[] = [];
		const kinds: XlsxCellKind[] = [];
		const types: XlsxStoredType[] = [];
		for (let column = 0; column < maxColumn; column++) {
			const cell = values?.get(column);
			text.push(cell?.value ?? '');
			kinds.push(cell?.kind ?? 'missing');
			types.push(cell?.type ?? 'missing');
			if (cell?.kind === 'formula') {formulaCaches[cell.ref] = cell.cache ?? '';}
		}
		rows.push(text); cellKinds.push(kinds); cellTypes.push(types);
	}
	const display = attr(table, TABLE_NS, 'display', 'table:display');
	const tableStyle = attr(table, TABLE_NS, 'style-name', 'table:style-name');
	return { name, rows, cellKinds, cellTypes, formulaCaches, rowCount: maxRow, columnCount: maxColumn,
		odsMetadata: { state: display === 'false' ? 'hidden' : 'visible', protected: attr(table, TABLE_NS, 'protected', 'table:protected') === 'true',
			...(tableStyle ? { styleName: tableStyle } : {}), mergedRanges, rowGeometry, columnGeometry } };
}

function translateOdsFormula(formula: string, rowOffset: number): string {
	if (!rowOffset) {return formula;}
	return formula.replace(/(\$?)(\.\$?[A-Z]{1,3}\$?)(\d+)/g, (match, abs: string, column: string, row: string) => {
		if (abs || column.includes('$')) {return match;}
		return `${abs}${column}${Number(row) + rowOffset}`;
	});
}

function cellValue(cell: Element): { value: string; type: XlsxStoredType } {
	const type = attr(cell, OFFICE_NS, 'value-type', 'office:value-type') || '';
	const value = attr(cell, OFFICE_NS, 'value', 'office:value')
		|| attr(cell, OFFICE_NS, 'date-value', 'office:date-value')
		|| attr(cell, OFFICE_NS, 'time-value', 'office:time-value')
		|| attr(cell, OFFICE_NS, 'boolean-value', 'office:boolean-value')
		|| attr(cell, OFFICE_NS, 'string-value', 'office:string-value');
	const paragraphText = descendants(cell, 'p').map(readParagraph).join('\n');
	if (type === 'float' || type === 'currency' || type === 'percentage') {return { value, type: 'number' };}
	if (type === 'date') {return { value: value || paragraphText, type: 'date' };}
	if (type === 'time') {return { value: value || paragraphText, type: 'duration' };}
	if (type === 'boolean') {return { value: value === 'true' ? '1' : value === 'false' ? '0' : value, type: 'boolean' };}
	if (type === 'string' || paragraphText) {return { value: paragraphText || value, type: 'string' };}
	if (type === '') {return { value: paragraphText || value, type: paragraphText ? 'string' : 'empty' };}
	return { value: value || paragraphText, type: 'unsupported' };
}

function writeCell(doc: Document, table: Element, edit: XlsxCellEdit): void {
	const rows = descendants(table, 'table-row').filter(row => nearestTable(row) === table);
	const row = materializeRepeated(rows, edit.row, 'number-rows-repeated');
	if (!row) {throw new Error('No se pudo materializar la fila ODS para editar.');}
	const cellNodes = childElements(row).filter(node => local(node) === 'table-cell' || local(node) === 'covered-table-cell');
	const cell = materializeRepeated(cellNodes, edit.column, 'number-columns-repeated');
	if (!cell) {throw new Error('No se pudo materializar la celda ODS para editar.');}
	for (let child = cell.firstChild; child;) {const next = child.nextSibling; cell.removeChild(child); child = next;}
	cell.removeAttributeNS(OFFICE_NS, 'value'); cell.removeAttribute('office:value');
	cell.removeAttributeNS(OFFICE_NS, 'date-value'); cell.removeAttribute('office:date-value');
	cell.removeAttributeNS(OFFICE_NS, 'time-value'); cell.removeAttribute('office:time-value');
	cell.removeAttributeNS(OFFICE_NS, 'boolean-value'); cell.removeAttribute('office:boolean-value');
	cell.removeAttributeNS(OFFICE_NS, 'string-value'); cell.removeAttribute('office:string-value');
	cell.removeAttributeNS(TABLE_NS, 'formula'); cell.removeAttribute('table:formula');
	if (edit.type === 'number') {
		cell.setAttributeNS(OFFICE_NS, 'office:value-type', 'float'); cell.setAttributeNS(OFFICE_NS, 'office:value', edit.value);
	} else if (edit.type === 'boolean') {
		cell.setAttributeNS(OFFICE_NS, 'office:value-type', 'boolean'); cell.setAttributeNS(OFFICE_NS, 'office:boolean-value', edit.value === '1' ? 'true' : 'false');
	} else if (edit.type === 'date') {
		cell.setAttributeNS(OFFICE_NS, 'office:value-type', 'date'); cell.setAttributeNS(OFFICE_NS, 'office:date-value', edit.value);
	} else {
		cell.setAttributeNS(OFFICE_NS, 'office:value-type', 'string');
		const paragraph = doc.createElementNS(TEXT_NS, 'text:p'); appendText(doc, paragraph, edit.value); cell.appendChild(paragraph);
	}
}

function readParagraph(paragraph: Element): string {
	let result = '';
	const visit = (node: Node): void => {
		if (node.nodeType === 3 || node.nodeType === 4) {result += node.nodeValue ?? ''; return;}
		if (node.nodeType !== 1) {return;}
		const element = node as Element;
		switch (local(element)) {
			case 's': {
				const countText = attr(element, TEXT_NS, 'c', 'text:c') || '1';
				const count = positiveInteger(countText, 'espacios ODF');
				if (count > MAX_ODS_BYTES) {throw new Error('Una celda ODS excede el límite de espacios consecutivos.');}
				result += ' '.repeat(count);
				return;
			}
			case 'tab': result += '\t'; return;
			case 'line-break': result += '\n'; return;
			default: for (let child = node.firstChild; child; child = child.nextSibling) {visit(child);}
		}
	};
	for (let child = paragraph.firstChild; child; child = child.nextSibling) {visit(child);}
	return result;
}

function appendText(doc: Document, paragraph: Element, value: string): void {
	let text = '';
	const flush = (): void => {if (text) {paragraph.appendChild(doc.createTextNode(text)); text = '';}};
	for (let index = 0; index < value.length;) {
		const character = value[index]!;
		if (character === ' ') {
			flush();
			let end = index + 1;
			while (value[end] === ' ') {end++;}
			const spaces = end - index;
			const node = doc.createElementNS(TEXT_NS, 'text:s');
			if (spaces > 1) {node.setAttributeNS(TEXT_NS, 'text:c', String(spaces));}
			paragraph.appendChild(node);
			index = end;
		} else if (character === '\t' || character === '\n') {
			flush();
			paragraph.appendChild(doc.createElementNS(TEXT_NS, character === '\t' ? 'text:tab' : 'text:line-break'));
			index++;
		} else {
			text += character;
			index++;
		}
	}
	flush();
}

function materializeRepeated(nodes: Element[], index: number, attrLocal: string): Element | undefined {
	let offset = 0;
	for (const node of nodes) {
		const repeats = positiveInteger(attr(node, TABLE_NS, attrLocal, `table:${attrLocal}`) || '1', 'celdas o filas repetidas');
		if (index < offset + repeats) {
			const inner = index - offset;
			if (repeats === 1) {return node;}
			const parent = node.parentNode;
			if (!parent) {return undefined;}
			const beforeCount = inner;
			const afterCount = repeats - inner - 1;
			if (beforeCount) {const before = node.cloneNode(true) as Element; setRepeat(before, attrLocal, beforeCount); parent.insertBefore(before, node);}
			const selected = node.cloneNode(true) as Element; selected.removeAttributeNS(TABLE_NS, attrLocal); selected.removeAttribute(`table:${attrLocal}`); parent.insertBefore(selected, node);
			if (afterCount) {const after = node.cloneNode(true) as Element; setRepeat(after, attrLocal, afterCount); parent.insertBefore(after, node);}
			parent.removeChild(node);
			return selected;
		}
		offset += repeats;
	}
	return undefined;
}

function setRepeat(node: Element, attrLocal: string, count: number): void {
	node.setAttributeNS(TABLE_NS, `table:${attrLocal}`, String(count));
}
function nearestTable(node: Node): Element | undefined {
	for (let parent = node.parentNode; parent; parent = parent.parentNode) {if (parent.nodeType === 1 && local(parent as Element) === 'table') {return parent as Element;}}
	return undefined;
}
function childElements(node: Node): Element[] {const result: Element[] = []; for (let child = node.firstChild; child; child = child.nextSibling) {if (child.nodeType === 1) {result.push(child as Element);}} return result;}
function descendants(node: Node, name: string): Element[] {return Array.from((node as Document | Element).getElementsByTagName('*')).filter(item => local(item) === name);}
function local(node: Element): string {return node.localName || node.nodeName.split(':').pop() || node.nodeName;}
function attr(node: Element, namespace: string, localName: string, qualified: string): string {return node.getAttributeNS(namespace, localName) || node.getAttribute(qualified) || '';}
function positiveInteger(value: string, label: string): number {const number = Number(value); if (!Number.isSafeInteger(number) || number < 1) {throw new Error(`Atributo de ${label} inválido.`);} return number;}
function parseXml(bytes: Uint8Array): Document {const text = decodeUtf8(bytes, 'content.xml'); if (/<!DOCTYPE|<!ENTITY/i.test(text)) {throw new Error('El XML ODS contiene declaraciones no admitidas.');} let error: string | undefined; const doc = new DOMParser({ onError: (_level, message) => {error ??= message;} }).parseFromString(text, 'application/xml'); if (error || !doc.documentElement) {throw new Error(`XML ODS inválido: ${error ?? 'documento vacío'}`);} return doc;}
function decodeUtf8(bytes: Uint8Array, part: string): string {try {return new TextDecoder('utf-8', { fatal: true }).decode(bytes);} catch {throw new Error(`La parte ${part} no contiene UTF-8 válido.`);}}
function columnName(column: number): string {let name = ''; for (let value = column + 1; value > 0;) {value--; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26);} return name;}
function validateValue(type: XlsxCellEdit['type'], value: string): void {if (type === 'number' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {throw new Error('Número ODS inválido.');} if (type === 'boolean' && value !== '0' && value !== '1') {throw new Error('Booleano ODS inválido.');} if (type === 'date' && !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {throw new Error('Fecha ODS inválida.');}}

import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { unzipSync, zipSync } from 'fflate';
import { parseXlsxBytes, type XlsxWorkbook } from './xlsx';

export type XlsxStructureOperation =
	| { readonly kind: 'insertRows' | 'deleteRows'; readonly sheetIndex: number; readonly index: number; readonly count: number }
	| { readonly kind: 'insertColumns' | 'deleteColumns'; readonly sheetIndex: number; readonly index: number; readonly count: number };

export interface XlsxStructureSnapshot { readonly before: Uint8Array; readonly after: Uint8Array; readonly operation: XlsxStructureOperation; }
export interface XlsxStructureCapability { readonly allowed: boolean; readonly reason?: string; }

export function getXlsxStructureCapability(bytes: Uint8Array): XlsxStructureCapability {
	try {
		const workbook = parseXlsxBytes(bytes);
		assertSupportedStructureProfile(workbook);
		const files = unzipSync(bytes);
		if (files['xl/calcChain.xml'] || files['xl/connections.xml'] || Object.keys(files).some(name => /^xl\/(?:queryTables|slicerCaches|slicers)\//i.test(name))) {
			throw new Error('El libro contiene conexiones o referencias de cálculo no compatibles.');
		}
		const workbookXml = files['xl/workbook.xml']; const relsXml = files['xl/_rels/workbook.xml.rels'];
		if (!workbookXml || !relsXml) {throw new Error('Falta la estructura de libro esperada.');}
		const book = parseXml(workbookXml, 'xl/workbook.xml'); const rels = parseXml(relsXml, 'xl/_rels/workbook.xml.rels');
		for (const sheet of descendants(book, 'sheet')) {
			const id = sheet.getAttribute('r:id') ?? '';
			const relation = descendants(rels, 'Relationship').find(item => item.getAttribute('Id') === id);
			const target = relation?.getAttribute('Target');
			const part = target ? files[resolveTarget(target)] : undefined;
			if (!part || relation?.getAttribute('TargetMode') === 'External') {throw new Error('No se pudo localizar una hoja interna del libro.');}
			const worksheet = parseXml(part, 'hoja XLSX');
			const unsupportedNodes = ['extLst', 'autoFilter', 'dataValidations', 'conditionalFormatting', 'tableParts', 'legacyDrawing', 'drawing', 'mergeCells', 'hyperlinks', 'sheetProtection'];
			if (unsupportedNodes.some(name => descendants(worksheet, name).length > 0)) {throw new Error('Una hoja contiene filtros, vínculos o extensiones que la operación no actualiza.');}
		}
		return { allowed: true };
	} catch (error) {
		return { allowed: false, reason: error instanceof Error ? error.message.replace(/^No se puede cambiar la estructura:\s*/, '') : 'El libro no cumple el perfil estructural seguro.' };
	}
}

/**
 * Small conservative profile for structural edits. This deliberately rejects any construct whose
 * references or coordinates are not rewritten by this module. The caller can retain `before` as
 * one reversible history snapshot.
 */
export function applyXlsxStructureOperation(bytes: Uint8Array, operation: XlsxStructureOperation): XlsxStructureSnapshot {
	const workbook = parseXlsxBytes(bytes);
	assertSupportedStructureProfile(workbook);
	const sheet = workbook.sheets[operation.sheetIndex];
	if (!sheet) {throw new Error('La hoja XLSX seleccionada ya no existe.');}
	if (!Number.isSafeInteger(operation.index) || operation.index < 0 || !Number.isSafeInteger(operation.count) || operation.count < 1) {
		throw new Error('La posición y la cantidad deben ser enteros válidos.');
	}
	const isRow = operation.kind === 'insertRows' || operation.kind === 'deleteRows';
	const limit = isRow ? 50_000 : 256;
	if (operation.index > (isRow ? sheet.rowCount : sheet.columnCount)
		|| operation.kind.startsWith('delete') && operation.index + operation.count > (isRow ? sheet.rowCount : sheet.columnCount)
		|| operation.kind.startsWith('insert') && (isRow ? sheet.rowCount : sheet.columnCount) + operation.count > limit) {
		throw new Error('La operación XLSX excede los límites de la hoja o queda fuera de su rango.');
	}
	const nextRows = isRow ? sheet.rowCount + (operation.kind === 'insertRows' ? operation.count : -operation.count) : sheet.rowCount;
	const nextColumns = isRow ? sheet.columnCount : sheet.columnCount + (operation.kind === 'insertColumns' ? operation.count : -operation.count);
	if (Math.max(1, nextRows) * Math.max(1, nextColumns) > 1_000_000) {throw new Error('La operación excede el límite de un millón de celdas.');}
	const files = unzipSync(bytes);
	if (files['xl/calcChain.xml'] || files['xl/connections.xml'] || Object.keys(files).some(name => /^xl\/(?:queryTables|slicerCaches|slicers)\//i.test(name))) {
		throw new Error('No se puede cambiar la estructura: el libro contiene conexiones o referencias de cálculo no compatibles.');
	}
	const workbookXml = files['xl/workbook.xml'];
	const relsXml = files['xl/_rels/workbook.xml.rels'];
	if (!workbookXml || !relsXml) {throw new Error('El XLSX no contiene la estructura de libro esperada.');}
	const book = parseXml(workbookXml, 'xl/workbook.xml');
	const rels = parseXml(relsXml, 'xl/_rels/workbook.xml.rels');
	const sheetNodes = descendants(book, 'sheet');
	for (const node of sheetNodes) {
		const id = node.getAttribute('r:id') ?? '';
		const worksheetRelation = descendants(rels, 'Relationship').find(item => item.getAttribute('Id') === id);
		const worksheetTarget = worksheetRelation?.getAttribute('Target');
		if (!worksheetTarget || worksheetRelation?.getAttribute('TargetMode') === 'External') {throw new Error('No se pudo localizar una hoja interna para validar el libro.');}
		const worksheetBytes = files[resolveTarget(worksheetTarget)];
		if (!worksheetBytes) {throw new Error('Falta una hoja XLSX al validar las referencias del libro.');}
		const worksheet = parseXml(worksheetBytes, 'hoja XLSX');
		const unsupportedNodes = ['extLst', 'autoFilter', 'dataValidations', 'conditionalFormatting', 'tableParts', 'legacyDrawing', 'drawing', 'mergeCells', 'hyperlinks', 'sheetProtection'];
		if (unsupportedNodes.some(name => descendants(worksheet, name).length > 0)) {
			throw new Error('No se puede cambiar la estructura: una hoja contiene referencias o extensiones que esta operación no actualiza.');
		}
	}
	const selected = sheetNodes[operation.sheetIndex];
	const relationId = selected?.getAttribute('r:id') ?? '';
	const relation = descendants(rels, 'Relationship').find(node => node.getAttribute('Id') === relationId);
	const target = relation?.getAttribute('Target');
	if (!target || relation?.getAttribute('TargetMode') === 'External') {throw new Error('No se pudo localizar una parte interna para la hoja XLSX.');}
	const part = resolveTarget(target);
	const sheetBytes = files[part];
	if (!sheetBytes) {throw new Error('Falta el XML de la hoja XLSX seleccionada.');}
	const doc = parseXml(sheetBytes, part);
	const isInsert = operation.kind.startsWith('insert');
	const coordinate = operation.index + 1;
	if (isRow) {rewriteRows(doc, coordinate, operation.count, isInsert, sheet.columnCount);}
	else {rewriteColumns(doc, coordinate, operation.count, isInsert, sheet.rowCount);}
	if (!isRow) {updateRowSpans(doc, operation);}
	updateDimension(doc, operation);
	files[part] = new TextEncoder().encode(new XMLSerializer().serializeToString(doc));
	const after = zipSync(files);
	parseXlsxBytes(after); // Reopen with the normal parser before exposing the result.
	return { before: bytes.slice(), after, operation: { ...operation } };
}

export function assertSupportedStructureProfile(workbook: XlsxWorkbook): void {
	if (workbook.unknownParts?.length) {throw new Error('No se puede cambiar la estructura: el libro contiene componentes XLSX no interpretados.');}
	if (workbook.definedNames?.length) {throw new Error('No se puede cambiar la estructura: hay nombres definidos que podrían apuntar a celdas.');}
	if (workbook.hasExternalReferences) {throw new Error('No se puede cambiar la estructura: hay referencias externas.');}
	for (const sheet of workbook.sheets) {
		if (sheet.cellTypes.some(row => row.some(type => type === 'formula' || type === 'unsupported'))) {
			throw new Error('No se puede cambiar la estructura: una hoja contiene fórmulas o tipos de celda no compatibles.');
		}
		const metadata = sheet.metadata;
		if (metadata?.protected || metadata?.mergedRanges.length || metadata?.hyperlinkCount || metadata?.tableCount || metadata?.hasNotes || metadata?.hasDrawings) {
			throw new Error('No se puede cambiar la estructura: una hoja contiene protección, combinaciones o referencias adicionales.');
		}
	}
}

function rewriteRows(doc: Document, at: number, count: number, insert: boolean, columnCount: number): void {
	const root = doc.documentElement;
	const data = root && descendants(root, 'sheetData')[0];
	if (!root || !data) {throw new Error('La hoja XLSX no contiene sheetData.');}
	const end = at + count - 1;
	const rows = directChildren(data, 'row');
	for (const row of rows) {
		const current = integerAttribute(row, 'r');
		if (!current) {throw new Error('La hoja tiene una fila sin coordenada válida.');}
		if (!insert && current >= at && current <= end) {data.removeChild(row); continue;}
		if (insert ? current >= at : current > end) {
			const next = current + (insert ? count : -count);
			if (next > 50_000) {throw new Error('La operación excede el límite de 50,000 filas.');}
			row.setAttribute('r', String(next));
			for (const cell of directChildren(row, 'c')) {
				const position = parseCell(cell.getAttribute('r') ?? '');
				if (!position) {throw new Error('La hoja tiene una referencia de celda inválida.');}
				cell.setAttribute('r', `${columnName(position.column)}${next}`);
			}
		}
	}
	if (insert) {
		if (count * Math.max(1, columnCount) > 1_000_000) {throw new Error('La inserción excede el límite de celdas que se pueden materializar.');}
		for (let offset = 0; offset < count; offset++) {
			const rowNumber = at + offset; const row = doc.createElementNS(root.namespaceURI, 'row'); row.setAttribute('r', String(rowNumber));
			for (let column = 1; column <= columnCount; column++) {const cell = doc.createElementNS(root.namespaceURI, 'c'); cell.setAttribute('r', `${columnName(column)}${rowNumber}`); row.appendChild(cell);}
			const next = directChildren(data, 'row').find(item => integerAttribute(item, 'r') > rowNumber);
			if (next) {data.insertBefore(row, next);} else {data.appendChild(row);}
		}
	}
}

function rewriteColumns(doc: Document, at: number, count: number, insert: boolean, rowCount: number): void {
	const root = doc.documentElement;
	if (!root) {throw new Error('La hoja XLSX no tiene elemento raíz.');}
	const end = at + count - 1;
	for (const cell of descendants(root, 'c')) {
		const reference = cell.getAttribute('r') ?? '';
		const position = parseCell(reference);
		if (!position) {throw new Error(`Referencia de celda inválida: ${reference || '(vacía)'}.`);}
		if (!insert && position.column >= at && position.column <= end) {cell.parentNode?.removeChild(cell); continue;}
		if (insert ? position.column >= at : position.column > end) {
			const next = position.column + (insert ? count : -count);
			if (next > 256) {throw new Error('La operación excede el límite de 256 columnas.');}
			cell.setAttribute('r', `${columnName(next)}${position.row}`);
		}
	}
	if (insert) {
		if (count * rowCount > 1_000_000) {throw new Error('La inserción excede el límite de celdas que se pueden materializar.');}
		const data = descendants(root, 'sheetData')[0];
		if (data) {
			for (const row of directChildren(data, 'row')) {
				const rowNumber = integerAttribute(row, 'r');
				for (let offset = 0; offset < count; offset++) {
					const column = at + offset; const cell = doc.createElementNS(root.namespaceURI, 'c'); cell.setAttribute('r', `${columnName(column)}${rowNumber}`);
					const next = directChildren(row, 'c').find(item => (parseCell(item.getAttribute('r') ?? '')?.column ?? Infinity) > column);
					if (next) {row.insertBefore(cell, next);} else {row.appendChild(cell);}
				}
			}
		}
	}
	const cols = descendants(root, 'cols')[0];
	if (cols) {
		const old = directChildren(cols, 'col');
		for (const item of old) {cols.removeChild(item);}
		for (const item of old) {
			const min = integerAttribute(item, 'min'); const max = integerAttribute(item, 'max');
			if (!min || !max || max < min) {throw new Error('La geometría de columnas contiene un intervalo inválido.');}
			const ranges: Array<[number, number]> = [];
			if (insert) {
				if (min < at) {ranges.push([min, Math.min(max, at - 1)]);}
				if (max >= at) {ranges.push([Math.max(min, at) + count, max + count]);}
			} else {
				if (min < at) {ranges.push([min, Math.min(max, at - 1)]);}
				if (max > end) {ranges.push([Math.max(min, end + 1) - count, max - count]);}
			}
			if (ranges.some(([, last]) => last > 256)) {throw new Error('La geometría de columnas excede el límite de 256 columnas.');}
			for (const [first, last] of ranges) {
				if (first > last || last > 256) {continue;}
				const copy = item.cloneNode(true) as Element;
				copy.setAttribute('min', String(first)); copy.setAttribute('max', String(last)); cols.appendChild(copy);
			}
		}
	}
}

function updateRowSpans(doc: Document, operation: XlsxStructureOperation): void {
	const at = operation.index + 1; const end = at + operation.count - 1; const insert = operation.kind === 'insertColumns';
	for (const row of descendants(doc, 'row')) {
		if (!row.hasAttribute('spans')) {continue;}
		const match = /^(\d+):(\d+)$/.exec(row.getAttribute('spans') ?? '');
		if (!match) {throw new Error('La hoja contiene un intervalo spans inválido.');}
		const min = Number(match[1]); const max = Number(match[2]);
		if (insert) {
			row.setAttribute('spans', `${min >= at ? min + operation.count : min}:${max >= at ? max + operation.count : max}`);
		} else {
			if (min >= at && max <= end) {row.removeAttribute('spans'); continue;}
			const nextMin = min >= at ? min > end ? min - operation.count : at : min;
			const nextMax = max > end ? max - operation.count : max >= at ? at - 1 : max;
			if (nextMin > nextMax) {row.removeAttribute('spans');}
			else {row.setAttribute('spans', `${nextMin}:${nextMax}`);}
		}
	}
}

function updateDimension(doc: Document, operation: XlsxStructureOperation): void {
	const root = doc.documentElement;
	if (!root) {return;}
	const dimension = descendants(root, 'dimension')[0];
	if (!dimension) {return;}
	const original = dimension.getAttribute('ref') ?? '';
	const match = /^([A-Z]{1,3}[1-9]\d*)(?::([A-Z]{1,3}[1-9]\d*))?$/i.exec(original);
	if (!match) {throw new Error('La hoja tiene una dimensión XLSX que no se puede ajustar de forma segura.');}
	const first = parseCell(match[1]!); const last = parseCell(match[2] ?? match[1]!);
	if (!first || !last) {throw new Error('La hoja tiene una dimensión XLSX inválida.');}
	const isRow = operation.kind === 'insertRows' || operation.kind === 'deleteRows';
	const insert = operation.kind.startsWith('insert'); const at = operation.index + 1; const end = at + operation.count - 1;
	const shift = (value: number): number => value < at ? value : insert ? value + operation.count : value > end ? value - operation.count : at;
	const firstRow = isRow ? shift(first.row) : first.row; const lastRow = isRow ? shift(last.row) : last.row;
	const firstColumn = isRow ? first.column : shift(first.column); const lastColumn = isRow ? last.column : shift(last.column);
	let dataLastRow = 1; let dataLastColumn = 1;
	for (const cell of descendants(root, 'c')) {
		const position = parseCell(cell.getAttribute('r') ?? '');
		if (position) {dataLastRow = Math.max(dataLastRow, position.row); dataLastColumn = Math.max(dataLastColumn, position.column);}
	}
	const finalRow = Math.max(dataLastRow, firstRow, lastRow); const finalColumn = Math.max(dataLastColumn, firstColumn, lastColumn);
	dimension.setAttribute('ref', `A1:${columnName(finalColumn)}${finalRow}`);
}

function parseXml(bytes: Uint8Array, part: string): Document {
	const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	if (/<!DOCTYPE|<!ENTITY/i.test(source)) {throw new Error(`La parte ${part} contiene declaraciones XML no admitidas.`);}
	let parseError: string | undefined;
	const document = new DOMParser({ onError: (_level, message) => {parseError ??= message;} }).parseFromString(source, 'application/xml');
	if (parseError || !document.documentElement) {throw new Error(`XML inválido en ${part}: ${parseError ?? 'documento vacío'}`);}
	return document;
}
function descendants(parent: Document | Element, name: string): Element[] {return Array.from(parent.getElementsByTagName('*')).filter(node => localName(node) === name);}
function directChildren(parent: Element, name: string): Element[] {return Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1 && localName(node as Element) === name);}
function localName(element: Element): string {return element.localName || element.nodeName.split(':').pop() || element.nodeName;}
function integerAttribute(element: Element, name: string): number {const value = element.getAttribute(name) ?? ''; return /^\d+$/.test(value) ? Number(value) : 0;}
function parseCell(ref: string): { row: number; column: number } | undefined {
	const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(ref); if (!match) {return undefined;}
	let column = 0; for (const character of match[1]!.toUpperCase()) {column = column * 26 + character.charCodeAt(0) - 64;}
	return column <= 256 ? { row: Number(match[2]), column } : undefined;
}
function columnName(column: number): string {let name = ''; while (column > 0) {column--; name = String.fromCharCode(65 + column % 26) + name; column = Math.floor(column / 26);} return name;}
function resolveTarget(target: string): string {
	const parts: string[] = []; for (const part of (target.startsWith('/') ? target.slice(1) : `xl/${target}`).split('/')) {if (part === '..') {parts.pop();} else if (part && part !== '.') {parts.push(part);}}
	const path = parts.join('/'); if (!path.startsWith('xl/')) {throw new Error('La relación de hoja apunta fuera de xl/.');} return path;
}

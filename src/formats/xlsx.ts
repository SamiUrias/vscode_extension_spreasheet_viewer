import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { unzipSync, zipSync } from 'fflate';

export const MAX_XLSX_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_PARTS = 10_000;
const MAX_SHEETS = 50;
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 256;
const MAX_RECTANGLE_CELLS = 1_000_000;
const MAX_PRESENT_CELLS = 500_000;

export type XlsxCellKind = 'value' | 'empty' | 'missing' | 'formula';
export type XlsxStoredType = 'number' | 'sharedString' | 'inlineString' | 'string' | 'boolean' | 'error' | 'date' | 'formula' | 'empty' | 'missing' | 'unsupported';

export interface XlsxSheet {
	readonly name: string;
	readonly rows: string[][];
	readonly cellKinds: XlsxCellKind[][];
	readonly cellTypes: XlsxStoredType[][];
	readonly formulaCaches: Record<string, string>;
	readonly rowCount: number;
	readonly columnCount: number;
}

export interface XlsxWorkbook {
	readonly sheets: XlsxSheet[];
	readonly warnings: string[];
}

export interface XlsxCellEdit {
	readonly sheetIndex: number;
	readonly row: number;
	readonly column: number;
	readonly value: string;
	readonly type: 'string' | 'number' | 'boolean' | 'date';
}

/** Reads the stored XML values. Number formats and styles are intentionally ignored. */
export function parseXlsxBytes(bytes: Uint8Array): XlsxWorkbook {
	if (bytes.byteLength > MAX_XLSX_BYTES) {
		throw new Error(`El XLSX excede el límite de ${MAX_XLSX_BYTES / (1024 * 1024)} MiB.`);
	}
	let expandedBytes = 0;
	let archiveParts = 0;
	const files = unzipSync(bytes, {
		filter: file => {
			archiveParts++;
			if (archiveParts > MAX_ARCHIVE_PARTS) {
				throw new Error(`El XLSX excede el límite de ${MAX_ARCHIVE_PARTS.toLocaleString()} componentes.`);
			}
			expandedBytes += file.originalSize;
			if (expandedBytes > MAX_UNCOMPRESSED_BYTES) {
				throw new Error(`El XLSX excede el límite de ${MAX_UNCOMPRESSED_BYTES / (1024 * 1024)} MiB descomprimidos.`);
			}
			return true;
		},
	});
	const workbookXml = files['xl/workbook.xml'];
	const relationshipsXml = files['xl/_rels/workbook.xml.rels'];
	if (!workbookXml || !relationshipsXml) {
		throw new Error('El XLSX no contiene la estructura de libro esperada.');
	}

	const workbook = parseXml(workbookXml, 'xl/workbook.xml');
	const relationships = parseXml(relationshipsXml, 'xl/_rels/workbook.xml.rels');
	const targets = new Map<string, string>();
	for (const relationship of elements(relationships, 'Relationship')) {
		const id = relationship.getAttribute('Id') ?? '';
		const target = relationship.getAttribute('Target') ?? '';
		const type = relationship.getAttribute('Type') ?? '';
		if (id && target && type.endsWith('/worksheet')) {
			targets.set(id, resolveWorkbookTarget(target));
		}
	}

	const sharedStringsFile = files['xl/sharedStrings.xml'];
	const sharedStrings = sharedStringsFile ? parseSharedStrings(sharedStringsFile) : [];
	const sheetNodes = elements(workbook, 'sheet');
	if (sheetNodes.length > MAX_SHEETS) {
		throw new Error(`El XLSX excede el límite de ${MAX_SHEETS} hojas.`);
	}
	const warnings: string[] = [];
	const unsupported = [
		{ pattern: /^xl\/vbaProject\.bin$/i, label: 'macros VBA' },
		{ pattern: /^xl\/(?:charts|pivotTables|drawings|tables)\//i, label: 'gráficos, tablas dinámicas o estructuras avanzadas' },
		{ pattern: /^xl\/externalLinks\//i, label: 'vínculos externos' },
		{ pattern: /^_xmlsignatures\//i, label: 'firmas digitales' },
	];
	for (const feature of unsupported) {
		if (Object.keys(files).some(name => feature.pattern.test(name))) {
			warnings.push(`El libro contiene ${feature.label}; no se interpretan en la vista tabular.`);
		}
	}
	let workbookPresentCells = 0;
	const sheets = sheetNodes.map((sheetNode, index) => {
		const name = sheetNode.getAttribute('name') || `Hoja ${index + 1}`;
		const relationshipId = sheetNode.getAttribute('r:id') ?? '';
		const target = targets.get(relationshipId);
		if (!target || !files[target]) {
			throw new Error(`No se pudo leer la hoja «${name}»: falta su parte XML o su relación.`);
		}
		const parsedSheet = parseSheet(name, parseXml(files[target], target), sharedStrings);
		workbookPresentCells += parsedSheet.cellKinds.reduce(
			(total, row) => total + row.filter(kind => kind !== 'missing').length, 0);
		if (workbookPresentCells > MAX_PRESENT_CELLS) {
			throw new Error(`El XLSX excede el límite de ${MAX_PRESENT_CELLS.toLocaleString()} celdas con datos.`);
		}
		return parsedSheet;
	});
	return { sheets, warnings };
}

/** Returns a modified archive copy; callers retain responsibility for persistence. */
export function serializeXlsxEdits(bytes: Uint8Array, edits: readonly XlsxCellEdit[]): Uint8Array {
	if (edits.length === 0) {return bytes.slice();}
	const workbook = parseXlsxBytes(bytes);
	const files = unzipSync(bytes);
	const workbookXml = files['xl/workbook.xml'];
	const relationshipsXml = files['xl/_rels/workbook.xml.rels'];
	if (!workbookXml || !relationshipsXml) {throw new Error('El XLSX no contiene la estructura de libro esperada.');}
	const book = parseXml(workbookXml, 'xl/workbook.xml');
	const rels = parseXml(relationshipsXml, 'xl/_rels/workbook.xml.rels');
	const targets = new Map(elements(rels, 'Relationship').map(rel => [rel.getAttribute('Id') ?? '', resolveWorkbookTarget(rel.getAttribute('Target') ?? '')]));
	const grouped = new Map<string, XlsxCellEdit[]>();
	for (const edit of edits) {
		const sheet = workbook.sheets[edit.sheetIndex];
		if (!sheet || !Number.isInteger(edit.row) || !Number.isInteger(edit.column) || edit.row < 0 || edit.column < 0 || edit.row >= sheet.rowCount || edit.column >= sheet.columnCount) {
			throw new Error('La celda XLSX está fuera del rango actual.');
		}
		const currentType = sheet.cellTypes[edit.row]?.[edit.column] ?? 'missing';
		if (currentType === 'formula' || currentType === 'unsupported' || currentType === 'error') {throw new Error('Esta celda XLSX no se puede editar de forma segura.');}
		validateXlsxLexeme(edit.type, edit.value);
		const sheetNode = elements(book, 'sheet')[edit.sheetIndex];
		const path = targets.get(sheetNode?.getAttribute('r:id') ?? '');
		if (!path || !files[path]) {throw new Error('No se pudo localizar la hoja XLSX para editar.');}
		const list = grouped.get(path) ?? [];
		list.push(edit);
		grouped.set(path, list);
	}
	for (const [part, sheetEdits] of grouped) {
		const doc = parseXml(files[part]!, part);
		for (const edit of sheetEdits) {writeXlsxCell(doc, edit);}
		files[part] = new TextEncoder().encode(new XMLSerializer().serializeToString(doc));
	}
	return zipSync(files);
}

function validateXlsxLexeme(type: XlsxCellEdit['type'], value: string): void {
	if (type === 'number' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {throw new Error('Número XLSX inválido.');}
	if (type === 'boolean' && value !== '0' && value !== '1') {throw new Error('Booleano XLSX inválido.');}
	if (type === 'date' && !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {throw new Error('Fecha XLSX inválida.');}
}

function writeXlsxCell(doc: Document, edit: XlsxCellEdit): void {
	const reference = columnName(edit.column + 1) + (edit.row + 1);
	const worksheet = doc.documentElement;
	if (!worksheet) {throw new Error('La hoja XLSX no tiene un elemento raíz.');}
	const namespace = worksheet.namespaceURI;
	let sheetData = firstChild(worksheet, 'sheetData');
	if (!sheetData) { sheetData = doc.createElementNS(namespace, 'sheetData'); worksheet.appendChild(sheetData); }
	let row = elements(doc, 'row').find(node => node.getAttribute('r') === String(edit.row + 1));
	if (!row) {
		row = doc.createElementNS(namespace, 'row'); row.setAttribute('r', String(edit.row + 1));
		const following = elements(sheetData, 'row').find(node => Number(node.getAttribute('r')) > edit.row + 1);
		if (following) {sheetData.insertBefore(row, following);} else {sheetData.appendChild(row);}
	}
	let cell = elements(row, 'c').find(node => node.getAttribute('r')?.toUpperCase() === reference);
	if (!cell) {
		cell = doc.createElementNS(namespace, 'c'); cell.setAttribute('r', reference);
		const col = edit.column + 1;
		const following = elements(row, 'c').find(node => (parseCellReference(node.getAttribute('r') ?? '')?.column ?? Infinity) > col);
		if (following) {row.insertBefore(cell, following);} else {row.appendChild(cell);}
	}
	while (cell.firstChild) {cell.removeChild(cell.firstChild);}
	if (edit.type === 'string') {
		cell.setAttribute('t', 'inlineStr');
		const inline = doc.createElementNS(namespace, 'is');
		const text = doc.createElementNS(namespace, 't');
		if (/^\s|\s$/u.test(edit.value)) {text.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');}
		text.appendChild(doc.createTextNode(edit.value)); inline.appendChild(text); cell.appendChild(inline);
	} else {
		cell.setAttribute('t', edit.type === 'number' ? 'n' : edit.type === 'boolean' ? 'b' : 'd');
		const value = doc.createElementNS(namespace, 'v'); value.appendChild(doc.createTextNode(edit.value)); cell.appendChild(value);
	}
}

function columnName(column: number): string {
	let name = '';
	while (column > 0) { column--; name = String.fromCharCode(65 + column % 26) + name; column = Math.floor(column / 26); }
	return name;
}

function parseSheet(name: string, document: Document, sharedStrings: string[]): XlsxSheet {
	const cells = new Map<number, Map<number, { value: string; kind: XlsxCellKind; type: XlsxStoredType; cache?: string; ref: string }>>();
	let maxRow = 0;
	let maxColumn = 0;
	let presentCount = 0;
	for (const cell of elements(document, 'c')) {
		const ref = cell.getAttribute('r') ?? '';
		const position = parseCellReference(ref);
		if (!position) {
			throw new Error(`Referencia de celda inválida: ${ref || '(vacía)'}.`);
		}
		if (position.row > MAX_ROWS || position.column > MAX_COLUMNS) {
			throw new Error(`La hoja excede el límite de ${MAX_ROWS} filas o ${MAX_COLUMNS} columnas.`);
		}
		const formula = firstChild(cell, 'f');
		const valueNode = firstChild(cell, 'v');
		const inline = firstChild(cell, 'is');
		const rawValue = valueNode?.textContent ?? '';
		const type = cell.getAttribute('t');
		const storedType = formula ? 'formula' : resolveStoredType(type, valueNode, inline);
		let value = rawValue;
		let kind: XlsxCellKind = valueNode || inline ? 'value' : 'empty';
		if (type === 's' && valueNode) {
			const sharedIndex = Number(rawValue);
			if (!Number.isInteger(sharedIndex) || sharedIndex < 0 || sharedIndex >= sharedStrings.length) {
				throw new Error(`Índice de shared string inválido en ${ref}.`);
			}
			value = sharedStrings[sharedIndex];
		} else if (type === 'inlineStr' && inline) {
			value = textRuns(inline);
		} else if (type === 'b' && valueNode) {
			if (rawValue !== '0' && rawValue !== '1') {
				throw new Error(`Booleano XLSX inválido en ${ref}: ${rawValue}.`);
			}
			value = rawValue;
		}
		if (formula) {
			kind = 'formula';
			value = `=${formula.textContent ?? ''}`;
		}
		let row = cells.get(position.row);
		if (!row) {
			row = new Map();
			cells.set(position.row, row);
		}
		row.set(position.column, {
			value,
			kind,
			type: storedType,
			...(formula ? { cache: rawValue } : {}),
			ref: ref.toUpperCase(),
		});
		maxRow = Math.max(maxRow, position.row);
		maxColumn = Math.max(maxColumn, position.column);
		presentCount++;
	}
	if (maxRow * maxColumn > MAX_RECTANGLE_CELLS || presentCount > MAX_PRESENT_CELLS) {
		throw new Error('La hoja excede el límite de celdas que se pueden mostrar.');
	}
	const rows: string[][] = [];
	const cellKinds: XlsxCellKind[][] = [];
	const cellTypes: XlsxStoredType[][] = [];
	const formulaCaches: Record<string, string> = {};
	for (let rowIndex = 1; rowIndex <= maxRow; rowIndex++) {
		const row: string[] = [];
		const kinds: XlsxCellKind[] = [];
		const types: XlsxStoredType[] = [];
		const sourceRow = cells.get(rowIndex);
		for (let column = 1; column <= maxColumn; column++) {
			const cell = sourceRow?.get(column);
			row.push(cell?.value ?? '');
			kinds.push(cell?.kind ?? 'missing');
			types.push(cell?.type ?? 'missing');
			if (cell?.kind === 'formula') {
				formulaCaches[cell.ref] = cell.cache ?? '';
			}
		}
		rows.push(row);
		cellKinds.push(kinds);
		cellTypes.push(types);
	}
	return { name, rows, cellKinds, cellTypes, formulaCaches, rowCount: maxRow, columnCount: maxColumn };
}

function resolveStoredType(type: string | null, value: Element | undefined, inline: Element | undefined): XlsxStoredType {
	if (!value && !inline) {
		return 'empty';
	}
	switch (type) {
		case null:
		case 'n': return 'number';
		case 's': return 'sharedString';
		case 'inlineStr': return 'inlineString';
		case 'str': return 'string';
		case 'b': return 'boolean';
		case 'e': return 'error';
		case 'd': return 'date';
		default: return 'unsupported';
	}
}

function parseSharedStrings(bytes: Uint8Array): string[] {
	return elements(parseXml(bytes, 'xl/sharedStrings.xml'), 'si').map(textRuns);
}

function textRuns(node: Element): string {
	return descendants(node, 't').map(text => text.textContent ?? '').join('');
}

function parseXml(bytes: Uint8Array, part: string): Document {
	const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
		throw new Error(`La parte ${part} contiene declaraciones XML no admitidas.`);
	}
	let parseError: string | undefined;
	const document = new DOMParser({
		onError: (_level, message) => { parseError ??= message; },
	}).parseFromString(text, 'application/xml');
	if (parseError || !document.documentElement) {
		throw new Error(`XML inválido en ${part}: ${parseError ?? 'documento vacío'}`);
	}
	return document;
}

function elements(root: Document | Element, localName: string): Element[] {
	return Array.from(root.getElementsByTagName('*')).filter(element => localNameOf(element) === localName);
}

function descendants(root: Element, localName: string): Element[] {
	return Array.from(root.getElementsByTagName('*')).filter(element => localNameOf(element) === localName);
}

function firstChild(root: Element, localName: string): Element | undefined {
	for (let child = root.firstChild; child; child = child.nextSibling) {
		if (child.nodeType === 1 && localNameOf(child as Element) === localName) {
			return child as Element;
		}
	}
	return undefined;
}

function localNameOf(element: Element): string {
	return element.localName || element.nodeName.split(':').pop() || element.nodeName;
}

function resolveWorkbookTarget(target: string): string {
	const normalized = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
	const parts: string[] = [];
	for (const part of normalized.split('/')) {
		if (part === '..') {
			parts.pop();
		} else if (part && part !== '.') {
			parts.push(part);
		}
	}
	const resolved = parts.join('/');
	if (!resolved.startsWith('xl/')) {
		throw new Error('La relación de hoja apunta fuera de la carpeta xl/.');
	}
	return resolved;
}

function parseCellReference(ref: string): { row: number; column: number } | undefined {
	const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(ref);
	if (!match) {
		return undefined;
	}
	let column = 0;
	for (const character of match[1].toUpperCase()) {
		column = column * 26 + character.charCodeAt(0) - 64;
	}
	return { row: Number(match[2]), column };
}

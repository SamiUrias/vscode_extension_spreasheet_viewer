import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { unzipSync, zipSync } from 'fflate';
import { isCellCoveredByRange } from '../cell-reference';
import type { CellVisualStyle } from '../protocol';

export const MAX_XLSX_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_PARTS = 10_000;
const MAX_SHEETS = 50;
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 256;
const MAX_RECTANGLE_CELLS = 1_000_000;
const MAX_PRESENT_CELLS = 500_000;

export type XlsxCellKind = 'value' | 'empty' | 'missing' | 'formula';
export type XlsxStoredType = 'number' | 'sharedString' | 'inlineString' | 'string' | 'boolean' | 'error' | 'date' | 'duration' | 'formula' | 'empty' | 'missing' | 'unsupported';

export interface XlsxSheet {
	readonly name: string;
	readonly state?: 'visible' | 'hidden' | 'veryHidden';
	readonly rows: string[][];
	readonly cellKinds: XlsxCellKind[][];
	readonly cellTypes: XlsxStoredType[][];
	readonly cellStyleIndexes?: Array<Array<number | undefined>>;
	readonly formulaCaches: Record<string, string>;
	readonly metadata?: XlsxSheetMetadata;
	readonly rowCount: number;
	readonly columnCount: number;
}

export interface XlsxSheetMetadata {
	readonly mergedRanges: string[];
	readonly frozenPane?: { readonly xSplit: number; readonly ySplit: number; readonly topLeftCell?: string; readonly state?: string };
	readonly protected: boolean;
	readonly columns: Array<{ readonly min: number; readonly max: number; readonly width?: number; readonly hidden: boolean; readonly style?: number }>;
	readonly rows: Array<{ readonly row: number; readonly height?: number; readonly hidden: boolean; readonly style?: number }>;
	readonly hyperlinkCount: number;
	readonly tableCount: number;
	readonly hasNotes: boolean;
	readonly hasDrawings: boolean;
	readonly hyperlinks: Array<{ readonly reference: string; readonly target?: string; readonly location?: string }>;
	readonly tables: Array<{ readonly name?: string; readonly displayName?: string; readonly reference?: string }>;
	readonly notes: Array<{ readonly reference: string; readonly author?: string; readonly text: string }>;
}

export interface XlsxStyleMetadata {
	readonly customNumberFormats: Array<{ readonly id: number; readonly formatCode: string }>;
	readonly cellFormats: Array<{ readonly numberFormatId: number; readonly fontId: number; readonly fillId: number; readonly borderId: number; readonly baseFormatId: number }>;
	readonly cellVisualStyles: CellVisualStyle[];
	readonly fontCount: number;
	readonly fillCount: number;
	readonly borderCount: number;
	readonly namedStyleCount: number;
}

export interface XlsxWorkbook {
	readonly sheets: XlsxSheet[];
	readonly warnings: string[];
	readonly unknownParts?: string[];
	readonly date1904?: boolean;
	readonly definedNames?: string[];
	readonly hasExternalReferences?: boolean;
	readonly hasTheme?: boolean;
	readonly styles?: XlsxStyleMetadata;
}

export interface XlsxCellEdit {
	readonly sheetIndex: number;
	readonly row: number;
	readonly column: number;
	readonly value: string;
	readonly type: 'string' | 'number' | 'boolean' | 'date' | 'formula';
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
		const targetMode = relationship.getAttribute('TargetMode') ?? '';
		if (id && target && type.endsWith('/worksheet') && targetMode.toLowerCase() !== 'external') {
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
	const unknownParts = Object.keys(files).filter(name => !isKnownXlsxPart(name));
	if (unknownParts.length) {warnings.push(`El paquete conserva ${unknownParts.length} componente(s) XLSX no interpretado(s): ${unknownParts.slice(0, 10).join(', ')}${unknownParts.length > 10 ? ', …' : ''}.`);}
	let workbookPresentCells = 0;
	const sheets = sheetNodes.map((sheetNode, index) => {
		const name = sheetNode.getAttribute('name') || `Hoja ${index + 1}`;
		const relationshipId = sheetNode.getAttribute('r:id') ?? '';
		const target = targets.get(relationshipId);
		if (!target || !files[target]) {
			throw new Error(`No se pudo leer la hoja «${name}»: falta su parte XML o su relación.`);
		}
		const parsedSheet = parseSheet(name, parseXml(files[target], target), sharedStrings, files, target);
		const state = sheetNode.getAttribute('state');
		const sheet: XlsxSheet = { ...parsedSheet, state: state === 'hidden' || state === 'veryHidden' ? state : 'visible' };
		workbookPresentCells += parsedSheet.cellKinds.reduce(
			(total, row) => total + row.filter(kind => kind !== 'missing').length, 0);
		if (workbookPresentCells > MAX_PRESENT_CELLS) {
			throw new Error(`El XLSX excede el límite de ${MAX_PRESENT_CELLS.toLocaleString()} celdas con datos.`);
		}
		return sheet;
	});
	const workbookProperties = elements(workbook, 'workbookPr')[0];
	const definedNames = elements(workbook, 'definedName').map(node => node.getAttribute('name') ?? '').filter(Boolean);
	const styleBytes = files['xl/styles.xml'];
	return {
		sheets, warnings, unknownParts, date1904: workbookProperties?.getAttribute('date1904') === '1' || workbookProperties?.getAttribute('date1904') === 'true',
		definedNames, hasExternalReferences: elements(workbook, 'externalReference').length > 0,
		hasTheme: Object.keys(files).some(name => /^xl\/theme\/theme\d+\.xml$/i.test(name)),
		...(styleBytes ? { styles: parseStyleMetadata(parseXml(styleBytes, 'xl/styles.xml')) } : {}),
	};
}

function isKnownXlsxPart(name: string): boolean {
	return name === '[Content_Types].xml' || name === '_rels/.rels' || /^docProps\//i.test(name)
		|| /^xl\/(?:_rels|worksheets|tables|externalLinks|comments|drawings|media|pivotTables|theme|printerSettings|queryTables|slicerCaches)\//i.test(name)
		|| /^xl\/(?:workbook\.xml|styles\.xml|sharedStrings\.xml|calcChain\.xml|vbaProject\.bin|connections\.xml|comments\d*\.xml|persons\/persons\.xml)$/i.test(name);
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
		if (sheet.metadata?.protected) {throw new Error('La hoja XLSX está protegida y no se puede editar.');}
		if (sheet.metadata?.mergedRanges.some(range => isCellCoveredByRange(range, edit.row, edit.column))) {
			throw new Error('La celda XLSX está cubierta por una combinación y no se puede editar directamente.');
		}
		if ((currentType === 'formula' && edit.type !== 'formula') || currentType === 'unsupported' || currentType === 'error') {throw new Error('Esta celda XLSX no se puede editar de forma segura.');}
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
		if (sheetEdits.some(edit => edit.type === 'formula') && elements(doc, 'f').some(formula =>
			['array', 'shared'].includes((formula.getAttribute('t') ?? '').toLowerCase()) || formula.hasAttribute('ref'))) {
			throw new Error('No se pueden editar fórmulas en hojas con fórmulas compartidas o matriciales.');
		}
		for (const edit of sheetEdits) {writeXlsxCell(doc, edit);}
		files[part] = new TextEncoder().encode(new XMLSerializer().serializeToString(doc));
	}
	if (edits.some(edit => edit.type === 'formula')) {invalidateFormulaCalculation(files, book, rels);}
	return zipSync(files);
}

function validateXlsxLexeme(type: XlsxCellEdit['type'], value: string): void {
	if (type === 'formula' && (!value.startsWith('=') || value.length < 2 || value.slice(1).trim().length === 0)) {throw new Error('La fórmula debe comenzar con = y contener una expresión.');}
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
	if (edit.type === 'formula') {
		cell.removeAttribute('t');
		const formula = doc.createElementNS(namespace, 'f');
		formula.appendChild(doc.createTextNode(edit.value.slice(1)));
		cell.appendChild(formula);
	} else if (edit.type === 'string') {
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

function invalidateFormulaCalculation(files: Record<string, Uint8Array>, workbook: Document, relationships: Document): void {
	for (const relationship of elements(relationships, 'Relationship')) {
		if (!relationship.getAttribute('Type')?.endsWith('/calcChain')) {continue;}
		const target = relationship.getAttribute('Target');
		if (target) {delete files[resolveWorkbookTarget(target)];}
		relationship.parentNode?.removeChild(relationship);
	}
	const contentTypes = files['[Content_Types].xml'];
	if (contentTypes) {
		const document = parseXml(contentTypes, '[Content_Types].xml');
		for (const override of elements(document, 'Override')) {
			if ((override.getAttribute('PartName') ?? '').toLowerCase() === '/xl/calcchain.xml') {override.parentNode?.removeChild(override);}
		}
		files['[Content_Types].xml'] = new TextEncoder().encode(new XMLSerializer().serializeToString(document));
	}
	let calculation = elements(workbook, 'calcPr')[0];
	if (!calculation) {
		const root = workbook.documentElement;
		if (!root) {throw new Error('El XLSX no tiene elemento workbook para solicitar el recálculo.');}
		calculation = workbook.createElementNS(root.namespaceURI, 'calcPr');
		const sheets = elements(root, 'sheets')[0];
		if (sheets?.nextSibling) {root.insertBefore(calculation, sheets.nextSibling);} else {root.appendChild(calculation);}
	}
	calculation.setAttribute('calcId', '0'); calculation.setAttribute('fullCalcOnLoad', '1'); calculation.setAttribute('forceFullCalc', '1');
	files['xl/workbook.xml'] = new TextEncoder().encode(new XMLSerializer().serializeToString(workbook));
	files['xl/_rels/workbook.xml.rels'] = new TextEncoder().encode(new XMLSerializer().serializeToString(relationships));
}

function columnName(column: number): string {
	let name = '';
	while (column > 0) { column--; name = String.fromCharCode(65 + column % 26) + name; column = Math.floor(column / 26); }
	return name;
}

function parseSheet(name: string, document: Document, sharedStrings: string[], archive: Record<string, Uint8Array>, partPath: string): XlsxSheet {
	const cells = new Map<number, Map<number, { value: string; kind: XlsxCellKind; type: XlsxStoredType; style?: number; cache?: string; ref: string }>>();
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
		const rawStyle = cell.getAttribute('s');
		const style = rawStyle !== null && /^\d+$/.test(rawStyle) ? Number(rawStyle) : undefined;
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
			...(style === undefined ? {} : { style }),
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
	const cellStyleIndexes: Array<Array<number | undefined>> = [];
	for (let rowIndex = 1; rowIndex <= maxRow; rowIndex++) {
		const row: string[] = [];
		const kinds: XlsxCellKind[] = [];
		const types: XlsxStoredType[] = [];
		const styles: Array<number | undefined> = [];
		const sourceRow = cells.get(rowIndex);
		for (let column = 1; column <= maxColumn; column++) {
			const cell = sourceRow?.get(column);
			row.push(cell?.value ?? '');
			kinds.push(cell?.kind ?? 'missing');
			types.push(cell?.type ?? 'missing');
			styles.push(cell?.style);
			if (cell?.kind === 'formula') {
				formulaCaches[cell.ref] = cell.cache ?? '';
			}
		}
		rows.push(row);
		cellKinds.push(kinds);
		cellTypes.push(types);
		cellStyleIndexes.push(styles);
	}
	const pane = elements(document, 'pane')[0];
	const mergedRanges = elements(document, 'mergeCell').map(element => element.getAttribute('ref') ?? '').filter(Boolean);
	const columns = elements(document, 'col').map(element => ({
		min: parsePositiveInt(element.getAttribute('min')), max: parsePositiveInt(element.getAttribute('max')),
		...(parseFiniteNumber(element.getAttribute('width')) === undefined ? {} : { width: parseFiniteNumber(element.getAttribute('width')) }),
		hidden: element.getAttribute('hidden') === '1',
		...(parseNonNegativeInt(element.getAttribute('style')) === undefined ? {} : { style: parseNonNegativeInt(element.getAttribute('style')) }),
	}));
	const rowsMetadata = elements(document, 'row').map(element => ({
		row: parsePositiveInt(element.getAttribute('r')),
		...(parseFiniteNumber(element.getAttribute('ht')) === undefined ? {} : { height: parseFiniteNumber(element.getAttribute('ht')) }),
		hidden: element.getAttribute('hidden') === '1',
		...(parseNonNegativeInt(element.getAttribute('s')) === undefined ? {} : { style: parseNonNegativeInt(element.getAttribute('s')) }),
	}));
	const relationshipPath = `${partPath.split('/').slice(0, -1).join('/')}/_rels/${partPath.split('/').pop()}.rels`;
	const relationshipBytes = archive[relationshipPath];
	const relationships = relationshipBytes ? elements(parseXml(relationshipBytes, relationshipPath), 'Relationship') : [];
	const relationById = new Map(relationships.map(relation => [relation.getAttribute('Id') ?? '', relation]));
	const tables = elements(document, 'tablePart').flatMap(tablePart => {
		const relation = relationById.get(tablePart.getAttribute('r:id') ?? '');
		if (!relation || !(relation.getAttribute('Type') ?? '').endsWith('/table') || relation.getAttribute('TargetMode')?.toLowerCase() === 'external') {return [];}
		const target = resolvePartTarget(partPath, relation.getAttribute('Target') ?? '');
		const bytes = target ? archive[target] : undefined;
		if (!bytes) {return [];}
		const table = elements(parseXml(bytes, target!), 'table')[0];
		return table ? [{
			...(table.getAttribute('name') ? { name: table.getAttribute('name')! } : {}),
			...(table.getAttribute('displayName') ? { displayName: table.getAttribute('displayName')! } : {}),
			...(table.getAttribute('ref') ? { reference: table.getAttribute('ref')! } : {}),
		}] : [];
	});
	const hyperlinks = elements(document, 'hyperlink').map(hyperlink => {
		const relation = relationById.get(hyperlink.getAttribute('r:id') ?? '');
		return {
			reference: hyperlink.getAttribute('ref') ?? '',
			...(relation?.getAttribute('Target') ? { target: relation.getAttribute('Target')! } : {}),
			...(hyperlink.getAttribute('location') ? { location: hyperlink.getAttribute('location')! } : {}),
		};
	});
	const notes = relationships.flatMap(relation => {
		if (!(relation.getAttribute('Type') ?? '').endsWith('/comments') || relation.getAttribute('TargetMode')?.toLowerCase() === 'external') {return [];}
		const target = resolvePartTarget(partPath, relation.getAttribute('Target') ?? '');
		const bytes = target ? archive[target] : undefined;
		if (!bytes) {return [];}
		const comments = parseXml(bytes, target!);
		const authors = elements(comments, 'author').map(author => author.textContent ?? '');
		return elements(comments, 'comment').map(comment => {
			const authorIndex = parseNonNegativeInt(comment.getAttribute('authorId'));
			return { reference: comment.getAttribute('ref') ?? '',
				...(authorIndex !== undefined && authors[authorIndex] ? { author: authors[authorIndex] } : {}),
				text: elements(comment, 't').map(text => text.textContent ?? '').join('') };
		});
	});
	return { name, rows, cellKinds, cellTypes, cellStyleIndexes, formulaCaches, rowCount: maxRow, columnCount: maxColumn,
		metadata: {
			mergedRanges,
			...(pane ? { frozenPane: { xSplit: parseNonNegativeInt(pane.getAttribute('xSplit')) ?? 0,
				ySplit: parseNonNegativeInt(pane.getAttribute('ySplit')) ?? 0,
				...(pane.getAttribute('topLeftCell') ? { topLeftCell: pane.getAttribute('topLeftCell')! } : {}),
				...(pane.getAttribute('state') ? { state: pane.getAttribute('state')! } : {}) } } : {}),
			protected: elements(document, 'sheetProtection').length > 0, columns, rows: rowsMetadata,
			hyperlinkCount: hyperlinks.length, tableCount: tables.length, hyperlinks, tables, notes,
			hasNotes: notes.length > 0 || elements(document, 'legacyDrawing').length > 0 || elements(document, 'legacyDrawingHF').length > 0,
			hasDrawings: elements(document, 'drawing').length > 0,
		},
	};
}

function parseStyleMetadata(document: Document): XlsxStyleMetadata {
	const numberFormats = elements(document, 'numFmt').map(element => ({ id: parseNonNegativeInt(element.getAttribute('numFmtId')) ?? -1, formatCode: element.getAttribute('formatCode') ?? '' }));
	const fonts = elements(document, 'fonts').flatMap(container => directChildren(container, 'font').map(font => ({
		bold: childBoolean(font, 'b'), italic: childBoolean(font, 'i'),
		fontSize: parseFontSize(firstChild(font, 'sz')?.getAttribute('val')),
		fontColor: safeRgb(firstChild(font, 'color')),
	})));
	const fills = elements(document, 'fills').flatMap(container => directChildren(container, 'fill').map(fill => {
		const pattern = firstChild(fill, 'patternFill');
		return pattern?.getAttribute('patternType') === 'solid' ? safeRgb(firstChild(pattern, 'fgColor')) : undefined;
	}));
	const borders = elements(document, 'borders').flatMap(container => directChildren(container, 'border').map(border => {
		const result: NonNullable<CellVisualStyle['borders']> = {};
		for (const sideName of ['top', 'right', 'bottom', 'left'] as const) {
			const side = firstChild(border, sideName);
			const line = side?.getAttribute('style');
			if (!side || !line || !['hair', 'dotted', 'dashed', 'thin', 'medium', 'thick', 'double'].includes(line)) {continue;}
			(result as Record<string, { style: string; color?: string }>)[sideName] = { style: line, ...(safeRgb(firstChild(side, 'color')) ? { color: safeRgb(firstChild(side, 'color')) } : {}) };
		}
		return result;
	}));
	const cellFormats = elements(document, 'cellXfs').flatMap(container => Array.from(container.childNodes)
		.filter(node => node.nodeType === 1 && localNameOf(node as Element) === 'xf').map(node => {
			const element = node as Element;
			return { numberFormatId: parseNonNegativeInt(element.getAttribute('numFmtId')) ?? 0,
				fontId: parseNonNegativeInt(element.getAttribute('fontId')) ?? 0, fillId: parseNonNegativeInt(element.getAttribute('fillId')) ?? 0,
				borderId: parseNonNegativeInt(element.getAttribute('borderId')) ?? 0, baseFormatId: parseNonNegativeInt(element.getAttribute('xfId')) ?? 0 };
		}));
	const cellVisualStyles = elements(document, 'cellXfs').flatMap(container => directChildren(container, 'xf').map(element => {
		const style: CellVisualStyle = {};
		const font = fonts[parseNonNegativeInt(element.getAttribute('fontId')) ?? 0];
		const fillColor = fills[parseNonNegativeInt(element.getAttribute('fillId')) ?? 0];
		const border = borders[parseNonNegativeInt(element.getAttribute('borderId')) ?? 0];
		const alignment = firstChild(element, 'alignment');
		const horizontal = alignment?.getAttribute('horizontal');
		const vertical = alignment?.getAttribute('vertical');
		return {
			...(font?.bold === undefined ? {} : { bold: font.bold }), ...(font?.italic === undefined ? {} : { italic: font.italic }),
			...(font?.fontSize === undefined ? {} : { fontSize: font.fontSize }), ...(font?.fontColor ? { fontColor: font.fontColor } : {}),
			...(fillColor ? { fillColor } : {}),
			...(horizontal && ['left', 'center', 'right', 'justify', 'distributed', 'general'].includes(horizontal) ? { horizontalAlignment: horizontal as CellVisualStyle['horizontalAlignment'] } : {}),
			...(vertical && ['top', 'center', 'bottom', 'justify', 'distributed'].includes(vertical) ? { verticalAlignment: vertical as CellVisualStyle['verticalAlignment'] } : {}),
			...(alignment?.getAttribute('wrapText') === '1' ? { wrapText: true } : {}),
			...(border && Object.keys(border).length ? { borders: border } : {}),
		};
	}));
	const countChildren = (containerName: string, childName: string) => {
		const container = elements(document, containerName)[0];
		return container ? Array.from(container.childNodes).filter(node => node.nodeType === 1 && localNameOf(node as Element) === childName).length : 0;
	};
	return { customNumberFormats: numberFormats, cellFormats, cellVisualStyles,
		fontCount: countChildren('fonts', 'font'), fillCount: countChildren('fills', 'fill'),
		borderCount: countChildren('borders', 'border'), namedStyleCount: countChildren('cellStyles', 'cellStyle') };
}

function resolvePartTarget(sourcePart: string, target: string): string | undefined {
	if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) {return undefined;}
	const base = target.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1);
	for (const part of target.replaceAll('\\', '/').replace(/^\//, '').split('/')) {
		if (!part || part === '.') {continue;}
		if (part === '..') {if (!base.length) {return undefined;} base.pop();}
		else {base.push(part);}
	}
	return base.join('/') || undefined;
}

function parsePositiveInt(value: string | null): number {return parseNonNegativeInt(value) ?? 0;}
function parseNonNegativeInt(value: string | null): number | undefined {if (value === null || !/^\d+$/.test(value)) {return undefined;} return Number(value);}
function parseFiniteNumber(value: string | null): number | undefined {if (value === null || value.trim() === '') {return undefined;} const number = Number(value); return Number.isFinite(number) ? number : undefined;}

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

function directChildren(root: Element, localName: string): Element[] {
	const result: Element[] = [];
	for (let child = root.firstChild; child; child = child.nextSibling) {
		if (child.nodeType === 1 && localNameOf(child as Element) === localName) {result.push(child as Element);}
	}
	return result;
}

function childBoolean(root: Element, localName: string): boolean | undefined {
	const child = firstChild(root, localName);
	if (!child) {return undefined;}
	const value = child.getAttribute('val');
	return value !== '0' && value !== 'false';
}

function parseFontSize(value: string | null | undefined): number | undefined {
	const size = value === undefined ? undefined : parseFiniteNumber(value);
	return size !== undefined && size >= 6 && size <= 72 ? size : undefined;
}

function safeRgb(element: Element | undefined): string | undefined {
	const value = element?.getAttribute('rgb');
	if (!value || !/^(?:[0-9a-f]{6}|ff[0-9a-f]{6})$/i.test(value)) {return undefined;}
	return `#${value.length === 8 ? value.slice(2) : value}`;
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

import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { unzipSync, zipSync } from 'fflate';
import { parseCellRangeBounds } from '../cell-reference';
import { parseXlsxBytes } from './xlsx';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const TABLE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/table';
const TABLE_CONTENT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml';

export interface XlsxTableOperation {
	readonly sheetIndex: number;
	readonly startRow: number; readonly startColumn: number; readonly endRow: number; readonly endColumn: number;
	readonly name: string;
}

export interface XlsxTableSnapshot { readonly before: Uint8Array; readonly after: Uint8Array; readonly operation: XlsxTableOperation; }

export function applyXlsxTableOperation(bytes: Uint8Array, operation: XlsxTableOperation): XlsxTableSnapshot {
	const workbook = parseXlsxBytes(bytes);
	if (workbook.macroEnabled || workbook.hasVbaProject || workbook.hasDigitalSignatures) {throw new Error('El libro contiene macros o firmas y no admite cambios de tabla.');}
	if (workbook.unknownParts?.length || workbook.hasExternalReferences) {throw new Error('El libro contiene partes o referencias que esta operación no puede validar.');}
	const sheet = workbook.sheets[operation.sheetIndex];
	if (!sheet || sheet.metadata?.protected) {throw new Error('La hoja no existe o está protegida.');}
	if (![operation.startRow, operation.startColumn, operation.endRow, operation.endColumn].every(Number.isInteger)
		|| operation.startRow < 0 || operation.startColumn < 0 || operation.endRow < operation.startRow || operation.endColumn < operation.startColumn
		|| operation.endRow >= sheet.rowCount || operation.endColumn >= sheet.columnCount) {throw new Error('El rango de tabla está fuera de los datos de la hoja.');}
	if (sheet.metadata?.mergedRanges.some(range => overlaps(parseCellRangeBounds(range), operation))) {throw new Error('El rango de tabla se cruza con celdas combinadas.');}
	if (sheet.cellTypes.some((row, rowIndex) => row.some((type, column) => type === 'formula'
		&& rowIndex >= operation.startRow && rowIndex <= operation.endRow && column >= operation.startColumn && column <= operation.endColumn
		&& /\[[^\]]+\]/.test(sheet.rows[rowIndex]?.[column] ?? '')))
	) {throw new Error('El rango contiene fórmulas con referencias estructuradas.');}
	const width = operation.endColumn - operation.startColumn + 1;
	const headers = Array.from({ length: width }, (_, index) => sheet.rows[operation.startRow]?.[operation.startColumn + index] ?? '');
	const seen = new Set<string>();
	for (let index = 0; index < headers.length; index++) {
		const header = headers[index]!;
		if (!header.trim() || header !== header.trim() || seen.has(header.toLowerCase()) || sheet.cellTypes[operation.startRow]?.[operation.startColumn + index] === 'formula') {
			throw new Error(`El encabezado de la columna ${index + 1} debe ser único y no estar vacío; corrígelo antes de crear la tabla.`);
		}
		seen.add(header.toLowerCase());
	}
	const range = `${columnName(operation.startColumn + 1)}${operation.startRow + 1}:${columnName(operation.endColumn + 1)}${operation.endRow + 1}`;
	for (let sheetIndex = 0; sheetIndex < workbook.sheets.length; sheetIndex++) {
		for (const candidate of workbook.sheets[sheetIndex]?.metadata?.tables ?? []) {
			if (candidate.name?.toLowerCase() === operation.name.toLowerCase() || candidate.displayName?.toLowerCase() === operation.name.toLowerCase()) {
				throw new Error(`Ya existe una tabla llamada «${operation.name}».`);
			}
			if (sheetIndex === operation.sheetIndex && candidate.reference && overlaps(parseCellRangeBounds(candidate.reference), operation)) {
				throw new Error('El rango se solapa con una tabla existente.');
			}
		}
	}
	if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(operation.name) || /^[A-Za-z]{1,3}\d+$/.test(operation.name) || /^R\d+C\d+$/i.test(operation.name)
		|| operation.name.length > 255 || ['R', 'C'].includes(operation.name.toUpperCase())) {throw new Error('El nombre debe ser válido en Excel, sin espacios y distinto de una referencia de celda.');}
	const files = unzipSync(bytes);
	const book = parseXml(requirePart(files, 'xl/workbook.xml'), 'xl/workbook.xml');
	const bookRels = parseXml(requirePart(files, 'xl/_rels/workbook.xml.rels'), 'xl/_rels/workbook.xml.rels');
	const sheetNodes = descendants(book, 'sheet');
	const sheetNode = sheetNodes[operation.sheetIndex];
	const sheetRelationId = sheetNode?.getAttribute('r:id') ?? '';
	const sheetRelation = descendants(bookRels, 'Relationship').find(node => node.getAttribute('Id') === sheetRelationId);
	const worksheetTarget = sheetRelation?.getAttribute('Target');
	if (!worksheetTarget || sheetRelation?.getAttribute('TargetMode')?.toLowerCase() === 'external') {throw new Error('No se pudo resolver la hoja XLSX seleccionada.');}
	const worksheetPath = resolvePart('xl/workbook.xml', worksheetTarget);
	const worksheetRelsPath = `${worksheetPath.slice(0, worksheetPath.lastIndexOf('/') + 1)}_rels/${worksheetPath.split('/').pop()}.rels`;
	const worksheet = parseXml(requirePart(files, worksheetPath), worksheetPath);
	const worksheetRoot = requireRoot(worksheet, worksheetPath);
	if (!worksheetRoot.hasAttribute('xmlns:r')) {worksheetRoot.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:r', REL_NS);}
	const worksheetRels = files[worksheetRelsPath]
		? parseXml(files[worksheetRelsPath]!, worksheetRelsPath)
		: parseXml(new TextEncoder().encode(`<Relationships xmlns="${PACKAGE_REL_NS}"/>`), worksheetRelsPath);
	const tableParts = descendants(worksheet, 'tableParts')[0] ?? worksheet.createElementNS(MAIN_NS, 'tableParts');
	if (!tableParts.parentNode) {
		const extLst = directChildren(worksheetRoot, 'extLst')[0];
		worksheetRoot.insertBefore(tableParts, extLst ?? null);
	}
	const tablePartNodes = directChildren(tableParts, 'tablePart');
	const rid = nextRelationshipId(worksheetRels);
	const tableFileNumber = nextTableFileNumber(files);
	const tableId = nextTableId(files);
	const tablePath = `xl/tables/table${tableFileNumber}.xml`;
	const tableTarget = `../tables/table${tableFileNumber}.xml`;
	const relationship = worksheetRels.createElementNS(PACKAGE_REL_NS, 'Relationship');
	relationship.setAttribute('Id', rid); relationship.setAttribute('Type', TABLE_REL); relationship.setAttribute('Target', tableTarget);
	requireRoot(worksheetRels, worksheetRelsPath).appendChild(relationship);
	const tablePart = worksheet.createElementNS(MAIN_NS, 'tablePart');
	tablePart.setAttributeNS(REL_NS, 'r:id', rid);
	tableParts.appendChild(tablePart);
	tableParts.setAttribute('count', String(tablePartNodes.length + 1));
	const table = createTableXml(tableId, operation.name, range, headers);
	files[tablePath] = new TextEncoder().encode(new XMLSerializer().serializeToString(table));
	files[worksheetPath] = new TextEncoder().encode(new XMLSerializer().serializeToString(worksheet));
	files[worksheetRelsPath] = new TextEncoder().encode(new XMLSerializer().serializeToString(worksheetRels));
	const contentTypes = parseXml(requirePart(files, '[Content_Types].xml'), '[Content_Types].xml');
	if (descendants(contentTypes, 'Override').some(item => item.getAttribute('PartName') === `/${tablePath}`)) {throw new Error('El paquete ya declara esa parte de tabla.');}
	const override = contentTypes.createElementNS(CONTENT_TYPES_NS, 'Override');
	override.setAttribute('PartName', `/${tablePath}`); override.setAttribute('ContentType', TABLE_CONTENT);
	requireRoot(contentTypes, '[Content_Types].xml').appendChild(override);
	files['[Content_Types].xml'] = new TextEncoder().encode(new XMLSerializer().serializeToString(contentTypes));
	const after = zipSync(files);
	const reopened = parseXlsxBytes(after);
	const created = reopened.sheets[operation.sheetIndex]?.metadata?.tables.find(item => item.name === operation.name && item.reference === range);
	if (!created) {throw new Error('La tabla creada no pasó la validación de lectura posterior.');}
	return { before: bytes.slice(), after, operation: { ...operation } };
}

function overlaps(bounds: ReturnType<typeof parseCellRangeBounds>, operation: XlsxTableOperation): boolean {
	return Boolean(bounds && bounds.top <= operation.endRow && operation.startRow <= bounds.bottom
		&& bounds.left <= operation.endColumn && operation.startColumn <= bounds.right);
}

function createTableXml(id: number, name: string, range: string, headers: readonly string[]): Document {
	const document = parseXml(new TextEncoder().encode(`<table xmlns="${MAIN_NS}"/>`), 'tabla XLSX');
	const table = requireRoot(document, 'tabla XLSX');
	table.setAttribute('id', String(id)); table.setAttribute('name', name); table.setAttribute('displayName', name);
	table.setAttribute('ref', range); table.setAttribute('totalsRowShown', '0');
	const autoFilter = document.createElementNS(MAIN_NS, 'autoFilter'); autoFilter.setAttribute('ref', range); table.appendChild(autoFilter);
	const columns = document.createElementNS(MAIN_NS, 'tableColumns'); columns.setAttribute('count', String(headers.length));
	for (let index = 0; index < headers.length; index++) {
		const column = document.createElementNS(MAIN_NS, 'tableColumn'); column.setAttribute('id', String(index + 1)); column.setAttribute('name', headers[index]!); columns.appendChild(column);
	}
	table.appendChild(columns);
	const style = document.createElementNS(MAIN_NS, 'tableStyleInfo');
	style.setAttribute('name', 'TableStyleMedium2'); style.setAttribute('showFirstColumn', '0'); style.setAttribute('showLastColumn', '0');
	style.setAttribute('showRowStripes', '1'); style.setAttribute('showColumnStripes', '0'); table.appendChild(style);
	return document;
}

function nextRelationshipId(document: Document): string {
	const used = new Set(descendants(document, 'Relationship').map(node => node.getAttribute('Id') ?? ''));
	for (let id = 1; id < 100_000; id++) {if (!used.has(`rId${id}`)) {return `rId${id}`;}}
	throw new Error('No hay identificadores de relación disponibles.');
}
function nextTableFileNumber(files: Record<string, Uint8Array>): number {
	const used = new Set(Object.keys(files).map(path => /^xl\/tables\/table(\d+)\.xml$/i.exec(path)?.[1]).filter(Boolean));
	for (let id = 1; id < 100_000; id++) {if (!used.has(String(id))) {return id;}}
	throw new Error('No hay nombres de parte de tabla disponibles.');
}
function nextTableId(files: Record<string, Uint8Array>): number {
	let max = 0;
	for (const [path, bytes] of Object.entries(files)) {
		if (!/^xl\/tables\/table\d+\.xml$/i.test(path)) {continue;}
		const value = Number(descendants(parseXml(bytes, path), 'table')[0]?.getAttribute('id') ?? 0);
		if (Number.isSafeInteger(value)) {max = Math.max(max, value);}
	}
	return max + 1;
}
function columnName(column: number): string {let name = ''; while (column > 0) {column--; name = String.fromCharCode(65 + column % 26) + name; column = Math.floor(column / 26);} return name;}
function resolvePart(source: string, target: string): string {
	const parts = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
	for (const part of target.replaceAll('\\', '/').replace(/^\//, '').split('/')) {
		if (!part || part === '.') {continue;}
		if (part === '..') {if (!parts.length) {throw new Error('La relación sale de la raíz del paquete.');} parts.pop();}
		else {parts.push(part);}
	}
	return parts.join('/');
}
function requirePart(files: Record<string, Uint8Array>, path: string): Uint8Array {const part = files[path]; if (!part) {throw new Error(`Falta la parte ${path}.`);} return part;}
function parseXml(bytes: Uint8Array, part: string): Document {
	const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	if (/<!DOCTYPE|<!ENTITY/i.test(source)) {throw new Error(`La parte ${part} contiene declaraciones XML no admitidas.`);}
	let parseError: string | undefined;
	const document = new DOMParser({ onError: (_level, message) => {parseError ??= message;} }).parseFromString(source, 'application/xml');
	if (parseError || !document.documentElement) {throw new Error(`XML inválido en ${part}: ${parseError ?? 'documento vacío'}`);}
	return document;
}
function requireRoot(document: Document, part: string): Element {if (!document.documentElement) {throw new Error(`Falta el elemento raíz en ${part}.`);} return document.documentElement;}
function descendants(parent: Document | Element, name: string): Element[] {return Array.from(parent.getElementsByTagName('*')).filter(node => (node.localName || node.nodeName.split(':').pop()) === name);}
function directChildren(parent: Element, name: string): Element[] {return Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1 && (node as Element).localName === name);}

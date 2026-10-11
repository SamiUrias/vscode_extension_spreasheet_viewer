import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';
import { unzipSync, zipSync } from 'fflate';
import { parseXlsxBytes } from './xlsx';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const SHEET_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const SHEET_CONTENT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

export type XlsxSheetOperation =
	| { readonly kind: 'rename'; readonly sheetIndex: number; readonly name: string }
	| { readonly kind: 'add'; readonly name: string }
	| { readonly kind: 'delete'; readonly sheetIndex: number };

export interface XlsxSheetSnapshot { readonly before: Uint8Array; readonly after: Uint8Array; readonly operation: XlsxSheetOperation; }

export function applyXlsxSheetOperation(bytes: Uint8Array, operation: XlsxSheetOperation): XlsxSheetSnapshot {
	const workbook = parseXlsxBytes(bytes);
	assertSimpleWorkbookProfile(bytes, workbook);
	const sheets = workbook.sheets;
	if (operation.kind === 'add' || operation.kind === 'rename') {validateSheetName(operation.name, sheets, operation.kind === 'rename' ? operation.sheetIndex : undefined);}
	if (operation.kind !== 'add' && (!Number.isInteger(operation.sheetIndex) || operation.sheetIndex < 0 || operation.sheetIndex >= sheets.length)) {
		throw new Error('La hoja seleccionada ya no existe.');
	}
	if (operation.kind === 'delete' && sheets.length < 2) {throw new Error('El libro debe conservar al menos una hoja.');}
	const files = unzipSync(bytes);
	const workbookXml = parseXml(required(files, 'xl/workbook.xml'), 'xl/workbook.xml');
	const rels = parseXml(required(files, 'xl/_rels/workbook.xml.rels'), 'xl/_rels/workbook.xml.rels');
	const root = requireRoot(workbookXml, 'xl/workbook.xml');
	const sheetCollection = directChildren(root, 'sheets')[0];
	if (!sheetCollection) {throw new Error('El XLSX no declara su colección de hojas.');}
	const sheetNodes = directChildren(sheetCollection, 'sheet');
	const workbookRels = directChildren(requireRoot(rels, 'xl/_rels/workbook.xml.rels'), 'Relationship');
	let selectedPart: string | undefined;
	let selectedRelationship: Element | undefined;
	if (operation.kind !== 'add') {
		const node = sheetNodes[operation.sheetIndex];
		const relationshipId = node?.getAttribute('r:id') ?? '';
		selectedRelationship = workbookRels.find(item => item.getAttribute('Id') === relationshipId);
		const target = selectedRelationship?.getAttribute('Target');
		if (!target || selectedRelationship?.getAttribute('Type') !== SHEET_REL || selectedRelationship.getAttribute('TargetMode')?.toLowerCase() === 'external') {
			throw new Error('La relación de hoja seleccionada no pertenece a una hoja interna válida.');
		}
		selectedPart = resolvePart('xl/workbook.xml', target);
	}
	const contentTypes = parseXml(required(files, '[Content_Types].xml'), '[Content_Types].xml');
	if (operation.kind === 'rename') {
		sheetNodes[operation.sheetIndex]!.setAttribute('name', operation.name);
	} else if (operation.kind === 'add') {
		const partNumber = nextSheetPartNumber(files);
		const sheetId = nextSheetId(sheetNodes);
		const relationshipId = nextRelationshipId(rels);
		const target = `worksheets/sheet${partNumber}.xml`;
		const path = `xl/${target}`;
		const node = workbookXml.createElementNS(MAIN_NS, 'sheet');
		node.setAttribute('name', operation.name); node.setAttribute('sheetId', String(sheetId)); node.setAttributeNS(REL_NS, 'r:id', relationshipId);
		if (!root.hasAttribute('xmlns:r')) {root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:r', REL_NS);}
		sheetCollection.appendChild(node);
		const relationship = rels.createElementNS(PACKAGE_REL_NS, 'Relationship');
		relationship.setAttribute('Id', relationshipId); relationship.setAttribute('Type', SHEET_REL); relationship.setAttribute('Target', target);
		requireRoot(rels, 'xl/_rels/workbook.xml.rels').appendChild(relationship);
		const worksheet = parseXml(new TextEncoder().encode(`<worksheet xmlns="${MAIN_NS}"><sheetData/></worksheet>`), path);
		files[path] = new TextEncoder().encode(new XMLSerializer().serializeToString(worksheet));
		const override = contentTypes.createElementNS(CONTENT_TYPES_NS, 'Override');
		override.setAttribute('PartName', `/${path}`); override.setAttribute('ContentType', SHEET_CONTENT);
		requireRoot(contentTypes, '[Content_Types].xml').appendChild(override);
		setActiveTab(workbookXml, sheetNodes.length);
	} else {
		const deleted = sheetNodes[operation.sheetIndex]!;
		const state = deleted.getAttribute('state') ?? 'visible';
		if (state === 'visible' && sheets.filter(sheet => sheet.state !== 'hidden' && sheet.state !== 'veryHidden').length <= 1) {
			throw new Error('El libro debe conservar al menos una hoja visible.');
		}
		const relPath = relationshipPath(selectedPart!);
		if (files[relPath]) {
			const sheetRels = parseXml(files[relPath]!, relPath);
			if (directChildren(requireRoot(sheetRels, relPath), 'Relationship').length) {throw new Error('La hoja tiene relaciones dependientes y no se puede borrar en este perfil.');}
			delete files[relPath];
		}
		sheetCollection.removeChild(deleted);
		rels.documentElement!.removeChild(selectedRelationship!);
		delete files[selectedPart!];
		for (const override of descendants(contentTypes, 'Override')) {
			if (override.getAttribute('PartName') === `/${selectedPart}`) {override.parentNode?.removeChild(override);}
		}
		const active = activeTab(workbookXml);
		setActiveTab(workbookXml, active > operation.sheetIndex ? active - 1 : Math.min(active, sheetNodes.length - 2));
	}
	files['xl/workbook.xml'] = new TextEncoder().encode(new XMLSerializer().serializeToString(workbookXml));
	files['xl/_rels/workbook.xml.rels'] = new TextEncoder().encode(new XMLSerializer().serializeToString(rels));
	files['[Content_Types].xml'] = new TextEncoder().encode(new XMLSerializer().serializeToString(contentTypes));
	const after = zipSync(files);
	const reopened = parseXlsxBytes(after);
	if (operation.kind === 'add' && !reopened.sheets.some(sheet => sheet.name === operation.name)) {throw new Error('La hoja creada no pasó la validación de lectura posterior.');}
	if (operation.kind === 'rename' && reopened.sheets[operation.sheetIndex]?.name !== operation.name) {throw new Error('El cambio de nombre no pasó la validación de lectura posterior.');}
	if (operation.kind === 'delete' && reopened.sheets.length !== sheets.length - 1) {throw new Error('El borrado de hoja no pasó la validación de lectura posterior.');}
	return { before: bytes.slice(), after, operation: { ...operation } };
}

function assertSimpleWorkbookProfile(bytes: Uint8Array, workbook: ReturnType<typeof parseXlsxBytes>): void {
	if (workbook.macroEnabled || workbook.hasVbaProject || workbook.hasDigitalSignatures) {throw new Error('El libro contiene macros o firmas y no admite cambios de hoja.');}
	if (workbook.unknownParts?.length || workbook.definedNames?.length || workbook.hasExternalReferences) {throw new Error('El libro contiene partes, nombres o referencias que esta operación no puede reconciliar.');}
	for (const sheet of workbook.sheets) {
		if (sheet.cellTypes.some(row => row.includes('formula') || row.includes('unsupported')) || sheet.metadata?.protected || sheet.metadata?.mergedRanges.length
			|| sheet.metadata?.tableCount || sheet.metadata?.hasNotes || sheet.metadata?.hasDrawings || sheet.metadata?.hyperlinkCount) {
			throw new Error('El libro contiene fórmulas, protección o estructuras vinculadas fuera del perfil de edición de hojas.');
		}
	}
	const files = unzipSync(bytes);
	for (const path of Object.keys(files).filter(item => /^xl\/worksheets\/_rels\/[^/]+\.xml\.rels$/i.test(item))) {
		const relationships = parseXml(files[path]!, path);
		if (directChildren(requireRoot(relationships, path), 'Relationship').length) {throw new Error('El libro contiene relaciones de hoja que esta operación no puede actualizar.');}
	}
}

function validateSheetName(name: string, sheets: ReturnType<typeof parseXlsxBytes>['sheets'], exceptIndex?: number): void {
	if (typeof name !== 'string' || name.length < 1 || name.length > 31 || /[\[\]:*?/\\]/.test(name) || name.startsWith("'") || name.endsWith("'")) {
		throw new Error('El nombre de hoja debe tener entre 1 y 31 caracteres, sin []:*?/\\ ni apóstrofos al inicio o al final.');
	}
	if (sheets.some((sheet, index) => index !== exceptIndex && sheet.name.toLowerCase() === name.toLowerCase())) {throw new Error(`Ya existe una hoja llamada «${name}».`);}
}
function activeTab(document: Document): number {const view = descendants(document, 'workbookView')[0]; const value = Number(view?.getAttribute('activeTab') ?? 0); return Number.isInteger(value) && value >= 0 ? value : 0;}
function setActiveTab(document: Document, index: number): void {
	const root = requireRoot(document, 'xl/workbook.xml');
	let views = directChildren(root, 'bookViews')[0];
	if (!views) {views = document.createElementNS(MAIN_NS, 'bookViews'); root.insertBefore(views, directChildren(root, 'sheets')[0] ?? null);}
	let view = directChildren(views, 'workbookView')[0];
	if (!view) {view = document.createElementNS(MAIN_NS, 'workbookView'); views.appendChild(view);}
	view.setAttribute('activeTab', String(Math.max(0, index)));
}
function nextSheetId(sheets: readonly Element[]): number {return Math.max(0, ...sheets.map(sheet => Number(sheet.getAttribute('sheetId')) || 0)) + 1;}
function nextRelationshipId(document: Document): string {const used = new Set(descendants(document, 'Relationship').map(item => item.getAttribute('Id') ?? '')); for (let id = 1; id < 100_000; id++) {if (!used.has(`rId${id}`)) {return `rId${id}`;}} throw new Error('No hay identificadores de relación disponibles.');}
function nextSheetPartNumber(files: Record<string, Uint8Array>): number {const used = new Set(Object.keys(files).map(path => /^xl\/worksheets\/sheet(\d+)\.xml$/i.exec(path)?.[1]).filter(Boolean)); for (let id = 1; id < 100_000; id++) {if (!used.has(String(id))) {return id;}} throw new Error('No hay nombres de hoja disponibles.');}
function relationshipPath(part: string): string {return `${part.slice(0, part.lastIndexOf('/') + 1)}_rels/${part.split('/').pop()}.rels`;}
function resolvePart(source: string, target: string): string {const parts = target.startsWith('/') ? [] : source.split('/').slice(0, -1); for (const component of target.replaceAll('\\', '/').replace(/^\//, '').split('/')) {if (!component || component === '.') {continue;} if (component === '..') {if (!parts.length) {throw new Error('La relación sale de la raíz del paquete.');} parts.pop();} else {parts.push(component);}} return parts.join('/');}
function required(files: Record<string, Uint8Array>, part: string): Uint8Array {const bytes = files[part]; if (!bytes) {throw new Error(`Falta la parte ${part}.`);} return bytes;}
function parseXml(bytes: Uint8Array, part: string): Document {const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (/<!DOCTYPE|<!ENTITY/i.test(text)) {throw new Error(`La parte ${part} contiene declaraciones XML no admitidas.`);} let error: string | undefined; const doc = new DOMParser({ onError: (_level, message) => {error ??= message;} }).parseFromString(text, 'application/xml'); if (error || !doc.documentElement) {throw new Error(`XML inválido en ${part}: ${error ?? 'documento vacío'}`);} return doc;}
function requireRoot(document: Document, part: string): Element {if (!document.documentElement) {throw new Error(`Falta el elemento raíz en ${part}.`);} return document.documentElement;}
function descendants(parent: Document | Element, name: string): Element[] {return Array.from(parent.getElementsByTagName('*')).filter(node => (node.localName || node.nodeName.split(':').pop()) === name);}
function directChildren(parent: Element, name: string): Element[] {return Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1 && (node as Element).localName === name);}

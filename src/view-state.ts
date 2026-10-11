import { validateColumnFilters, type ColumnFilter } from './table-view';

export const VIEW_STATE_STORAGE_KEY = 'spreadsheet-viewer.viewState.v1';
export const MAX_VIEW_STATE_BYTES = 256 * 1024;
export const MAX_VIEW_STATE_FILES = 100;

export type ViewMode = 'edit' | 'preview';
export interface ViewSortCriterion { column: number; direction: 'asc' | 'desc'; mode: 'text' | 'number'; }
export interface SheetViewState {
	schema: string;
	query: string;
	selection?: { row: number; column: number };
	scroll: { top: number; left: number };
	sort: ViewSortCriterion[];
	filters: ColumnFilter[];
	columnWidths: Record<string, number>;
	rowHeights: Record<string, number>;
	showComments: boolean;
	searchAllRows: boolean;
}

export function createHeaderSignature(values: readonly string[]): string {
	let hash = 0x811c9dc5;
	for (const character of values.join('\u0000')) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}
export interface ViewStateV1 {
	version: 1;
	uri: string;
	mode: ViewMode;
	schema: string;
	activeSheetId: string;
	sheets: Record<string, SheetViewState>;
	updatedAt: number;
}

export interface ViewStateMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export interface ViewStateRead { state?: ViewStateV1; corrupted: boolean; }

/** Workspace-wide, bounded view preferences. Invalid records are ignored without touching backups or drafts. */
export class ViewStateRepository {
	private records: Record<string, unknown> | undefined;
	private loadFailed = false;
	private lastTimestamp = 0;

	constructor(private readonly memento: ViewStateMemento) {}

	read(uri: string, mode: ViewMode): ViewStateRead {
		const records = this.load();
		if (this.loadFailed) {return { corrupted: true };}
		const key = recordKey(uri, mode);
		const raw = records[key];
		if (raw === undefined) {return { corrupted: false };}
		const state = validateViewState(raw, uri, mode);
		if (!state) {
			delete records[key];
			void this.persist(records);
			return { corrupted: true };
		}
		state.updatedAt = this.timestamp();
		records[key] = state;
		void this.persist(records);
		return { state, corrupted: false };
	}

	write(value: unknown, uri: string, mode: ViewMode): boolean {
		const state = validateViewState(value, uri, mode);
		if (!state || byteSize(state) > MAX_VIEW_STATE_BYTES) {return false;}
		const records = this.load();
		if (this.loadFailed) {return false;}
		state.updatedAt = this.timestamp();
		records[recordKey(uri, mode)] = state;
		const newestByUri = new Map<string, number>();
		for (const [key, record] of Object.entries(records)) {
			const recordUri = uriFromRecordKey(key);
			newestByUri.set(recordUri, Math.max(newestByUri.get(recordUri) ?? 0, recordTimestamp(record)));
		}
		const retainedUris = new Set([...newestByUri.entries()].sort((left, right) => right[1] - left[1])
			.slice(0, MAX_VIEW_STATE_FILES).map(([recordUri]) => recordUri));
		for (const key of Object.keys(records)) {if (!retainedUris.has(uriFromRecordKey(key))) {delete records[key];}}
		void this.persist(records);
		return true;
	}

	remove(uri: string, mode: ViewMode): void {
		const records = this.load();
		if (this.loadFailed) {this.resetCorruptStore(); return;}
		delete records[recordKey(uri, mode)];
		void this.persist(records);
	}

	resetCorruptStore(): void {
		this.records = {};
		this.loadFailed = false;
		void this.persist(this.records);
	}

	private load(): Record<string, unknown> {
		if (this.records) {return this.records;}
		const raw: unknown = this.memento.get(VIEW_STATE_STORAGE_KEY);
		if (raw === undefined) {this.records = {}; return this.records;}
		if (!isPlainObject(raw) || byteSize(raw) > MAX_VIEW_STATE_FILES * MAX_VIEW_STATE_BYTES) {
			this.records = {};
			this.loadFailed = true;
			return this.records;
		}
		this.records = raw;
		return this.records;
	}

	private persist(records: Record<string, unknown>): Promise<void> {
		return Promise.resolve(this.memento.update(VIEW_STATE_STORAGE_KEY, records)).catch(() => undefined);
	}

	private timestamp(): number {
		this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
		return this.lastTimestamp;
	}
}

export function validateViewState(value: unknown, uri: string, mode: ViewMode): ViewStateV1 | undefined {
	if (!isPlainObject(value) || value.version !== 1 || value.uri !== uri || value.mode !== mode
		|| !isBoundedString(value.schema, 256) || !isBoundedString(value.activeSheetId, 512)
		|| !Number.isFinite(value.updatedAt) || !isPlainObject(value.sheets)) {return undefined;}
	const entries = Object.entries(value.sheets);
	if (entries.length > 256) {return undefined;}
	const sheets = Object.create(null) as Record<string, SheetViewState>;
	for (const [sheetId, rawSheet] of entries) {
		if (!isBoundedString(sheetId, 512) || !isPlainObject(rawSheet)) {return undefined;}
		const parsed = validateSheetState(rawSheet);
		if (!parsed) {return undefined;}
		sheets[sheetId] = parsed;
	}
	const state: ViewStateV1 = { version: 1, uri, mode, schema: value.schema, activeSheetId: value.activeSheetId,
		sheets, updatedAt: value.updatedAt };
	return byteSize(state) <= MAX_VIEW_STATE_BYTES ? state : undefined;
}

function validateSheetState(value: Record<string, unknown>): SheetViewState | undefined {
	if (!isBoundedString(value.schema, 128) || typeof value.query !== 'string' || value.query.length > 2048 || !isPlainObject(value.scroll)
		|| !isFiniteBetween(value.scroll.top, 0, 1_000_000_000) || !isFiniteBetween(value.scroll.left, 0, 1_000_000_000)
		|| !Array.isArray(value.sort) || value.sort.length > 256 || !isPlainObject(value.columnWidths)
		|| !isPlainObject(value.rowHeights) || typeof value.showComments !== 'boolean'
		|| (value.searchAllRows !== undefined && typeof value.searchAllRows !== 'boolean')) {return undefined;}
	let selection: SheetViewState['selection'];
	if (value.selection !== undefined) {
		if (!isPlainObject(value.selection) || !isIntegerBetween(value.selection.row, 0, 50_000)
			|| !isIntegerBetween(value.selection.column, 0, 256)) {return undefined;}
		selection = { row: value.selection.row, column: value.selection.column };
	}
	const sort: ViewSortCriterion[] = [];
	for (const criterion of value.sort) {
		if (!isPlainObject(criterion) || !isIntegerBetween(criterion.column, 0, 255)
			|| (criterion.direction !== 'asc' && criterion.direction !== 'desc')
			|| (criterion.mode !== 'text' && criterion.mode !== 'number')) {return undefined;}
		sort.push({ column: criterion.column, direction: criterion.direction, mode: criterion.mode });
	}
	const filters = validateColumnFilters(value.filters ?? [], 256);
	if (!filters) {return undefined;}
	const columnWidths = validateSizeMap(value.columnWidths, 256, 48, 800);
	const rowHeights = validateSizeMap(value.rowHeights, 50_000, 20, 600);
	if (!columnWidths || !rowHeights) {return undefined;}
	return { schema: value.schema, query: value.query, selection, scroll: { top: value.scroll.top, left: value.scroll.left }, sort,
		filters, columnWidths, rowHeights, showComments: value.showComments, searchAllRows: value.searchAllRows === true };
}

function validateSizeMap(value: Record<string, unknown>, maximumEntries: number, minimum: number, maximum: number): Record<string, number> | undefined {
	const entries = Object.entries(value);
	if (entries.length > maximumEntries) {return undefined;}
	const result: Record<string, number> = {};
	for (const [key, size] of entries) {
		if (!/^\d+$/.test(key) || Number(key) >= maximumEntries || !isFiniteBetween(size, minimum, maximum)) {return undefined;}
		result[key] = size;
	}
	return result;
}

function recordKey(uri: string, mode: ViewMode): string {return `${mode}:${uri}`;}
function uriFromRecordKey(key: string): string {return key.slice(key.indexOf(':') + 1);}
function recordTimestamp(value: unknown): number {return isPlainObject(value) && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;}
function isPlainObject(value: unknown): value is Record<string, any> {return typeof value === 'object' && value !== null && !Array.isArray(value);}
function isBoundedString(value: unknown, maximum: number): value is string {return typeof value === 'string' && value.length > 0 && value.length <= maximum;}
function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {return Number.isInteger(value) && (value as number) >= minimum && (value as number) < maximum;}
function isFiniteBetween(value: unknown, minimum: number, maximum: number): value is number {return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;}
function byteSize(value: unknown): number {return new TextEncoder().encode(JSON.stringify(value)).byteLength;}

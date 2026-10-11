import type { ViewMode, ViewStateV1 } from './view-state';

export interface FormulaEvaluation {
	readonly status: 'calculated' | 'unsupported' | 'error';
	readonly value: string;
	readonly reason?: 'unsupported-function' | 'invalid-name' | 'formula-error' | 'spill' | 'date-format' | 'date-system';
}

/** Minimal startup handshake shared by the extension and its webview. */
export interface WebviewReadyMessage {
	type: 'ready';
}

export interface ReloadFileMessage {
	type: 'reloadFile';
}

export interface SelectSheetMessage {
	type: 'selectSheet';
	documentId: string;
	revision: number;
	sheetIndex: number;
	sheetId: string;
	requestId: number;
}

export interface InvalidCellMessage {
	type: 'invalidCell';
}

export interface EditCellMessage {
	type: 'editCell';
	documentId: string;
	revision: number;
	sheetIndex: number;
	sheetId: string;
	row: number;
	column: number;
	value: string;
}

export interface HistoryMessage {
	type: 'history';
	direction: 'undo' | 'redo';
}

export interface SetSortMessage {
	type: 'setSort'; documentId: string; sheetId: string; criteria: Array<{ column: number; direction: 'asc' | 'desc'; mode: 'text' | 'number' }>;
}

export interface PersistViewStateMessage {
	type: 'persistViewState'; mode: ViewMode;
	state: Pick<ViewStateV1, 'schema' | 'activeSheetId' | 'sheets'>;
}
export interface ResetViewMessage { type: 'resetView'; mode: ViewMode; }

export interface DraftStateMessage {
	type: 'draftState';
	dirty: boolean;
	documentId: string;
	revision: number;
	sheetIndex: number;
	sheetId: string;
	row: number;
	column: number;
	value: string;
}

export type WebviewToExtensionMessage = WebviewReadyMessage | ReloadFileMessage | SelectSheetMessage | InvalidCellMessage | EditCellMessage | HistoryMessage | DraftStateMessage | SetSortMessage | PersistViewStateMessage | ResetViewMessage;

export interface ReloadStateMessage {
	type: 'reloadState';
	state: 'loading' | 'done' | 'cancelled' | 'error';
	message?: string;
}

export interface SortStateMessage { type: 'sortState'; criteria: Array<{ column: number; direction: 'asc' | 'desc'; mode: 'text' | 'number' }>; }
export interface RestoreViewStateMessage { type: 'restoreViewState'; mode: ViewMode; state?: ViewStateV1; corrupted?: boolean; reset?: boolean; }

export interface SaveStateMessage {
	type: 'saveState';
	state: 'clean' | 'pending' | 'saving' | 'saved' | 'error';
	message?: string;
}

export interface CsvDataMessage {
	type: 'csvData';
	documentId: string;
	sheetId: string;
	revision: number;
	fileName: string;
	rows: string[][];
	rowKinds?: Array<'data' | 'comment'>;
	physicalLines?: number[];
	rowComments?: Array<string | undefined>;
	headerLabels?: string[];
	formatSchema?: string;
	rowCount: number;
	columnCount: number;
	readonly?: boolean;
	sourceMode?: 'disk' | 'buffer' | 'csv-text';
	sourceStatus?: string;
}

export interface XlsxDataMessage {
	type: 'xlsxData';
	fileFormat?: 'xlsx' | 'ods';
	revision: number;
	documentId: string;
	sheetId: string;
	sheetIds: string[];
	fileName: string;
	sheetName: string;
	sheetNames: string[];
	activeSheetIndex: number;
	requestId?: number;
	rows: string[][];
	cellKinds: string[][];
	cellTypes: string[][];
	cellCapabilities: CellCapability[][];
	formulaCaches: Record<string, string>;
	workbookBase64?: string;
	rowCount: number;
	columnCount: number;
	warnings: string[];
	readonly?: boolean;
	sourceMode?: 'disk' | 'buffer' | 'csv-text';
	sourceStatus?: string;
}

export interface CellCapability {
	readonly storedType: string;
	readonly editable: boolean;
	readonly reason?: string;
}

export type ExtensionToWebviewMessage = CsvDataMessage | XlsxDataMessage | SaveStateMessage | ReloadStateMessage | SortStateMessage | RestoreViewStateMessage;


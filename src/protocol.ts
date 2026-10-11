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

export interface CopyToClipboardMessage { type: 'copyToClipboard'; text: string; }
export interface CopyButtonVisibilityMessage { type: 'copyButtonVisibility'; visible: boolean; }
export interface DisplayModeButtonVisibilityMessage { type: 'displayModeButtonVisibility'; visible: boolean; }
export interface CsvRowActionsVisibilityMessage { type: 'csvRowActionsVisibility'; visible: boolean; }
export interface FocusCellMessage { type: 'focusCell'; row: number; column: number; }
export interface CsvRowOperationMessage {
	type: 'csvRowOperation'; documentId: string; revision: number; sheetId: string;
	kind: 'insert' | 'append' | 'delete'; index?: number; rows?: number[];
}
export interface RecoveredDraft { sheetIndex: number; row: number; column: number; value: string; }
export interface RestoreCellDraftMessage { type: 'restoreCellDraft'; draft: RecoveredDraft; }
export interface DiscardCellDraftMessage { type: 'discardCellDraft'; }
export interface DraftStateChangedMessage { type: 'draftStateChanged'; dirty: boolean; }

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

export interface EditCellsMessage {
	type: 'editCells'; documentId: string; revision: number; sheetIndex: number; sheetId: string;
	edits: Array<{ row: number; column: number; value: string; targetType?: 'string' | 'number' | 'boolean' | 'date' }>;
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
export interface DraftCaptureResultMessage { type: 'draftCaptureResult'; requestId: number; draft?: RecoveredDraft; }
export interface CaptureDraftMessage { type: 'captureDraft'; requestId: number; }

export type WebviewToExtensionMessage = WebviewReadyMessage | ReloadFileMessage | SelectSheetMessage | InvalidCellMessage | CopyToClipboardMessage | EditCellMessage | EditCellsMessage | CsvRowOperationMessage | HistoryMessage | DraftStateMessage | DraftCaptureResultMessage | SetSortMessage | PersistViewStateMessage | ResetViewMessage;

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
	recoveredDraft?: RecoveredDraft;
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
	cellStyleIndexes?: Array<Array<number | undefined>>;
	cellNumberFormats?: Array<{ numberFormatId: number; formatCode?: string }>;
	date1904?: boolean;
	workbookBase64?: string;
	rowCount: number;
	columnCount: number;
	warnings: string[];
	readonly?: boolean;
	sourceMode?: 'disk' | 'buffer' | 'csv-text';
	sourceStatus?: string;
	recoveredDraft?: RecoveredDraft;
}

export interface CellCapability {
	readonly storedType: string;
	readonly editable: boolean;
	readonly reason?: string;
}

export interface ResetViewButtonVisibilityMessage { type: 'resetViewButtonVisibility'; visible: boolean; }
export interface ClearSortButtonVisibilityMessage { type: 'clearSortButtonVisibility'; visible: boolean; }

export type ExtensionToWebviewMessage = CsvDataMessage | XlsxDataMessage | SaveStateMessage | ReloadStateMessage | SortStateMessage | RestoreViewStateMessage | ResetViewButtonVisibilityMessage | ClearSortButtonVisibilityMessage | CopyButtonVisibilityMessage | DisplayModeButtonVisibilityMessage | CsvRowActionsVisibilityMessage | FocusCellMessage | RestoreCellDraftMessage | DiscardCellDraftMessage | DraftStateChangedMessage | CaptureDraftMessage;


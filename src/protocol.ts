export interface FormulaEvaluation {
	readonly status: 'calculated' | 'unsupported' | 'error';
	readonly value: string;
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
	sheetIndex: number;
	requestId: number;
}

export interface InvalidCellMessage {
	type: 'invalidCell';
}

export interface EditCellMessage {
	type: 'editCell';
	sheetIndex: number;
	row: number;
	column: number;
	value: string;
}

export interface HistoryMessage {
	type: 'history';
	direction: 'undo' | 'redo';
}

export interface DraftStateMessage {
	type: 'draftState';
	dirty: boolean;
	sheetIndex: number;
	row: number;
	column: number;
	value: string;
}

export type WebviewToExtensionMessage = WebviewReadyMessage | ReloadFileMessage | SelectSheetMessage | InvalidCellMessage | EditCellMessage | HistoryMessage | DraftStateMessage;

export interface ReloadStateMessage {
	type: 'reloadState';
	state: 'loading' | 'done' | 'cancelled' | 'error';
	message?: string;
}

export interface SaveStateMessage {
	type: 'saveState';
	state: 'clean' | 'pending' | 'saving' | 'saved' | 'error';
	message?: string;
}

export interface CsvDataMessage {
	type: 'csvData';
	revision: number;
	fileName: string;
	rows: string[][];
	rowCount: number;
	columnCount: number;
}

export interface XlsxDataMessage {
	type: 'xlsxData';
	fileFormat?: 'xlsx' | 'ods';
	revision: number;
	fileName: string;
	sheetName: string;
	sheetNames: string[];
	activeSheetIndex: number;
	requestId?: number;
	rows: string[][];
	cellKinds: string[][];
	formulaCaches: Record<string, string>;
	workbookBase64?: string;
	rowCount: number;
	columnCount: number;
	warnings: string[];
}

export type ExtensionToWebviewMessage = CsvDataMessage | XlsxDataMessage | SaveStateMessage | ReloadStateMessage;


import Papa = require('papaparse');

export const MAX_CSV_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 256;
const MAX_RECTANGLE_CELLS = 1_000_000;
const MAX_PRESENT_CELLS = 500_000;

export interface CsvTable {
	readonly rows: string[][];
	readonly rowCount: number;
	readonly columnCount: number;
	readonly delimiter: string;
	readonly quoteChar: string;
	readonly quotes: boolean;
	readonly preamble: string;
	readonly persistDelimiter: boolean;
	readonly encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
	readonly sourceText: string;
	readonly sourceBytes: Uint8Array;
	readonly bom: Uint8Array;
	readonly fieldSpans: CsvRecordSpan[];
}

export interface CsvFieldSpan {
	readonly start: number;
	readonly end: number;
	readonly quoted: boolean;
}

export interface CsvRecordSpan {
	readonly fields: CsvFieldSpan[];
	readonly end: number;
}

export interface CsvCellEdit {
	readonly row: number;
	readonly column: number;
	readonly value: string;
}

export interface CsvParseOptions { delimiter?: string; quoteChar?: string; quotes?: boolean; persistDelimiter?: boolean; }

export class CsvDelimiterAmbiguityError extends Error {
	constructor(readonly delimiters: string[]) { super('El delimitador del archivo CSV es ambiguo.'); }
}

export function parseCsvBytes(bytes: Uint8Array, options: CsvParseOptions = {}): CsvTable {
	if (bytes.byteLength > MAX_CSV_BYTES) {
		throw new Error(`El CSV excede el límite de ${MAX_CSV_BYTES / (1024 * 1024)} MiB.`);
	}

	const { text, encoding, bom } = decodeCsv(bytes);
	if (text.length === 0) {
		return {
			rows: [], rowCount: 0, columnCount: 0, delimiter: options.delimiter ?? ',', quoteChar: options.quoteChar ?? '"', quotes: options.quotes ?? true, preamble: '', persistDelimiter: options.persistDelimiter ?? false, encoding,
			sourceText: text, sourceBytes: bytes.slice(), bom, fieldSpans: [],
		};
	}

	const directive = /^(?:\uFEFF)?sep=(.)\r?\n/i.exec(text);
	const preamble = directive?.[0] ?? '';
	const body = text.slice(preamble.length);
	const quoteChar = options.quoteChar ?? '"';
	const quotes = options.quotes ?? true;
	const delimiter = options.delimiter ?? directive?.[1] ?? detectDelimiter(body, quotes ? quoteChar : '\u0000');
	const result = Papa.parse<string[]>(body, { header: false, dynamicTyping: false, skipEmptyLines: false,
		comments: false, delimiter, quoteChar: quotes ? quoteChar : '\u0000' });

	const errors = result.errors.filter(error =>
		error.code !== 'UndetectableDelimiter',
	);
	if (errors.length > 0) {
		const detail = errors.map(error => {
			const line = error.row === undefined ? '' : `fila ${error.row + 1}: `;
			return `${line}${error.message}`;
		}).join('; ');
		throw new Error(`No se pudo interpretar el CSV: ${detail}`);
	}

	const rows = result.data;
	if (hasTerminalRecordBreak(body) && isEmptyRecord(rows[rows.length - 1])) {
		rows.pop();
	}

	const columnCount = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
	const presentCells = rows.reduce((total, row) => total + row.length, 0);
	if (rows.length > MAX_ROWS) {
		throw new Error(`El CSV excede el límite de ${MAX_ROWS.toLocaleString('es')} filas.`);
	}
	if (columnCount > MAX_COLUMNS) {
		throw new Error(`El CSV excede el límite de ${MAX_COLUMNS} columnas.`);
	}
	if (rows.length * columnCount > MAX_RECTANGLE_CELLS || presentCells > MAX_PRESENT_CELLS) {
		throw new Error('El CSV excede el límite de celdas que se pueden mostrar.');
	}
	const fieldSpans = scanCsvFieldSpans(body, delimiter, quoteChar, quotes).map(record => ({
		...record, end: record.end + preamble.length,
		fields: record.fields.map(field => ({ ...field, start: field.start + preamble.length, end: field.end + preamble.length })),
	}));
	if (fieldSpans.length !== rows.length
		|| fieldSpans.some((record, index) => record.fields.length !== rows[index].length)) {
		throw new Error('No se pudo conservar la estructura original de los campos CSV para editar con seguridad.');
	}

	return {
		rows,
		rowCount: rows.length,
		columnCount,
		delimiter, quoteChar, quotes, preamble, persistDelimiter: options.persistDelimiter ?? false,
		encoding,
		sourceText: text,
		sourceBytes: bytes.slice(),
		bom,
		fieldSpans,
	};
}

/** Serializes edits by replacing only changed fields in the original CSV text. */
export function serializeCsvEdits(table: CsvTable, edits: readonly CsvCellEdit[]): Uint8Array {
	if (edits.length === 0) {
		return table.sourceBytes.slice();
	}
	const byRow = new Map<number, Map<number, string>>();
	for (const edit of edits) {
		if (!Number.isInteger(edit.row) || !Number.isInteger(edit.column)
			|| edit.row < 0 || edit.row >= table.rowCount
			|| edit.column < 0 || edit.column >= table.columnCount) {
			throw new Error('La celda CSV está fuera del rango actual.');
		}
		let row = byRow.get(edit.row);
		if (!row) {
			row = new Map();
			byRow.set(edit.row, row);
		}
		row.set(edit.column, edit.value);
	}

	const patches: TextPatch[] = [];
	for (const [rowIndex, rowEdits] of byRow) {
		const record = table.fieldSpans[rowIndex];
		for (const [column, value] of rowEdits) {
			const field = record.fields[column];
			if (field) {
				patches.push({
					start: field.start,
					end: field.end,
					replacement: encodeCsvField(value, table.delimiter, table.quoteChar, table.quotes, field.quoted),
					append: false,
				});
			}
		}
		const absentColumns = [...rowEdits.keys()].filter(column => column >= record.fields.length);
		if (absentColumns.length > 0) {
			const lastColumn = Math.max(...absentColumns);
			const appendedFields: string[] = [];
			for (let column = record.fields.length; column <= lastColumn; column++) {
				const value = rowEdits.get(column) ?? '';
				appendedFields.push(encodeCsvField(value, table.delimiter, table.quoteChar, table.quotes, false));
			}
			patches.push({
				start: record.end,
				end: record.end,
				replacement: `${table.delimiter}${appendedFields.join(table.delimiter)}`,
				append: true,
			});
		}
	}

	let outputText = table.sourceText;
	patches.sort((left, right) => right.start - left.start
		|| right.end - left.end
		|| Number(right.append) - Number(left.append));
	for (const patch of patches) {
		outputText = outputText.slice(0, patch.start) + patch.replacement + outputText.slice(patch.end);
	}
	if (table.persistDelimiter && !table.preamble && table.delimiter !== ',') {
		outputText = `sep=${table.delimiter}\r\n${outputText}`;
	}
	return encodeCsvText(outputText, table.encoding, table.bom);
}

function detectDelimiter(text: string, quoteChar: string): string {
	const candidates = [',', ';', '\t', '|'].map(delimiter => ({
		delimiter,
		result: Papa.parse<string[]>(text, {
			header: false,
			dynamicTyping: false,
			skipEmptyLines: false,
			comments: false,
			delimiter,
			quoteChar,
		}),
	}));
	const valid = candidates.filter(candidate => candidate.result.errors.length === 0);
	const choices = valid.length > 0 ? valid : candidates;
	const scored = choices.map(candidate => ({ candidate, score: delimiterScore(candidate.result.data) }));
	const maximumColumns = Math.max(...scored.map(item => item.score.columns));
	const maximumConsistency = Math.max(...scored.filter(item => item.score.columns === maximumColumns).map(item => item.score.consistentRows));
	const tied = scored.filter(item => item.score.columns === maximumColumns && item.score.consistentRows === maximumConsistency);
	if (maximumColumns > 1 && tied.length > 1) {throw new CsvDelimiterAmbiguityError(tied.map(item => item.candidate.delimiter));}
	const best = choices.reduce((currentBest, candidate) => {
		const bestScore = delimiterScore(currentBest.result.data);
		const candidateScore = delimiterScore(candidate.result.data);
		if (candidateScore.columns > bestScore.columns
			|| (candidateScore.columns === bestScore.columns && candidateScore.consistentRows > bestScore.consistentRows)) {
			return candidate;
		}
		return currentBest;
	});
	return delimiterScore(best.result.data).columns <= 1 ? ',' : best.delimiter;
}

function delimiterScore(rows: string[][]): { columns: number; consistentRows: number } {
	const nonEmptyRows = rows.filter(row => !isEmptyRecord(row));
	const columns = nonEmptyRows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
	const consistentRows = nonEmptyRows.filter(row => row.length === columns).length;
	return { columns, consistentRows };
}

function decodeCsv(bytes: Uint8Array): { text: string; encoding: CsvTable['encoding']; bom: Uint8Array } {
	let encoding: CsvTable['encoding'] = 'utf-8';
	let bomLength = 0;
	if (bytes[0] === 0xff && bytes[1] === 0xfe) {
		encoding = 'utf-16le';
		bomLength = 2;
	} else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
		encoding = 'utf-16be';
		bomLength = 2;
	} else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		bomLength = 3;
	}

	try {
		return {
			text: new TextDecoder(encoding, { fatal: true }).decode(bytes),
			encoding,
			bom: bytes.slice(0, bomLength),
		};
	} catch {
		throw new Error('La codificación del CSV no es válida o no está admitida. Usa UTF-8 o UTF-16 con BOM.');
	}
}

interface TextPatch {
	readonly start: number;
	readonly end: number;
	readonly replacement: string;
	readonly append: boolean;
}

function scanCsvFieldSpans(text: string, delimiter: string, quoteChar: string, quotes: boolean): CsvRecordSpan[] {
	const records: CsvRecordSpan[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const fields: CsvFieldSpan[] = [];
		let recordComplete = false;
		while (!recordComplete) {
			const start = cursor;
			const quoted = quotes && text[cursor] === quoteChar;
			if (quoted) {
				cursor++;
				while (cursor < text.length) {
					if (text[cursor] !== quoteChar) {
						cursor++;
						continue;
					}
					if (text[cursor + 1] === quoteChar) {
						cursor += 2;
						continue;
					}
					cursor++;
					break;
				}
			} else {
				while (cursor < text.length && text[cursor] !== delimiter && !isRecordBreak(text[cursor])) {
					cursor++;
				}
			}
			fields.push({ start, end: cursor, quoted });
			if (cursor >= text.length) {
				records.push({ fields, end: cursor });
				recordComplete = true;
			} else if (text[cursor] === delimiter) {
				cursor++;
				if (cursor === text.length) {
					fields.push({ start: cursor, end: cursor, quoted: false });
					records.push({ fields, end: cursor });
					recordComplete = true;
				}
			} else {
				const recordEnd = cursor;
				cursor += text[cursor] === '\r' && text[cursor + 1] === '\n' ? 2 : 1;
				records.push({ fields, end: recordEnd });
				recordComplete = true;
			}
		}
	}
	return records;
}

function isRecordBreak(character: string): boolean {
	return character === '\r' || character === '\n';
}

function encodeCsvField(value: string, delimiter: string, quoteChar: string, quotes: boolean, preserveQuotes: boolean): string {
	if (!quotes && (value.includes(delimiter) || value.includes('\r') || value.includes('\n'))) {
		throw new Error('El valor contiene separadores o saltos de línea que el dialecto no puede representar con quoting desactivado.');
	}
	const mustQuote = quotes && (preserveQuotes
		|| value.includes(delimiter)
		|| value.includes(quoteChar)
		|| value.includes('\r')
		|| value.includes('\n')
		|| /^\s|\s$/u.test(value));
	if (!mustQuote) {
		return value;
	}
	return `${quoteChar}${value.split(quoteChar).join(quoteChar + quoteChar)}${quoteChar}`;
}

function encodeCsvText(text: string, encoding: CsvTable['encoding'], bom: Uint8Array): Uint8Array {
	let body: Uint8Array;
	if (encoding === 'utf-8') {
		body = new TextEncoder().encode(text);
	} else {
		body = new Uint8Array(text.length * 2);
		for (let index = 0; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (encoding === 'utf-16le') {
				body[index * 2] = code & 0xff;
				body[index * 2 + 1] = code >>> 8;
			} else {
				body[index * 2] = code >>> 8;
				body[index * 2 + 1] = code & 0xff;
			}
		}
	}
	const output = new Uint8Array(bom.length + body.length);
	output.set(bom);
	output.set(body, bom.length);
	return output;
}

function hasTerminalRecordBreak(text: string): boolean {
	return text.endsWith('\n') || text.endsWith('\r');
}

function isEmptyRecord(row: string[] | undefined): boolean {
	return row?.length === 1 && row[0] === '';
}

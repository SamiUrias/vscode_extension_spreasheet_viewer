import { format, is_date } from 'ssf';
import type { XlsxDataMessage } from '../protocol';

export type CellPresentation = 'raw' | 'book';

/** Formats an XLSX numeric cell for display only. Raw document values remain untouched. */
export function presentXlsxCell(snapshot: XlsxDataMessage, row: number, column: number, raw: string, mode: CellPresentation): string {
	if (mode !== 'book' || snapshot.fileFormat !== 'xlsx' || snapshot.cellKinds[row]?.[column] === 'formula') {
		return raw;
	}
	const storedType = snapshot.cellTypes[row]?.[column];
	if (storedType === 'boolean') {return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;}
	// Excel stores at most 15 significant decimal digits. Preserve the source lexeme when
	// it exceeds that precision instead of displaying a rounded approximation.
	const style = snapshot.cellStyleIndexes?.[row]?.[column] ?? 0;
	const numberFormat = Number.isInteger(style) ? snapshot.cellNumberFormats?.[style] : undefined;
	if (!numberFormat || numberFormat.numberFormatId === 0) {return raw;}
	let fmt: string | number = numberFormat.numberFormatId;
	if (numberFormat.formatCode !== undefined) {
		if (numberFormat.formatCode.length > 255) {return raw;}
		if (numberFormat.formatCode.length > 0) {fmt = numberFormat.formatCode;}
	}
	const numeric = storedType === 'number' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)
		? Number(raw) : storedType === 'date' && isDateFormat(fmt) ? isoDateToExcelSerial(raw, snapshot.date1904 === true) : undefined;
	if (numeric === undefined || !Number.isFinite(numeric) || (storedType === 'number' && significantDigits(raw) > 15)) {return raw;}
	try {
		return format(fmt, numeric, { date1904: snapshot.date1904 === true });
	} catch {
		return raw;
	}
}

function isDateFormat(fmt: string | number): boolean {
	if (typeof fmt === 'number') {return (fmt >= 14 && fmt <= 22) || (fmt >= 27 && fmt <= 36) || (fmt >= 45 && fmt <= 47) || (fmt >= 50 && fmt <= 58);}
	return is_date(fmt);
}

function isoDateToExcelSerial(raw: string, date1904: boolean): number | undefined {
	const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
	const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(raw);
	if (!isDateOnly && (!hasZone || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw))) {return undefined;}
	const milliseconds = Date.parse(raw);
	if (!Number.isFinite(milliseconds)) {return undefined;}
	if (isDateOnly) {
		const [year, month, day] = raw.split('-').map(Number);
		const date = new Date(milliseconds);
		if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {return undefined;}
	}
	const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
	let serial = (milliseconds - epoch) / 86_400_000;
	if (!date1904 && serial >= 60) {serial += 1;}
	return serial;
}

function significantDigits(raw: string): number {
	const mantissa = raw.split(/[eE]/, 1)[0]!.replace(/^[+-]/, '');
	const normalized = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
	return normalized.replace('.', '').replace(/^0+/, '').length;
}

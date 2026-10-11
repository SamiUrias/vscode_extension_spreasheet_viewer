export type FillDirection = 'down' | 'right';
export type FillMode = 'repeat' | 'series';

export interface FillCell { readonly value: string; readonly type?: 'string' | 'number' | 'boolean' | 'date'; }
export interface FillEdit { readonly row: number; readonly column: number; readonly value: string; readonly targetType?: 'string' | 'number' | 'boolean' | 'date'; }

/** Build edits from the selected source block, repeating it or extending a numeric sequence. */
export function createFillEdits(
	source: readonly (readonly FillCell[])[],
	startRow: number,
	startColumn: number,
	targetHeight: number,
	targetWidth: number,
	direction: FillDirection,
	mode: FillMode,
	maxCells = 100_000,
): FillEdit[] {
	if (!source.length || source.some(row => !row.length || row.length !== source[0]!.length)) {throw new Error('El bloque de origen debe ser rectangular y no estar vacío.');}
	if (![startRow, startColumn, targetHeight, targetWidth].every(Number.isInteger) || startRow < 0 || startColumn < 0 || targetHeight < 1 || targetWidth < 1) {throw new Error('El destino no es válido.');}
	if (targetHeight * targetWidth > maxCells) {throw new Error(`El rango supera el límite de ${maxCells.toLocaleString()} celdas por operación.`);}
	if (direction === 'down' && source.length > targetHeight || direction === 'right' && source[0]!.length > targetWidth) {throw new Error('El bloque de origen debe caber dentro del destino.');}
	const sourceHeight = source.length, sourceWidth = source[0]!.length;
	if (mode === 'series' && (direction === 'down' ? sourceHeight : sourceWidth) < 2) {throw new Error('Para crear una serie selecciona al menos dos valores numéricos de referencia.');}
	const stepValues = mode === 'series' ? source.map(row => row.slice()) : undefined;
	const edits: FillEdit[] = [];
	for (let r = 0; r < targetHeight; r++) {
		for (let c = 0; c < targetWidth; c++) {
			if (direction === 'down' && r < sourceHeight || direction === 'right' && c < sourceWidth) {continue;}
			const sourceCell = source[r % sourceHeight]![c % sourceWidth]!;
			let value = sourceCell.value;
			let targetType = sourceCell.type;
			if (mode === 'series') {
				const axisIndex = direction === 'down' ? r : c;
				const axisLength = direction === 'down' ? sourceHeight : sourceWidth;
				const lane = direction === 'down' ? c : r;
				const first = direction === 'down' ? stepValues![0]![lane % sourceWidth]! : stepValues![lane % sourceHeight]![0]!;
				const second = direction === 'down' ? stepValues![1]![lane % sourceWidth]! : stepValues![lane % sourceHeight]![1]!;
				value = addDecimalSeries(first.value, second.value, axisIndex - axisLength + 2);
				targetType = first.type === 'number' && second.type === 'number' ? 'number' : 'string';
			}
			edits.push({ row: startRow + r, column: startColumn + c, value, ...(targetType ? { targetType } : {}) });
		}
	}
	return edits;
}

function addDecimalSeries(first: string, second: string, multiplier: number): string {
	const left = decimal(first), right = decimal(second);
	if (!left || !right) {throw new Error('La serie requiere valores numéricos decimales válidos.');}
	const scale = Math.max(left.scale, right.scale);
	const a = left.coefficient * 10n ** BigInt(scale - left.scale);
	const b = right.coefficient * 10n ** BigInt(scale - right.scale);
	return formatDecimal(a + (b - a) * BigInt(multiplier), scale);
}

function decimal(value: string): { coefficient: bigint; scale: number } | undefined {
	if (value.length > 256) {return undefined;}
	const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value);
	if (!match) {return undefined;}
	const fraction = match[3] ?? '';
	const exponent = Number(match[4] ?? '0');
	if (!Number.isInteger(exponent) || Math.abs(exponent) > 128) {return undefined;}
	let scale = fraction.length - exponent;
	let coefficient = BigInt(`${match[2]}${fraction}`) * (match[1] === '-' ? -1n : 1n);
	if (scale < 0) {coefficient *= 10n ** BigInt(-scale); scale = 0;}
	return { coefficient, scale };
}

function formatDecimal(coefficient: bigint, scale: number): string {
	const negative = coefficient < 0n;
	const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
	if (scale === 0) {return `${negative ? '-' : ''}${digits}`;}
	const integer = digits.slice(0, -scale);
	const fraction = digits.slice(-scale).replace(/0+$/, '');
	return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

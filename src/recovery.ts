import { createHash } from 'node:crypto';

const MAGIC = 'SPREADSHEET-VIEWER-RECOVERY\n';
const MAX_RECOVERY_BYTES = 32 * 1024 * 1024;

export interface RecoveryDraft {
	readonly sheetIndex: number; readonly row: number; readonly column: number; readonly value: string;
}

export interface RecoveryEnvelopeV1 {
	readonly uri: string;
	readonly baselineBytes: Uint8Array;
	readonly workingBytes: Uint8Array;
	readonly draft?: RecoveryDraft;
}

interface SerializedEnvelopeV1 {
	readonly format: 'spreadsheet-viewer-recovery'; readonly version: 1; readonly uri: string;
	readonly baseline: string; readonly baselineSha256: string;
	readonly working: string; readonly workingSha256: string;
	readonly draft?: RecoveryDraft;
}

export function serializeRecoveryEnvelope(envelope: RecoveryEnvelopeV1): Uint8Array {
	const serialized: SerializedEnvelopeV1 = {
		format: 'spreadsheet-viewer-recovery', version: 1, uri: envelope.uri,
		baseline: Buffer.from(envelope.baselineBytes).toString('base64'), baselineSha256: sha256(envelope.baselineBytes),
		working: Buffer.from(envelope.workingBytes).toString('base64'), workingSha256: sha256(envelope.workingBytes),
		...(envelope.draft ? { draft: envelope.draft } : {}),
	};
	const bytes = new TextEncoder().encode(`${MAGIC}${JSON.stringify(serialized)}`);
	if (bytes.byteLength > MAX_RECOVERY_BYTES) {throw new Error('La copia de recuperación supera el límite admitido.');}
	return bytes;
}

/** Returns undefined for legacy raw-file backups; malformed versioned backups are rejected. */
export function parseRecoveryEnvelope(bytes: Uint8Array): RecoveryEnvelopeV1 | undefined {
	if (bytes.byteLength > MAX_RECOVERY_BYTES) {throw new Error('La copia de recuperación supera el límite admitido.');}
	const magic = new TextEncoder().encode(MAGIC);
	if (bytes.length < magic.length || magic.some((byte, index) => bytes[index] !== byte)) {return undefined;}
	const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	let candidate: unknown;
	try {candidate = JSON.parse(text.slice(MAGIC.length));}
	catch {throw new Error('La copia de recuperación está dañada.');}
	if (!isEnvelope(candidate)) {throw new Error('La versión o estructura de la copia de recuperación no es compatible.');}
	const baselineBytes = Buffer.from(candidate.baseline, 'base64');
	const workingBytes = Buffer.from(candidate.working, 'base64');
	if (sha256(baselineBytes) !== candidate.baselineSha256 || sha256(workingBytes) !== candidate.workingSha256) {
		throw new Error('La verificación de integridad de la copia de recuperación falló.');
	}
	return { uri: candidate.uri, baselineBytes, workingBytes, ...(candidate.draft ? { draft: candidate.draft } : {}) };
}

function isEnvelope(value: unknown): value is SerializedEnvelopeV1 {
	if (typeof value !== 'object' || value === null) {return false;}
	const item = value as Record<string, unknown>;
	if (item.format !== 'spreadsheet-viewer-recovery' || item.version !== 1 || typeof item.uri !== 'string'
		|| typeof item.baseline !== 'string' || typeof item.working !== 'string'
		|| typeof item.baselineSha256 !== 'string' || typeof item.workingSha256 !== 'string') {return false;}
	if (item.draft === undefined) {return true;}
	if (typeof item.draft !== 'object' || item.draft === null) {return false;}
	const draft = item.draft as Record<string, unknown>;
	return Number.isInteger(draft.sheetIndex) && Number(draft.sheetIndex) >= 0 && Number(draft.sheetIndex) < 50
		&& Number.isInteger(draft.row) && Number(draft.row) >= 0 && Number(draft.row) < 50_000
		&& Number.isInteger(draft.column) && Number(draft.column) >= 0 && Number(draft.column) < 256
		&& typeof draft.value === 'string' && draft.value.length <= 10 * 1024 * 1024;
}

function sha256(bytes: Uint8Array): string {return createHash('sha256').update(bytes).digest('hex');}

import * as assert from 'node:assert/strict';
import { parseRecoveryEnvelope, serializeRecoveryEnvelope } from '../recovery';

suite('recovery envelope', () => {
	test('round-trips baseline, working bytes, URI, and an uncommitted cell draft', async () => {
		const envelope = { uri: 'file:///work/data.csv', baselineBytes: new TextEncoder().encode('a,b\n1,2'), workingBytes: new TextEncoder().encode('a,b\n1,3'), draft: { sheetIndex: 0, row: 1, column: 0, value: 'draft' } };
		const restored = await parseRecoveryEnvelope(await serializeRecoveryEnvelope(envelope));
		assert.equal(restored?.uri, envelope.uri);
		assert.deepStrictEqual(Array.from(restored?.baselineBytes ?? []), Array.from(envelope.baselineBytes));
		assert.deepStrictEqual(Array.from(restored?.workingBytes ?? []), Array.from(envelope.workingBytes));
		assert.deepStrictEqual(restored?.draft, envelope.draft);
	});
	test('recognizes old raw-file backups and rejects corrupted versioned backups', async () => {
		assert.equal(await parseRecoveryEnvelope(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), undefined);
		const bytes = await serializeRecoveryEnvelope({ uri: 'file:///data.csv', baselineBytes: new Uint8Array([1]), workingBytes: new Uint8Array([2]) });
		bytes[bytes.length - 1] ^= 1;
		await assert.rejects(parseRecoveryEnvelope(bytes), /dañada|integridad/);
	});
});

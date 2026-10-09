import * as assert from 'assert';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { replaceFile, readBackup, writeBackup, deleteBackup } from '../storage';

suite('Spreadsheet storage', () => {
	test('replaces a verified temporary copy and refuses an unexpected disk version', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'spreadsheet-viewer-storage-'));
		const uri = vscode.Uri.file(path.join(directory, 'data.csv'));
		const original = Buffer.from('a,b\n1,2\n');
		const updated = Buffer.from('a,b\n1,3\n');
		await writeFile(uri.fsPath, original);
		try {
			await replaceFile(uri, updated, original);
			assert.deepStrictEqual(await readFile(uri.fsPath), updated);
			await assert.rejects(replaceFile(uri, Buffer.from('bad'), original), /cambió en disco/);
			assert.deepStrictEqual(await readFile(uri.fsPath), updated);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('writes and restores a custom-editor backup', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'spreadsheet-viewer-backup-'));
		const uri = vscode.Uri.file(path.join(directory, 'backup.bin'));
		const bytes = Buffer.from([0, 1, 2, 255]);
		try {
			await writeBackup(uri, bytes);
			assert.deepStrictEqual(await readBackup(uri.toString()), bytes);
			await deleteBackup(uri.toString());
			await assert.rejects(readBackup(uri.toString()));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

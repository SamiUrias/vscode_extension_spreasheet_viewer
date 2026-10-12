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
			await assert.rejects(replaceFile(uri, Buffer.from('bad'), original), error =>
				error instanceof Error && 'code' in error && error.code === 'external-file-conflict');
			assert.deepStrictEqual(await readFile(uri.fsPath), updated);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('refuses writes on a read-only provider before creating a temporary file', async () => {
		const provider = new MemoryFileSystemProvider();
		const registration = vscode.workspace.registerFileSystemProvider('spreadsheet-viewer-ro-test', provider, { isCaseSensitive: true, isReadonly: true });
		const uri = vscode.Uri.parse('spreadsheet-viewer-ro-test:/book.csv');
		provider.seed(uri, Buffer.from('a,b\n1,2\n'));
		try {
			await waitFor(() => vscode.workspace.fs.isWritableFileSystem(uri.scheme) !== undefined, 'read-only provider registration');
			assert.strictEqual(vscode.workspace.fs.isWritableFileSystem(uri.scheme), false);
			await assert.rejects(replaceFile(uri, Buffer.from('a,b\n1,3\n')), /no confirma permisos de escritura/);
			assert.deepStrictEqual(provider.read(uri), Buffer.from('a,b\n1,2\n'));
		} finally {registration.dispose();}
	});

	test('writes and verifies a writable non-file provider through workspace.fs', async () => {
		const provider = new MemoryFileSystemProvider();
		const registration = vscode.workspace.registerFileSystemProvider('spreadsheet-viewer-writable-test', provider, { isCaseSensitive: true });
		const uri = vscode.Uri.parse('spreadsheet-viewer-writable-test:/book.csv');
		const original = Buffer.from('a,b\n1,2\n');
		const updated = Buffer.from('a,b\n1,3\n');
		provider.seed(uri, original);
		try {
			await waitFor(() => vscode.workspace.fs.isWritableFileSystem(uri.scheme) !== undefined, 'writable provider registration');
			assert.strictEqual(vscode.workspace.fs.isWritableFileSystem(uri.scheme), true);
			await replaceFile(uri, updated, original);
			assert.deepStrictEqual(provider.read(uri), updated);
			assert.strictEqual(provider.fileCount, 1, 'temporary sibling is renamed into place');
		} finally {registration.dispose();}
	});

	test('preserves the original resource and its unsaved replacement when provider rename fails', async () => {
		const provider = new MemoryFileSystemProvider(true);
		const registration = vscode.workspace.registerFileSystemProvider('spreadsheet-viewer-rename-test', provider, { isCaseSensitive: true });
		const uri = vscode.Uri.parse('spreadsheet-viewer-rename-test:/book.csv');
		const original = Buffer.from('a,b\n1,2\n');
		const draft = Buffer.from('a,b\n1,3\n');
		provider.seed(uri, original);
		try {
			await waitFor(() => vscode.workspace.fs.isWritableFileSystem(uri.scheme) !== undefined, 'rename-test provider registration');
			assert.strictEqual(vscode.workspace.fs.isWritableFileSystem(uri.scheme), true);
			await assert.rejects(replaceFile(uri, draft, original), /simulated rename failure/);
			assert.deepStrictEqual(provider.read(uri), original);
			assert.deepStrictEqual(draft, Buffer.from('a,b\n1,3\n'), 'the caller retains the unsaved draft bytes');
			assert.strictEqual(provider.fileCount, 1, 'temporary sibling is cleaned up after failure');
		} finally {registration.dispose();}
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

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {assert.fail(`Timed out waiting for ${label} after ${timeoutMs}ms`);}
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}

class MemoryFileSystemProvider implements vscode.FileSystemProvider {
	private readonly files = new Map<string, Uint8Array>();
	private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.emitter.event;
	constructor(private readonly failRename = false) {}
	get fileCount(): number {return this.files.size;}
	seed(uri: vscode.Uri, bytes: Uint8Array): void {this.files.set(uri.path, bytes.slice());}
	read(uri: vscode.Uri): Uint8Array {return this.files.get(uri.path)?.slice() ?? new Uint8Array();}
	watch(): vscode.Disposable {return new vscode.Disposable(() => {});}
	stat(uri: vscode.Uri): vscode.FileStat {
		const value = this.files.get(uri.path);
		if (!value) {throw vscode.FileSystemError.FileNotFound(uri);}
		return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: value.byteLength };
	}
	readDirectory(): [string, vscode.FileType][] {return [];}
	createDirectory(): void {}
	readFile(uri: vscode.Uri): Uint8Array {
		const value = this.files.get(uri.path);
		if (!value) {throw vscode.FileSystemError.FileNotFound(uri);}
		return value.slice();
	}
	writeFile(uri: vscode.Uri, content: Uint8Array): void {this.files.set(uri.path, content.slice());}
	delete(uri: vscode.Uri): void {this.files.delete(uri.path);}
	rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
		if (this.failRename) {throw new Error('simulated rename failure');}
		const content = this.files.get(oldUri.path);
		if (!content) {throw vscode.FileSystemError.FileNotFound(oldUri);}
		this.files.set(newUri.path, content);
		this.files.delete(oldUri.path);
	}
}

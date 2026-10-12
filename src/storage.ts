import * as vscode from 'vscode';
import { isWritableFileSystem } from './filesystem-capability';
import { createUuid } from './runtime';
import { uriBasename, uriDirname, uriJoin } from './uri-path';
import { ExternalFileConflictError } from './user-errors';
import { t } from './i18n';

type LocalFileReplaceAdapter = (uri: vscode.Uri, bytes: Uint8Array, expected?: Uint8Array, isCancelled?: () => boolean) => Promise<void>;
let localFileReplaceAdapter: LocalFileReplaceAdapter | undefined;

export function setLocalFileReplaceAdapter(adapter: LocalFileReplaceAdapter): void {
	localFileReplaceAdapter = adapter;
}

/** Replace a resource through a verified sibling temporary file. */
export async function replaceFile(uri: vscode.Uri, bytes: Uint8Array, expected?: Uint8Array, isCancelled: () => boolean = () => false): Promise<void> {
	if (!isWritableFileSystem(vscode.workspace.fs.isWritableFileSystem(uri.scheme))) {
		throw new Error(t('storage.writePermissionUnconfirmed'));
	}
	if (uri.scheme === 'file' && localFileReplaceAdapter) {return localFileReplaceAdapter(uri, bytes, expected, isCancelled);}
	if (isCancelled()) {throw new vscode.CancellationError();}
	let original = await readIfExists(uri);
	if (expected && (!original || !equalBytes(original, expected))) {
		throw new ExternalFileConflictError(t('storage.fileChangedSinceOpen'));
	}
	const temporary = uri.with({ path: uriJoin(uriDirname(uri.path), `.${uriBasename(uri.path)}.spreadsheet-viewer-${createUuid()}.tmp`) });
	const backup = original
		? uri.with({ path: uriJoin(uriDirname(uri.path), `.${uriBasename(uri.path)}.spreadsheet-viewer-${createUuid()}.bak`) })
		: undefined;
	let backupReady = false;
	let preserveBackup = false;
	try {
		await vscode.workspace.fs.writeFile(temporary, bytes);
		const verification = await vscode.workspace.fs.readFile(temporary);
		if (!equalBytes(verification, bytes)) {throw new Error(t('storage.temporaryFileVerificationFailed'));}
		if (original) {
			const latest = await readIfExists(uri);
			if (!latest || !equalBytes(latest, original)) {
				throw new ExternalFileConflictError(t('storage.fileChangedDuringSave'));
			}
		}
		if (isCancelled()) {throw new vscode.CancellationError();}
		if (backup && original) {
			await vscode.workspace.fs.writeFile(backup, original);
			const backupVerification = await vscode.workspace.fs.readFile(backup);
			if (!equalBytes(backupVerification, original)) {throw new Error(t('storage.temporaryRecoveryCopyVerificationFailed'));}
			backupReady = true;
		}
		await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
		const saved = await vscode.workspace.fs.readFile(uri);
		if (!equalBytes(saved, bytes)) {throw new Error(t('storage.replacedFileMismatch'));}
	} catch (error) {
		if (backup && original && backupReady) {
			try {
				const current = await readIfExists(uri);
				if (!current) {
					await vscode.workspace.fs.writeFile(uri, original);
					const restored = await vscode.workspace.fs.readFile(uri);
					if (!equalBytes(restored, original)) {throw new Error(t('storage.restoreVerificationMismatch'));}
				} else if (!equalBytes(current, original)) {
					preserveBackup = true;
					throw new Error(t('storage.destinationChangedBackupKept', backup.toString()));
				}
			} catch (restoreError) {
				if (preserveBackup) {throw restoreError;}
				preserveBackup = true;
				throw new Error(t('storage.restoreFailedBackupKept', backup.toString()), { cause: error });
			}
		}
		throw error;
	} finally {
		try {
			await vscode.workspace.fs.delete(temporary);
		} catch {
			// The rename consumes the temporary file; cleanup is best effort after a failed write.
		}
		if (backup && !preserveBackup) {
			try {await deleteIfExists(backup);}
			catch {
				// A leftover verified backup is safer than reporting a successful save as failed.
			}
		}
	}
}

export async function writeBackup(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
	const directory = uri.with({ path: uriDirname(uri.path) });
	await vscode.workspace.fs.createDirectory(directory);
	await vscode.workspace.fs.writeFile(uri, bytes);
	const verified = await vscode.workspace.fs.readFile(uri);
	if (!equalBytes(verified, bytes)) {
		throw new Error(t('storage.recoveryCopyVerificationFailed'));
	}
}

export async function readBackup(id: string): Promise<Uint8Array> {
	return vscode.workspace.fs.readFile(vscode.Uri.parse(id));
}

export async function deleteBackup(id: string): Promise<void> {
	try {
		await vscode.workspace.fs.delete(vscode.Uri.parse(id));
	} catch {
		// Backups may already have been removed during workspace cleanup.
	}
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {return false;}
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) {return false;}
	}
	return true;
}

async function readIfExists(uri: vscode.Uri): Promise<Uint8Array | undefined> {
	try {return await vscode.workspace.fs.readFile(uri);}
	catch (error) {
		if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {return undefined;}
		throw error;
	}
}

async function deleteIfExists(uri: vscode.Uri): Promise<void> {
	try {await vscode.workspace.fs.delete(uri);}
	catch (error) {
		if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {throw error;}
	}
}

import * as path from 'node:path';
import { chmod, rename, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { setLocalFileReplaceAdapter } from './storage';
import { createUuid } from './runtime';
import { ExternalFileConflictError } from './user-errors';
import { t } from './i18n';

/** Preserve the open custom editor on desktop by replacing local files with a native rename. */
export function configureNodeStorage(): void {
	setLocalFileReplaceAdapter(async (uri, bytes, expected, isCancelled = () => false) => {
		if (isCancelled()) {throw new vscode.CancellationError();}
		if (expected && !equalBytes(await vscode.workspace.fs.readFile(uri), expected)) {
			throw new ExternalFileConflictError(t('storage.fileChangedSinceOpen'));
		}
		let mode: number | undefined;
		try {mode = (await stat(uri.fsPath)).mode & 0o777;} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;}
		}
		const temporary = uri.with({ path: path.posix.join(path.posix.dirname(uri.path), `.${path.posix.basename(uri.path)}.spreadsheet-viewer-${createUuid()}.tmp`) });
		try {
			await vscode.workspace.fs.writeFile(temporary, bytes);
			if (mode !== undefined) {await chmod(temporary.fsPath, mode);}
			if (!equalBytes(await vscode.workspace.fs.readFile(temporary), bytes)) {throw new Error(t('storage.temporaryFileVerificationFailed'));}
			if (expected && !equalBytes(await vscode.workspace.fs.readFile(uri), expected)) {
				throw new ExternalFileConflictError(t('storage.fileChangedDuringSave'));
			}
			if (isCancelled()) {throw new vscode.CancellationError();}
			await rename(temporary.fsPath, uri.fsPath);
		} finally {
			try {await vscode.workspace.fs.delete(temporary);} catch { /* The rename consumes the temporary file. */}
		}
	});
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {return false;}
	for (let index = 0; index < left.byteLength; index++) {if (left[index] !== right[index]) {return false;}}
	return true;
}

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, rename, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { isWritableFileSystem } from './filesystem-capability';

/** Replace a resource through a verified sibling temporary file. */
export async function replaceFile(uri: vscode.Uri, bytes: Uint8Array, expected?: Uint8Array, isCancelled: () => boolean = () => false): Promise<void> {
	if (!isWritableFileSystem(vscode.workspace.fs.isWritableFileSystem(uri.scheme))) {
		throw new Error('El proveedor de archivos no confirma permisos de escritura; el documento se conserva sin guardar.');
	}
	if (isCancelled()) {throw new vscode.CancellationError();}
	if (expected) {
		const current = await vscode.workspace.fs.readFile(uri);
		if (!equalBytes(current, expected)) {
			throw new Error('El archivo cambió en disco desde que se abrió. Recárgalo antes de guardar.');
		}
	}
	const directory = path.posix.dirname(uri.path);
	const name = path.posix.basename(uri.path);
	const temporary = uri.with({ path: path.posix.join(directory, `.${name}.spreadsheet-viewer-${randomUUID()}.tmp`) });
	// workspace.fs.rename(overwrite) deletes the destination through VS Code's
	// file service first. That delete disposes an open CustomDocument even when
	// its tab stays visible. A local filesystem rename replaces the file without
	// sending that editor-level delete operation.
	let mode: number | undefined;
	if (uri.scheme === 'file') {
		try {mode = (await stat(uri.fsPath)).mode & 0o777;} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;}
		}
	}
	try {
		await vscode.workspace.fs.writeFile(temporary, bytes);
		if (mode !== undefined) {await chmod(temporary.fsPath, mode);}
		const verification = await vscode.workspace.fs.readFile(temporary);
		if (!equalBytes(verification, bytes)) {throw new Error('No se pudo verificar el archivo temporal antes de reemplazar el destino.');}
		if (expected) {
			const latest = await vscode.workspace.fs.readFile(uri);
			if (!equalBytes(latest, expected)) {
				throw new Error('El archivo cambió en disco durante el guardado; se conservó la versión externa.');
			}
		}
		if (isCancelled()) {throw new vscode.CancellationError();}
		if (uri.scheme === 'file') {await rename(temporary.fsPath, uri.fsPath);}
		else {await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });}
	} finally {
		try {
			await vscode.workspace.fs.delete(temporary);
		} catch {
			// The rename consumes the temporary file; cleanup is best effort after a failed write.
		}
	}
}

export async function writeBackup(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
	const directory = uri.with({ path: path.posix.dirname(uri.path) });
	await vscode.workspace.fs.createDirectory(directory);
	await vscode.workspace.fs.writeFile(uri, bytes);
	const verified = await vscode.workspace.fs.readFile(uri);
	if (!equalBytes(verified, bytes)) {
		throw new Error('No se pudo verificar la copia de recuperación.');
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

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

/** Replace a resource through a verified sibling temporary file. */
export async function replaceFile(uri: vscode.Uri, bytes: Uint8Array, expected?: Uint8Array): Promise<void> {
	if (expected) {
		const current = await vscode.workspace.fs.readFile(uri);
		if (!equalBytes(current, expected)) {
			throw new Error('El archivo cambió en disco desde que se abrió. Recárgalo antes de guardar.');
		}
	}
	const directory = path.posix.dirname(uri.path);
	const name = path.posix.basename(uri.path);
	const temporary = uri.with({ path: path.posix.join(directory, `.${name}.spreadsheet-viewer-${randomUUID()}.tmp`) });
	try {
		await vscode.workspace.fs.writeFile(temporary, bytes);
		const verification = await vscode.workspace.fs.readFile(temporary);
		if (!equalBytes(verification, bytes)) {throw new Error('No se pudo verificar el archivo temporal antes de reemplazar el destino.');}
		if (expected) {
			const latest = await vscode.workspace.fs.readFile(uri);
			if (!equalBytes(latest, expected)) {
				throw new Error('El archivo cambió en disco durante el guardado; se conservó la versión externa.');
			}
		}
		await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
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

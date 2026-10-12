const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

async function main() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'spreadsheet-node-conflict-'));
	const filePath = path.join(directory, 'book.csv');
	const original = Buffer.from('a,b\n1,2\n');
	const external = Buffer.from('a,b\nexternal,2\n');
	await fs.writeFile(filePath, external);
	const vscode = {
		workspace: {
			fs: {
				isWritableFileSystem: () => true,
				readFile: async uri => new Uint8Array(await fs.readFile(uri.fsPath)),
				writeFile: async (uri, bytes) => fs.writeFile(uri.fsPath, bytes),
				delete: async uri => fs.rm(uri.fsPath, { force: true }),
			},
		},
	};
	const originalLoad = Module._load;
	Module._load = function(request, parent, isMain) {
		if (request === 'vscode') {return vscode;}
		return originalLoad.call(this, request, parent, isMain);
	};
	try {
		const { configureNodeStorage } = require('../out/storage-node.js');
		const { replaceFile } = require('../out/storage.js');
		configureNodeStorage();
		const uri = { scheme: 'file', path: filePath, fsPath: filePath, with: change => ({ scheme: 'file', path: change.path, fsPath: change.path }) };
		await assert.rejects(replaceFile(uri, Buffer.from('a,b\n1,3\n'), original), error =>
			error instanceof Error && 'code' in error && error.code === 'external-file-conflict');
		assert.deepEqual(await fs.readFile(filePath), external, 'the node adapter preserves the external file');
		console.log('Passed: node storage reports a stable external conflict and preserves external bytes');
	} finally {
		Module._load = originalLoad;
		await fs.rm(directory, { recursive: true, force: true });
	}
}

main().catch(error => {console.error(error); process.exitCode = 1;});

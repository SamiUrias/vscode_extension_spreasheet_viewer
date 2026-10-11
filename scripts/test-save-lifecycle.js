const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { runTests } = require('@vscode/test-electron');

// Use an isolated test extension to exercise the real provider and VS Code's
// CustomDocument registry, including its response to filesystem operations.
async function main() {
	const root = path.resolve(__dirname, '..');
	// macOS limits the length of the workbench's IPC socket path.
	const directory = await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'sv-save-'));
	try {
		await writeFile(path.join(directory, 'package.json'), JSON.stringify({
			name: 'spreadsheet-save-lifecycle', publisher: 'test', version: '0.0.1',
			engines: { vscode: '^1.137.0' }, main: './extension.js',
			contributes: { customEditors: [{ viewType: 'spreadsheet-viewer.editor', displayName: 'Save lifecycle test',
				selector: [{ filenamePattern: '*.csv' }], priority: 'option' }] },
		}));
		await esbuild.build({
			stdin: {
				resolveDir: root,
				contents: `
const vscode = require('vscode');
const { SpreadsheetEditorProvider } = require('./src/editor');
exports.activate = context => {
	// Reproduce the old replacement route when explicitly requested.
	if (process.env.SAVE_LIFECYCLE_OLD_RENAME === '1') {
		require('node:fs/promises').rename = (source, target) =>
			vscode.workspace.fs.rename(vscode.Uri.file(source), vscode.Uri.file(target), { overwrite: true });
	}
	const provider = new SpreadsheetEditorProvider(vscode.Uri.file(${JSON.stringify(root)}), context.workspaceState);
	let document;
	const open = provider.openCustomDocument.bind(provider);
	provider.openCustomDocument = async (...args) => { document = await open(...args); return document; };
	context.subscriptions.push(provider, vscode.window.registerCustomEditorProvider(
		SpreadsheetEditorProvider.viewType, provider, { supportsMultipleEditorsPerDocument: false }));
	return {
		get document() { return document; },
		commit(row, column, value) {
			provider.applyEdit(document, { type: 'editCell', documentId: document.documentId,
				revision: document.revision, sheetId: document.sheetId(0), sheetIndex: 0, row, column, value });
		},
	};
};`,
			},
			bundle: true, platform: 'node', format: 'cjs', external: ['vscode'],
			outfile: path.join(directory, 'extension.js'),
		});
		await writeFile(path.join(directory, 'tests.js'), `
const assert = require('node:assert/strict');
const { readFile, writeFile, stat } = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async () => {
	const uri = vscode.Uri.file(path.join(__dirname, 'data.csv'));
	await writeFile(uri.fsPath, 'name,value\\nfirst,1\\nsecond,2\\n', { mode: 0o640 });
	const api = await vscode.extensions.getExtension('test.spreadsheet-save-lifecycle').activate();
	await vscode.commands.executeCommand('vscode.openWith', uri, 'spreadsheet-viewer.editor');
	const tab = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).find(item =>
		item.input instanceof vscode.TabInputCustom && item.input.uri.toString() === uri.toString());
	const waitFor = async (label, predicate) => {
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			assert.equal(api.document.isDisposed, false, 'CustomDocument was disposed during ' + label);
			if (await predicate()) { return; }
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		throw new Error('Timed out: ' + label);
	};
	const saved = expected => async () => (await readFile(uri.fsPath, 'utf8')) === expected && tab()?.isDirty === false;
	const first = 'name,value\\nfirst,10\\nsecond,2\\n';
	const second = 'name,value\\nfirst,10\\nsecond,20\\n';
	const third = 'name,value\\nfirst,30\\nsecond,40\\n';
	api.commit(1, 1, '10');
	await waitFor('first autosave', saved(first));
	api.commit(2, 1, '20');
	await waitFor('second autosave', saved(second));
	api.commit(1, 1, '30');
	api.commit(2, 1, '40');
	await waitFor('rapid consecutive edits', saved(third));
	await vscode.commands.executeCommand('undo');
	await waitFor('undo autosave', saved('name,value\\nfirst,30\\nsecond,20\\n'));
	await vscode.commands.executeCommand('redo');
	await waitFor('redo autosave', saved(third));
	if (process.platform !== 'win32') {
		assert.equal((await stat(uri.fsPath)).mode & 0o777, 0o640, 'Save changed the file permissions');
	}
	await vscode.window.tabGroups.close(tab());
	console.log('PASS: repeated autosaves, rapid edits, undo/redo, live CustomDocument, clean tab, file permissions');
};
`);
		// An integrated terminal can inherit this from VS Code's Node processes.
		// The test executable must start the workbench, rather than run as Node.
		delete process.env.ELECTRON_RUN_AS_NODE;
		await runTests({
			vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
			extensionDevelopmentPath: directory,
			extensionTestsPath: path.join(directory, 'tests.js'),
			extensionTestsEnv: { SAVE_LIFECYCLE_OLD_RENAME: process.env.SAVE_LIFECYCLE_OLD_RENAME ?? '' },
			launchArgs: ['--user-data-dir=' + path.join(directory, 'user-data'),
				'--extensions-dir=' + path.join(directory, 'extensions'), '--disable-extensions'],
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });

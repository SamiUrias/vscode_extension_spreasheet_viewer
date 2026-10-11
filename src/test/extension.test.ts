import * as assert from 'assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { zipSync } from 'fflate';
import { isSupportedSpreadsheetUri } from '../extension';

suite('Spreadsheet Viewer editor', () => {
	test('only accepts supported spreadsheet extensions for the command', () => {
		assert.strictEqual(isSupportedSpreadsheetUri(vscode.Uri.file('/tmp/REPORT.CSV')), true);
		assert.strictEqual(isSupportedSpreadsheetUri(vscode.Uri.file('/tmp/report.tsv')), true);
		assert.strictEqual(isSupportedSpreadsheetUri(vscode.Uri.file('/tmp/report.xlsx')), true);
		assert.strictEqual(isSupportedSpreadsheetUri(vscode.Uri.file('/tmp/report.txt')), false);
	});

	test('contributes the Explorer command and optional custom editor', () => {
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'spreadsheet-viewer');
		assert.ok(extension, 'The extension should be loaded in the Extension Host');

		const contributions = extension.packageJSON.contributes as {
			commands: Array<{ command: string; title: string; category?: string; icon?: string }>;
			customEditors: Array<{ viewType: string; priority: string; selector: Array<{ filenamePattern: string }> }>;
			menus: { 'explorer/context': Array<{ command: string; when: string }>; 'commandPalette': Array<{ command: string; when: string }>; 'tabContext': Array<{ command: string; when: string }> };
			keybindings: Array<{ command: string; key: string; mac?: string; when: string }>;
		};
		assert.ok(contributions.commands.some(command =>
			command.command === 'spreadsheet-viewer.open' && command.title === 'Abrir en Spreadsheet Viewer'
				&& command.category === 'Spreadsheet Viewer' && command.icon === 'resources/spreadsheet.svg'));
		assert.ok(contributions.commands.some(command => command.command === 'spreadsheet-viewer.preview'));
		assert.ok(contributions.commands.some(command => command.command === 'spreadsheet-viewer.previewBuffer'));
		assert.ok(contributions.commands.some(command => command.command === 'spreadsheet-viewer.previewCsv'));
		assert.ok(contributions.menus['explorer/context'].some(item =>
			item.command === 'spreadsheet-viewer.open' && item.when.includes('resourceExtname')));
		assert.ok(contributions.menus.commandPalette.some(item => item.command === 'spreadsheet-viewer.open' && item.when === 'true'));
		assert.ok(contributions.menus.tabContext.some(item => item.command === 'spreadsheet-viewer.open'));
		assert.ok(contributions.keybindings.some(item => item.command === 'spreadsheet-viewer.open'
			&& item.key === 'ctrl+alt+shift+o' && item.mac === 'cmd+alt+shift+o' && item.when.includes('resourceExtname')));
		assert.deepStrictEqual(
			contributions.customEditors.find(editor => editor.viewType === 'spreadsheet-viewer.editor')?.selector.map(item => item.filenamePattern),
			['**/*.[cC][sS][vV]', '**/*.[tT][sS][vV]', '**/*.[tT][aA][bB]', '**/*.[xX][lL][sS][xX]', '**/*.[oO][dD][sS]'],
		);
		assert.strictEqual(contributions.customEditors.find(editor => editor.viewType === 'spreadsheet-viewer.editor')?.priority, 'option');
	});

	test('opens, reuses, closes, and reopens one custom editor tab for a CSV URI', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'spreadsheet-viewer-stage2-'));
		const uri = vscode.Uri.file(path.join(directory, 'sample.csv'));
		const viewType = 'spreadsheet-viewer.editor';
		await writeFile(uri.fsPath, 'sample,data\n');
		const originalBytes = await readFile(uri.fsPath);

		try {
			await Promise.all([
				vscode.commands.executeCommand('spreadsheet-viewer.open', uri),
				vscode.commands.executeCommand('spreadsheet-viewer.open', uri),
			]);
			assert.strictEqual(findCustomTabs(uri, viewType).length, 1);
			assert.deepStrictEqual(await readFile(uri.fsPath), originalBytes);

			const [tab] = findCustomTabs(uri, viewType);
			await vscode.window.tabGroups.close(tab);
			assert.strictEqual(findCustomTabs(uri, viewType).length, 0);

			await vscode.commands.executeCommand('spreadsheet-viewer.open', uri);
			assert.strictEqual(findCustomTabs(uri, viewType).length, 1);
		} finally {
			for (const tab of findCustomTabs(uri, viewType)) {
				await vscode.window.tabGroups.close(tab);
			}
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('opens an ODS file in the Spreadsheet Viewer editor', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'spreadsheet-viewer-ods-'));
		const uri = vscode.Uri.file(path.join(directory, 'sample.ods'));
		const content = new TextEncoder().encode('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:spreadsheet><table:table table:name="Datos"><table:table-row><table:table-cell office:value-type="float" office:value="0.25"/></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>');
		await writeFile(uri.fsPath, zipSync({
			mimetype: [new TextEncoder().encode('application/vnd.oasis.opendocument.spreadsheet'), { level: 0 }],
			'content.xml': content,
		}));
		try {
			await vscode.commands.executeCommand('spreadsheet-viewer.open', uri);
			assert.strictEqual(findCustomTabs(uri, 'spreadsheet-viewer.editor').length, 1);
		} finally {
			for (const tab of findCustomTabs(uri, 'spreadsheet-viewer.editor')) {await vscode.window.tabGroups.close(tab);}
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('opens a disk preview in its own read-only panel without changing the file', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'spreadsheet-viewer-preview-'));
		const uri = vscode.Uri.file(path.join(directory, 'preview.csv'));
		const bytes = Buffer.from('name|value\nfirst|1\n');
		await writeFile(uri.fsPath, bytes);
		try {
			await vscode.commands.executeCommand('spreadsheet-viewer.preview', uri);
			assert.strictEqual(findWebviewTabs('spreadsheet-viewer.preview').length, 1);
			assert.deepStrictEqual(await readFile(uri.fsPath), bytes);
		} finally {
			for (const tab of findWebviewTabs('spreadsheet-viewer.preview')) {await vscode.window.tabGroups.close(tab);}
			await rm(directory, { recursive: true, force: true });
		}
	});

	test('previews live CSV buffer changes without saving them to disk', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'spreadsheet-viewer-buffer-preview-'));
		const uri = vscode.Uri.file(path.join(directory, 'buffer.csv'));
		const original = Buffer.from('name,value\noriginal,1\n');
		await writeFile(uri.fsPath, original);
		const textDocument = await vscode.workspace.openTextDocument(uri);
		try {
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(textDocument.positionAt(0), textDocument.positionAt(textDocument.getText().length)), 'name,value\nchanged,2\n');
			assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
			await vscode.commands.executeCommand('spreadsheet-viewer.previewBuffer', uri);
			assert.strictEqual(findWebviewTabs('spreadsheet-viewer.preview').length, 1);
			assert.strictEqual(textDocument.isDirty, true);
			assert.deepStrictEqual(await readFile(uri.fsPath), original);
		} finally {
			for (const tab of findWebviewTabs('spreadsheet-viewer.preview')) {await vscode.window.tabGroups.close(tab);}
			await vscode.commands.executeCommand('workbench.action.files.revert', uri);
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function findCustomTabs(uri: vscode.Uri, viewType: string): vscode.Tab[] {
	return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
		const input = tab.input;
		return input instanceof vscode.TabInputCustom
			&& input.viewType === viewType
			&& input.uri.toString() === uri.toString();
	});
}

function findWebviewTabs(viewType: string): vscode.Tab[] {
	return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
		tab.input instanceof vscode.TabInputWebview && tab.input.viewType === viewType);
}

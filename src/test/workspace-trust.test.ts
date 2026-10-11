import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';

suite('Spreadsheet Viewer in Restricted Mode', () => {
	test('activates and opens a CSV without workspace trust', async () => {
		assert.strictEqual(vscode.workspace.isTrusted, false, 'the test must run in Restricted Mode');
		const extension = vscode.extensions.all.find(item => item.packageJSON.name === 'spreadsheet-viewer');
		assert.ok(extension, 'Spreadsheet Viewer must load in Restricted Mode');
		assert.strictEqual((extension.packageJSON.capabilities as { untrustedWorkspaces?: { supported?: boolean } }).untrustedWorkspaces?.supported, true);
		await extension.activate();
		const workspace = vscode.workspace.workspaceFolders?.[0];
		assert.ok(workspace, 'the Restricted Mode test must open its isolated workspace');
		const uri = vscode.Uri.joinPath(workspace.uri, 'sample.csv');
		const originalBytes = await readFile(uri.fsPath);
		try {
			await vscode.commands.executeCommand('spreadsheet-viewer.open', uri);
			const customTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
				tab.input instanceof vscode.TabInputCustom
					&& tab.input.viewType === 'spreadsheet-viewer.editor'
					&& tab.input.uri.toString() === uri.toString());
			assert.ok(customTab, 'the CSV should open in the spreadsheet viewer');
			assert.deepStrictEqual(await readFile(uri.fsPath), originalBytes, 'opening in Restricted Mode must not change file bytes');
		} finally {
			for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) {
				if (tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === uri.toString()) {
					await vscode.window.tabGroups.close(tab);
				}
			}
		}
	});
});

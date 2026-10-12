import * as vscode from 'vscode';
import { SpreadsheetEditorProvider, resolveDirtyTextBuffer } from './editor';
import { SpreadsheetPreviewProvider } from './preview';
import { isStdinTempPath, isSupportedCsvLanguageId } from './csv-dialect';
import { getStdinTemporaryDirectory } from './stdin-config';
import { configureLocale, t } from './i18n';

export function activateCore(context: vscode.ExtensionContext): void {
	configureLocale(vscode.env.language);
	const provider = new SpreadsheetEditorProvider(context.extensionUri, context.workspaceState);
	const previews = new SpreadsheetPreviewProvider(context.extensionUri, (uri, webview, label) => provider.getHtml(uri, webview, label), context.workspaceState);
	const stdinAttempts = new Set<string>();
	const maybePreviewStdin = (document: vscode.TextDocument): void => {
		if (!vscode.workspace.getConfiguration('spreadsheet-viewer.stdin').get<boolean>('openStdin', false)) {return;}
		const stdinDirectory = getStdinTemporaryDirectory();
		if (document.uri.scheme !== 'file' || !stdinDirectory || !isStdinTempPath(document.uri.path, stdinDirectory)) {return;}
		if (document.languageId !== 'plaintext' && !isSupportedCsvLanguageId(document.languageId)) {return;}
		const key = document.uri.toString();
		if (stdinAttempts.has(key)) {return;}
		stdinAttempts.add(key);
		void previews.openBuffer(document.uri).then(() => stdinAttempts.delete(key), error => {
			stdinAttempts.delete(key);
			void vscode.window.showErrorMessage(t('host.stdinPreviewFailed', error instanceof Error ? error.message : String(error)));
		});
	};
	const stdinOpenListener = vscode.workspace.onDidOpenTextDocument(maybePreviewStdin);
	const stdinConfigListener = vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('spreadsheet-viewer.stdin.openStdin')) {
			for (const document of vscode.workspace.textDocuments) {maybePreviewStdin(document);}
		}
	});
	for (const document of vscode.workspace.textDocuments) {maybePreviewStdin(document);}
	context.subscriptions.push(
		stdinOpenListener,
		stdinConfigListener,
		vscode.window.registerCustomEditorProvider(
			SpreadsheetEditorProvider.viewType,
			provider,
			{
				webviewOptions: {
					retainContextWhenHidden: false,
				},
				supportsMultipleEditorsPerDocument: false,
			},
		),
		vscode.commands.registerCommand('spreadsheet-viewer.open', async (resource: unknown) => {
			const explicitResource = resource !== undefined;
			const uri = explicitResource ? resource : getActiveResource();
			if (!isUri(uri) || !isSupportedSpreadsheetUri(uri)) {
				void vscode.window.showErrorMessage(explicitResource
					? t('host.invalidSelectedSpreadsheet')
					: t('host.openSpreadsheetFirst'));
				return;
			}
			try {
				if (!await resolveDirtyTextBuffer(uri)) {return;}
				await provider.open(uri);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(t('host.openSpreadsheetFailed', message));
			}
		}),
		vscode.commands.registerCommand('spreadsheet-viewer.preview', async (resource: unknown) => {
			const uri = resource === undefined ? getActiveResource() : resource;
			if (!isUri(uri) || !isSupportedSpreadsheetUri(uri)) {
				void vscode.window.showErrorMessage(t('host.selectSpreadsheetPreview'));
				return;
			}
			try { await previews.openDisk(uri); }
		catch (error) { void vscode.window.showErrorMessage(t('host.previewFailed', error instanceof Error ? error.message : String(error))); }
		}),
		vscode.commands.registerCommand('spreadsheet-viewer.previewBuffer', async (resource: unknown) => {
			const uri = resource === undefined ? getActiveResource() : resource;
			if (!isUri(uri) || !/\.(csv|tsv|tab)$/i.test(uri.path)) {
				void vscode.window.showErrorMessage(t('host.bufferPreviewFormats'));
				return;
			}
			try { await previews.openBuffer(uri); }
		catch (error) { void vscode.window.showErrorMessage(t('host.bufferPreviewFailed', error instanceof Error ? error.message : String(error))); }
		}),
		vscode.commands.registerCommand('spreadsheet-viewer.previewCsv', async (resource: unknown) => {
			const uri = resource === undefined ? getActiveResource() : resource;
			if (!isUri(uri)) {
				void vscode.window.showErrorMessage(t('host.selectCsvPreview'));
				return;
			}
			try { await previews.openBuffer(uri, true); }
		catch (error) { void vscode.window.showErrorMessage(t('host.csvPreviewFailed', error instanceof Error ? error.message : String(error))); }
		}),
		vscode.commands.registerCommand('spreadsheet-viewer.resetView', (resource: unknown) => {
			const uri = resource === undefined ? getActiveResource() : resource;
			if (!isUri(uri)) {void vscode.window.showErrorMessage(t('host.selectSpreadsheetReset')); return;}
			provider.resetView(uri);
			previews.resetView(uri);
		}),
		previews,
		provider,
	);
}

export function deactivate(): void {}

function isUri(value: unknown): value is vscode.Uri {
	return typeof value === 'object'
		&& value !== null
		&& 'scheme' in value
		&& typeof value.scheme === 'string'
		&& 'path' in value
		&& typeof value.path === 'string'
		&& 'toString' in value
		&& typeof value.toString === 'function';
}

function getActiveResource(): vscode.Uri | undefined {
	const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
	const tabInput = activeTab?.input;
	if (tabInput instanceof vscode.TabInputText || tabInput instanceof vscode.TabInputCustom) {
		return tabInput.uri;
	}
	return vscode.window.activeTextEditor?.document.uri;
}

export function isSupportedSpreadsheetUri(uri: vscode.Uri): boolean {
	return /\.(csv|tsv|tab|xlsx|xlsm|ods)$/i.test(uri.path);
}

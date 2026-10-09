import * as vscode from 'vscode';
import { SpreadsheetEditorProvider } from './editor';

export function activate(context: vscode.ExtensionContext): void {
	const provider = new SpreadsheetEditorProvider(context.extensionUri);
	context.subscriptions.push(
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
			if (!isUri(resource)) {
				void vscode.window.showErrorMessage('Selecciona un archivo .csv, .xlsx u .ods en el Explorer.');
				return;
			}

			try {
				await provider.open(resource);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`No se pudo abrir la hoja: ${message}`);
			}
		}),
	);
}

export function deactivate(): void {}

function isUri(value: unknown): value is vscode.Uri {
	return typeof value === 'object'
		&& value !== null
		&& 'scheme' in value
		&& 'path' in value;
}

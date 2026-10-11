import * as vscode from 'vscode';
import type { FormulaParserService } from './formula-reference';

interface FormulaParserModule { createFormulaParserService(): Promise<FormulaParserService>; }

let parserPromise: Promise<FormulaParserService> | undefined;

/** Loads the separately bundled ESM/WASM parser only for operations that need formula references. */
export function loadFormulaParserService(extensionUri: vscode.Uri): Promise<FormulaParserService> {
	const bundleName = vscode.env.appHost === 'web' ? 'formula-parser-web.mjs' : 'formula-parser-node.mjs';
	parserPromise ??= import(vscode.Uri.joinPath(extensionUri, 'dist', bundleName).toString())
		.then((loaded: FormulaParserModule) => loaded.createFormulaParserService())
		.catch(error => {parserPromise = undefined; throw error;});
	return parserPromise;
}

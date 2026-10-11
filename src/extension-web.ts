import type * as vscode from 'vscode';
import { activateCore, deactivate } from './extension';

export { deactivate };
export function activate(context: vscode.ExtensionContext): void {activateCore(context);}

import * as os from 'node:os';
import { webcrypto } from 'node:crypto';
import type * as vscode from 'vscode';
import { activateCore, deactivate } from './extension';
import { configureNodeStorage } from './storage-node';
import { setStdinTemporaryDirectory } from './stdin-config';
import { setRuntimeCrypto, type RuntimeCrypto } from './runtime';

export { deactivate };

export function activate(context: vscode.ExtensionContext): void {
	configureNodeStorage();
	setRuntimeCrypto(webcrypto as unknown as RuntimeCrypto);
	setStdinTemporaryDirectory(os.tmpdir());
	activateCore(context);
}

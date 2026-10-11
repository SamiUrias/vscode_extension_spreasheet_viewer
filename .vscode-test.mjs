import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep the IPC socket path short on macOS when the repository lives in a deep
// directory. Remove the generated profile when the test CLI exits.
const userDataDir = process.env.VSCODE_TEST_USER_DATA_DIR
	?? mkdtempSync(path.join(os.tmpdir(), 'sv-vscode-test-'));
if (!process.env.VSCODE_TEST_USER_DATA_DIR) {
	process.once('exit', () => rmSync(userDataDir, { recursive: true, force: true }));
}

export default defineConfig([
	{
		label: 'trustedWorkspaceTests',
		files: 'out/test/**/*.test.js',
		mocha: { timeout: 10000 },
		launchArgs: [`--user-data-dir=${userDataDir}`],
	},
]);

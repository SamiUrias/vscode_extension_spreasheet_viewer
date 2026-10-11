import { defineConfig } from '@vscode/test-cli';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig([
	{
		label: 'trustedWorkspaceTests',
		files: 'out/test/**/*.test.js',
	},
	{
		label: 'untrustedWorkspaceTests',
		files: 'out/test/**/*.test.js',
		workspaceFolder: path.join(root, 'src/test/fixtures/untrusted-workspace'),
		launchArgs: [`--user-data-dir=${path.join(root, '.vscode-test/untrusted-user-data')}`],
		env: { SPREADSHEET_VIEWER_EXPECT_UNTRUSTED: 'true' },
	},
]);

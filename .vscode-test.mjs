import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
	{
		label: 'trustedWorkspaceTests',
		files: 'out/test/**/*.test.js',
	},
]);

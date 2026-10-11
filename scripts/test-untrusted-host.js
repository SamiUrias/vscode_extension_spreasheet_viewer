const { spawn } = require('node:child_process');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

async function main() {
	const root = path.resolve(__dirname, '..');
	const temp = await mkdtemp(path.join(os.tmpdir(), 'sv-unt-'));
	const workspace = path.join(temp, 'workspace');
	const userData = path.join(temp, 'data');
	const extensions = path.join(temp, 'extensions');
	try {
		await mkdir(workspace);
		await writeFile(path.join(workspace, 'sample.csv'), 'name,value\nfirst,1\n');
		const version = process.env.VSCODE_TEST_VERSION || '1.141.0';
		const executable = process.env.VSCODE_EXECUTABLE_PATH
			|| await downloadAndUnzipVSCode({ version, extensionDevelopmentPath: root });
		const testFile = path.join(root, 'out/test/workspace-trust.test.js');
		const runner = path.join(path.dirname(require.resolve('@vscode/test-cli')), 'runner.cjs');
		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE;
		env.SPREADSHEET_VIEWER_UNTRUSTED_CSV = path.join(workspace, 'sample.csv');
		env.VSCODE_TEST_OPTIONS = JSON.stringify({
			mochaOpts: { timeout: 10000 },
			colorDefault: false,
			preload: [],
			files: [testFile],
		});
		const args = [
			'--no-sandbox',
			'--disable-gpu-sandbox',
			'--disable-updates',
			'--skip-welcome',
			'--skip-release-notes',
			'--no-cached-data',
			`--user-data-dir=${userData}`,
			`--extensions-dir=${extensions}`,
			`--extensionDevelopmentPath=${root}`,
			`--extensionTestsPath=${runner}`,
			workspace,
		];
		const code = await new Promise((resolve, reject) => {
			const child = spawn(executable, args, { env, stdio: 'inherit' });
			child.once('error', reject);
			child.once('close', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
		});
		if (code !== 0) {throw new Error(`Restricted Mode Extension Host exited with code ${code}`);}
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

main().catch(error => {console.error(error); process.exitCode = 1;});

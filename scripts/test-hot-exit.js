const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const timeoutMs = 45_000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
	const root = path.resolve(__dirname, '..');
	const executable = process.env.VSCODE_EXECUTABLE_PATH || await downloadAndUnzipVSCode({
		version: process.env.VSCODE_TEST_VERSION || '1.141.0', extensionDevelopmentPath: root,
	});
	for (const scenario of ['restore-draft', 'escape-draft']) {await runScenario(root, executable, scenario);}
	console.log('PASS: VS Code hot exit restores committed changes and active draft; Escape cancels draft across restart');
}

async function runScenario(root, executable, scenario) {
	const directory = await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'sv-hot-'));
	const extension = path.join(directory, 'extension');
	const workspace = path.join(directory, 'workspace');
	const userData = path.join(directory, 'user-data');
	const extensions = path.join(directory, 'extensions');
	const fixture = path.join(workspace, 'recovery.csv');
	const logPath = path.join(directory, 'events.jsonl');
	const baseline = 'name,value\nfirst,1\n';
	const working = 'name,value\nfirst,9\n';
	const draftValue = scenario === 'restore-draft' ? 'recover this draft' : 'cancel this draft';
	let succeeded = false;
	try {
		await Promise.all([mkdir(extension, { recursive: true }), mkdir(workspace, { recursive: true }),
			mkdir(path.join(userData, 'User'), { recursive: true }), mkdir(extensions, { recursive: true })]);
		await writeFile(fixture, baseline);
		await writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
			'files.hotExit': 'onExitAndWindowClose', 'files.autoSave': 'off', 'window.restoreWindows': 'all',
			'security.workspace.trust.enabled': false, 'spreadsheet-viewer.edit.saveOnCommit': false,
		}));
		await writeFile(path.join(extension, 'package.json'), JSON.stringify({
			name: 'spreadsheet-hot-exit', publisher: 'test', version: '0.0.1',
			engines: { vscode: '^1.137.0' }, main: './extension.js', activationEvents: ['onStartupFinished'],
			contributes: {
				customEditors: [{ viewType: 'spreadsheet-viewer.editor', displayName: 'Hot exit test',
					selector: [{ filenamePattern: '*.csv' }], priority: 'option' }],
				configuration: { title: 'Hot exit test', properties: {
					'spreadsheet-viewer.edit.saveOnCommit': { type: 'boolean', default: true },
				} },
			},
		}));
		await esbuild.build({
			stdin: {
				resolveDir: root,
				contents: `
const vscode = require('vscode');
const fs = require('node:fs/promises');
const { SpreadsheetEditorProvider } = require('./src/editor');
const phase = process.env.SV_HOT_EXIT_PHASE;
const scenario = process.env.SV_HOT_EXIT_SCENARIO;
const file = vscode.Uri.file(process.env.SV_HOT_EXIT_FILE);
const logPath = process.env.SV_HOT_EXIT_LOG;
async function log(event) { await fs.appendFile(logPath, JSON.stringify({ time: Date.now(), ...event }) + '\\n'); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) { if (await predicate()) { return; } await sleep(50); }
	throw new Error('Timed out waiting for ' + label);
}
exports.activate = context => {
	const provider = new SpreadsheetEditorProvider(vscode.Uri.file(${JSON.stringify(root)}), context.workspaceState);
	const open = provider.openCustomDocument.bind(provider);
	provider.openCustomDocument = async (uri, openContext, token) => {
		const document = await open(uri, openContext, token);
		if (phase === 'restore') {
			const takeDraft = document.takeRecoveredDraft.bind(document);
			document.takeRecoveredDraft = () => {
				const draft = takeDraft();
				void log({ event: 'restoredDraft', draft: draft ?? null });
				return draft;
			};
			void log({ event: 'openedRecoveredDocument', uri: uri.toString(), backupId: openContext.backupId ?? null,
				workingBytes: Buffer.from(document.serializeCopy()).toString('utf8') });
			setTimeout(() => { void vscode.commands.executeCommand('workbench.action.quit'); }, 7000);
		}
		return document;
	};
	const backup = provider.backupCustomDocument.bind(provider);
	provider.backupCustomDocument = async (...args) => {
		const result = await backup(...args);
		await log({ event: 'backupCreated', id: result.id,
			drafts: [...provider.panelDrafts.values()].map(draft => ({ row: draft.row, column: draft.column, value: draft.value, dirty: draft.dirty })) });
		return result;
	};
	const resolve = provider.resolveCustomEditor.bind(provider);
	provider.resolveCustomEditor = (document, panel) => {
		resolve(document, panel);
		let sawDraft = false;
		let sawDraftClear = false;
		panel.webview.onDidReceiveMessage(message => {
			if (message?.type === 'draftState') {
				if (message.dirty) {sawDraft = true;}
				else if (sawDraft) {sawDraftClear = true;}
				void log({ event: 'draftState', dirty: message.dirty, value: message.value ?? null });
			}
		});
		panel.hotExitTestDraftState = () => ({ sawDraft, sawDraftClear });
	};
	const getHtml = provider.getHtml.bind(provider);
	provider.getHtml = (...args) => {
		let html = getHtml(...args);
		if (phase !== 'prepare') { return html; }
		const nonce = html.match(/nonce="([^"]+)"/)?.[1];
		if (!nonce) { throw new Error('Could not find the webview CSP nonce'); }
		const driver = 'window.addEventListener("message", event => {' +
			'if (event.data?.type === "svHotExitTestEscape") {' +
			'document.querySelector("#cell-editor")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));' +
			'} });';
		return html.replace('</body>', '<script nonce="' + nonce + '">' + driver + '</script></body>');
	};
	context.subscriptions.push(provider, vscode.window.registerCustomEditorProvider(
		SpreadsheetEditorProvider.viewType, provider, { supportsMultipleEditorsPerDocument: false }));
	if (phase === 'restore') { setTimeout(() => { void vscode.commands.executeCommand('workbench.action.quit'); }, 20000); }
	if (phase === 'prepare') {
		void (async () => {
			await vscode.commands.executeCommand('vscode.openWith', file, SpreadsheetEditorProvider.viewType);
			await waitFor(() => provider.documents.get(file.toString()) && provider.panels.get(file.toString())?.size, 'custom editor activation');
			const document = provider.documents.get(file.toString());
			const panel = [...provider.panels.get(file.toString())][0];
			await waitFor(() => panel.webview.html.includes('grid-root'), 'webview HTML');
			await waitFor(() => provider.activeSheets.has(panel), 'webview ready message');
			provider.applyEdit(document, { type: 'editCell', documentId: document.documentId, revision: document.revision,
				sheetId: document.sheetId(0), sheetIndex: 0, row: 1, column: 1, value: '9' });
			await panel.webview.postMessage({ type: 'restoreCellDraft', draft: {
				sheetIndex: 0, row: 1, column: 1, value: ${JSON.stringify(draftValue)},
			} });
			await waitFor(() => panel.hotExitTestDraftState().sawDraft
				&& provider.panelDrafts.get(panel)?.value === ${JSON.stringify(draftValue)}, 'webview editor draft');
			if (scenario === 'escape-draft') {
				await panel.webview.postMessage({ type: 'svHotExitTestEscape' });
				await waitFor(() => panel.hotExitTestDraftState().sawDraftClear && !provider.panelDrafts.has(panel), 'Escape to clear webview draft');
			}
			await log({ event: 'prepared', scenario, workingBytes: Buffer.from(document.serializeCopy()).toString('utf8'),
				draft: provider.panelDrafts.get(panel)?.value ?? null });
			await vscode.commands.executeCommand('workbench.action.quit');
		})().catch(async error => { await log({ event: 'error', phase, message: String(error?.stack ?? error) });
			void vscode.commands.executeCommand('workbench.action.quit'); });
	}
};`,
			}, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(extension, 'extension.js'),
		});

		await runVscode(executable, { extension, workspace, userData, extensions, fixture, logPath, phase: 'prepare', scenario });
		const preparedEvents = await readEvents(logPath);
		assert.ok(preparedEvents.some(event => event.event === 'prepared'), `${scenario}: phase one did not reach its ready checkpoint`);
		assert.ok(preparedEvents.some(event => event.event === 'backupCreated'), `${scenario}: VS Code did not request a hot-exit backup`);
		assert.equal(await readFile(fixture, 'utf8'), baseline, `${scenario}: hot exit must not save the source file`);

		await runVscode(executable, { extension, workspace, userData, extensions, fixture, logPath, phase: 'restore', scenario });
		const events = await readEvents(logPath);
		const restored = events.find(event => event.event === 'openedRecoveredDocument');
		assert.ok(restored?.backupId, `${scenario}: VS Code did not reopen the custom document from its backup`);
		assert.equal(restored.workingBytes, working, `${scenario}: confirmed edit was not restored`);
		const draft = events.find(event => event.event === 'restoredDraft');
		if (scenario === 'restore-draft') {
			assert.deepEqual(draft?.draft, { sheetIndex: 0, row: 1, column: 1, value: draftValue }, 'active editor text must survive hot exit');
		} else {
			assert.equal(draft?.draft ?? null, null, 'Escape-cancelled text must not return after restart');
		}
		assert.equal(await readFile(fixture, 'utf8'), baseline, `${scenario}: recovered state must not overwrite the source file`);
		succeeded = true;
		console.log(`Passed: ${scenario} hot-exit/restart`);
	} catch (error) {
		const events = await readEvents(logPath).catch(() => []);
		console.error(`Hot-exit scenario ${scenario} failed; logs at ${directory}:`, error);
		for (const event of events) {console.error(JSON.stringify(event));}
		throw error;
	} finally {
		if (succeeded && process.env.KEEP_HOT_EXIT_TEST_FILES !== '1') {await rm(directory, { recursive: true, force: true });}
	}
}

async function runVscode(executable, { extension, workspace, userData, extensions, fixture, logPath, phase, scenario }) {
	const args = [
		'--no-sandbox', '--disable-gpu-sandbox', '--disable-updates', '--skip-welcome', '--skip-release-notes',
		'--no-cached-data', '--disable-workspace-trust', '--new-window', `--user-data-dir=${userData}`,
		`--extensions-dir=${extensions}`, `--extensionDevelopmentPath=${extension}`, workspace,
	];
	const env = { ...process.env, SV_HOT_EXIT_PHASE: phase, SV_HOT_EXIT_SCENARIO: scenario,
		SV_HOT_EXIT_FILE: fixture, SV_HOT_EXIT_LOG: logPath };
	delete env.ELECTRON_RUN_AS_NODE;
	const child = spawn(executable, args, { env, stdio: 'ignore', detached: process.platform !== 'win32' });
	const closed = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code, signal) => resolve({ code, signal }));
	});
	let timeoutHandle;
	const timeout = new Promise(resolve => {timeoutHandle = setTimeout(() => resolve({ timeout: true }), timeoutMs);});
	const result = await Promise.race([closed, timeout]);
	clearTimeout(timeoutHandle);
	if (result.timeout) {
		try {process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM');} catch {}
		let killWait;
		await Promise.race([closed, new Promise(resolve => {killWait = setTimeout(resolve, 5000);})]);
		clearTimeout(killWait);
		throw new Error(`VS Code ${phase} process exceeded ${timeoutMs}ms`);
	}
	if (result.code !== 0) {throw new Error(`VS Code ${phase} exited with code ${result.code}, signal ${result.signal ?? 'none'}`);}
}

async function readEvents(file) {
	const text = await readFile(file, 'utf8').catch(error => error?.code === 'ENOENT' ? '' : Promise.reject(error));
	return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

main().catch(error => {console.error(error); process.exitCode = 1;});

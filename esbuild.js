const esbuild = require("esbuild");
const webpack = require("webpack");
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function build(options) {
	const ctx = await esbuild.context({
		...options,
		bundle: true,
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});
	if (watch) {
		await ctx.watch();
		return;
	}
	await ctx.rebuild();
	await ctx.dispose();
}

async function main() {
	await Promise.all([
		build({
			entryPoints: ['src/extension-node.ts'],
			format: 'cjs',
			platform: 'node',
			outfile: 'dist/extension.js',
			external: ['vscode'],
		}),
		build({
			entryPoints: ['src/extension-web.ts'],
			format: 'cjs',
			platform: 'browser',
			outfile: 'dist/extension-web.js',
			external: ['vscode'],
		}),
		build({
			entryPoints: ['src/webview/styles.css'],
			bundle: true,
			minify: production,
			outfile: 'dist/webview.css',
		}),
	]);
	await buildWebview();
	await buildFormulaWorker();
	await buildFormulaParserNode();
	await buildFormulaParserWeb();
	fs.mkdirSync('dist', { recursive: true });
	fs.copyFileSync('node_modules/formualizer/LICENSE-MIT', 'dist/FORMUALIZER-LICENSE-MIT');
	fs.copyFileSync('node_modules/formualizer/LICENSE-APACHE', 'dist/FORMUALIZER-LICENSE-APACHE');
}

function buildFormulaParserNode() {
	const compiler = webpack({
		mode: production ? 'production' : 'development',
		context: path.resolve('.'),
		entry: './src/formula-parser-node.mts',
		target: ['node', 'node18'],
		experiments: { asyncWebAssembly: true, outputModule: true },
		module: {
			rules: [
				{
					test: /\.[cm]?tsx?$/,
					exclude: /node_modules/,
					use: { loader: 'ts-loader', options: { configFile: 'tsconfig.formula-test.json', transpileOnly: true, compilerOptions: { noEmit: false } } },
				},
				{ test: /\.wasm$/, type: 'webassembly/async' },
			],
		},
		resolve: { extensions: ['.mts', '.ts', '.js'] },
		output: {
			path: path.resolve('dist'), filename: 'formula-parser-node.mjs', module: true, chunkFormat: 'module', library: { type: 'module' },
			webassemblyModuleFilename: 'formualizer.wasm',
		},
		optimization: { minimize: production },
		devtool: production ? false : 'source-map',
	});
	if (watch) {
		compiler.watch({}, (error, stats) => {reportWebpackBuild(error, stats); if (!error && !stats?.hasErrors()) {pruneUnusedFormulaParserAssets(stats);}});
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		compiler.run((error, stats) => {
			if (error) {reject(error); return;}
			if (stats?.hasErrors()) {reject(new Error(stats.toString({ all: false, errors: true, warnings: true }))); return;}
			reportWebpackBuild(undefined, stats);
			pruneUnusedFormulaParserAssets(stats);
			compiler.close(closeError => closeError ? reject(closeError) : resolve());
		});
	});
}

function buildFormulaParserWeb() {
	const compiler = webpack({
		mode: production ? 'production' : 'development',
		context: path.resolve('.'),
		entry: './src/formula-parser-web.mts',
		target: ['web', 'es2022'],
		experiments: { asyncWebAssembly: true, outputModule: true },
		module: {
			rules: [
				{ test: /\.[cm]?tsx?$/, exclude: /node_modules/, use: { loader: 'ts-loader', options: { configFile: 'tsconfig.formula-test.json', transpileOnly: true, compilerOptions: { noEmit: false } } } },
				{ test: /\.wasm$/, type: 'webassembly/async' },
			],
		},
		resolve: { extensions: ['.mts', '.ts', '.js'] },
		output: {
			path: path.resolve('dist'), filename: 'formula-parser-web.mjs', module: true, chunkFormat: 'module', library: { type: 'module' },
			webassemblyModuleFilename: 'formualizer-web.wasm',
		},
		optimization: { minimize: production },
		devtool: production ? false : 'source-map',
	});
	if (watch) {
		compiler.watch({}, (error, stats) => reportWebpackBuild(error, stats));
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		compiler.run((error, stats) => {
			if (error) {reject(error); return;}
			if (stats?.hasErrors()) {reject(new Error(stats.toString({ all: false, errors: true, warnings: true }))); return;}
			reportWebpackBuild(undefined, stats);
			compiler.close(closeError => closeError ? reject(closeError) : resolve());
		});
	});
}

function pruneUnusedFormulaParserAssets(stats) {
	const emitted = new Set(stats.compilation.getAssets().map(asset => asset.name));
	for (const file of fs.readdirSync('dist')) {
		if (/^formula-parser-node-.+\.wasm$/.test(file) && !emitted.has(file)) {fs.unlinkSync(path.join('dist', file));}
	}
}

function buildWebview() {
	const compiler = webpack({
			mode: production ? 'production' : 'development',
			entry: './src/webview/main.ts',
			target: ['web', 'es2022'],
			experiments: { asyncWebAssembly: true },
			module: {
				rules: [
					{
						test: /\.tsx?$/,
						exclude: /node_modules/,
						use: {
							loader: 'ts-loader',
							options: {
								configFile: 'tsconfig.webview.json',
								transpileOnly: true,
								compilerOptions: { noEmit: false },
							},
						},
					},
					{ test: /\.wasm$/, type: 'webassembly/async' },
				],
			},
			resolve: { extensions: ['.ts', '.js'] },
			plugins: [new webpack.IgnorePlugin({ resourceRegExp: /\.css$/ })],
			output: {
				path: path.resolve('dist'),
				filename: 'webview.js',
				chunkFilename: '[name].[contenthash].js',
			webassemblyModuleFilename: 'formualizer.wasm',
			},
			optimization: { minimize: production, splitChunks: false, runtimeChunk: false },
			devtool: production ? false : 'source-map',
		});
	if (watch) {
		compiler.watch({}, (error, stats) => {
			reportWebpackBuild(error, stats);
		});
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		compiler.run((error, stats) => {
			if (error) {reject(error); return;}
			if (stats?.hasErrors()) {
				reject(new Error(stats.toString({ all: false, errors: true, warnings: true })));
				return;
			}
			reportWebpackBuild(undefined, stats);
			compiler.close(closeError => closeError ? reject(closeError) : resolve());
		});
	});
}

function buildFormulaWorker() {
	const compiler = webpack({
		mode: production ? 'production' : 'development',
		entry: './src/webview/formula-worker.ts',
		target: ['webworker', 'es2022'],
		experiments: { asyncWebAssembly: true },
		module: {
			rules: [
				{
					test: /\.tsx?$/,
					exclude: /node_modules/,
					use: { loader: 'ts-loader', options: { configFile: 'tsconfig.webview.json', transpileOnly: true, compilerOptions: { noEmit: false } } },
				},
				{ test: /\.wasm$/, type: 'webassembly/async' },
			],
		},
		resolve: { extensions: ['.ts', '.js'] },
		plugins: [new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })],
		output: {
			path: path.resolve('dist'),
			filename: 'formula-worker.js',
			webassemblyModuleFilename: 'formualizer.wasm',
		},
		optimization: { minimize: production },
		devtool: production ? false : 'source-map',
	});
	if (watch) {
		compiler.watch({}, (error, stats) => reportWebpackBuild(error, stats));
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		compiler.run((error, stats) => {
			if (error) {reject(error); return;}
			if (stats?.hasErrors()) {reject(new Error(stats.toString({ all: false, errors: true, warnings: true }))); return;}
			reportWebpackBuild(undefined, stats);
			compiler.close(closeError => closeError ? reject(closeError) : resolve());
		});
	});
}

function reportWebpackBuild(error, stats) {
	if (error) {console.error(error); return;}
	if (stats?.hasErrors()) {
		console.error(stats.toString({ all: false, errors: true, warnings: true }));
		return;
	}
	if (stats?.hasWarnings()) {console.warn(stats.toString({ all: false, warnings: true }));}
	pruneUnusedWebviewAssets(stats);
	console.log(stats?.toString({ all: false, assets: true }));
}

function pruneUnusedWebviewAssets(stats) {
	const emitted = new Set(stats.compilation.getAssets().map(asset => asset.name));
	for (const file of fs.readdirSync('dist')) {
		if (/^(?:src_webview_formula-calculator_ts\..+\.js(?:\.map)?|formualizer-.+\.wasm)$/.test(file) && !emitted.has(file)) {
			fs.unlinkSync(path.join('dist', file));
		}
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});

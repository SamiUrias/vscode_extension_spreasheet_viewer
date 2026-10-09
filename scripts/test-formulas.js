const { execFileSync } = require('node:child_process');
const path = require('node:path');
const webpack = require('webpack');

const root = path.resolve(__dirname, '..');
const config = {
	mode: 'production',
	context: root,
	target: ['node', 'node18'],
	entry: './src/test/formula-calculator.test.ts',
	experiments: { asyncWebAssembly: true, outputModule: true },
	module: {
		rules: [
			{
				test: /\.tsx?$/,
				exclude: /node_modules/,
				use: {
					loader: require.resolve('ts-loader'),
					options: {
						configFile: path.join(root, 'tsconfig.formula-test.json'),
						transpileOnly: true,
						compilerOptions: { noEmit: false },
					},
				},
			},
			{ test: /\.wasm$/, type: 'webassembly/async' },
		],
	},
	resolve: { extensions: ['.ts', '.js'] },
	output: {
		path: path.join(root, 'out', 'formula-tests'),
		filename: 'formula-calculator.test.mjs',
		module: true,
		chunkFormat: 'module',
	},
	optimization: { minimize: true },
};

function buildAndRun() {
	const compiler = webpack(config);
	compiler.run((error, stats) => {
		if (error || stats?.hasErrors()) {
			console.error(error ?? stats?.toString({ all: false, errors: true }));
			process.exitCode = 1;
			compiler.close(() => {});
			return;
		}
		compiler.close(closeError => {
			if (closeError) {
				console.error(closeError);
				process.exitCode = 1;
				return;
			}
			try {
				execFileSync(process.execPath, [path.join(config.output.path, config.output.filename)], { stdio: 'inherit' });
			} catch (runError) {
				process.exitCode = runError.status ?? 1;
			}
		});
	});
}

execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--project', path.join(root, 'tsconfig.formula-test.json')], { stdio: 'inherit' });
buildAndRun();

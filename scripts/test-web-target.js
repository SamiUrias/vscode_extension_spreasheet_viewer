const assert = require('node:assert/strict');
const fs = require('node:fs');

for (const asset of ['dist/extension-web.js', 'dist/formula-parser-web.mjs', 'dist/formualizer-web.wasm', 'dist/webview.js', 'dist/formula-worker.js']) {
	assert.ok(fs.existsSync(asset), `missing Web runtime asset: ${asset}`);
}
const extensionBundle = fs.readFileSync('dist/extension-web.js', 'utf8');
assert.doesNotMatch(extensionBundle, /from\s*["']node:|require\(["']node:/, 'Web extension bundle must not import Node built-ins');
const formulaBundle = fs.readFileSync('dist/formula-parser-web.mjs', 'utf8');
assert.doesNotMatch(formulaBundle, /from\s*["']node:|require\(["']node:/, 'Web formula parser bundle must not import Node built-ins');
console.log('Web target bundle and formula assets verified');

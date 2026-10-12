const fs = require('node:fs');
const path = require('node:path');

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const catalogs = ['package.nls.json', 'package.nls.es.json'].map(file => ({
	file,
	values: JSON.parse(fs.readFileSync(file, 'utf8')),
}));
const errors = [];
const referenced = new Map();
const placeholderPattern = /%([\w.-]+)%/g;

function reference(key, source) {
	if (!referenced.has(key)) referenced.set(key, []);
	referenced.get(key).push(source);
}

function inspectText(value, source) {
	if (typeof value !== 'string') return;
	for (const match of value.matchAll(placeholderPattern)) reference(match[1], source);
	if (/%[^%\s]+%/.test(value) && ![...value.matchAll(placeholderPattern)].length) {
		errors.push(`${source}: invalid or unresolved NLS placeholder`);
	}
}

inspectText(manifest.description, 'package.json description');
for (const [index, command] of (manifest.contributes?.commands ?? []).entries()) {
	inspectText(command.title, `command ${command.command ?? index}`);
}
for (const [id, property] of Object.entries(manifest.contributes?.configuration?.properties ?? {})) {
	const key = /^%([\w.-]+)%$/.exec(property.description ?? '')?.[1];
	if (!key) errors.push(`setting ${id}: description must be one NLS key`);
	else reference(key, `setting ${id}`);
}

const keys = catalogs.map(({ values, file }) => {
	for (const [key, value] of Object.entries(values)) {
		if (typeof value !== 'string') errors.push(`${file}: ${key} must map to a string`);
	}
	return new Set(Object.keys(values));
});
if (keys[0].size !== keys[1].size || [...keys[0]].some(key => !keys[1].has(key))) {
	errors.push('English and Spanish NLS catalogs must have exactly the same keys');
}

for (const [key, sources] of referenced) {
	for (const { values, file } of catalogs) {
		if (!(key in values)) errors.push(`${file}: missing referenced key ${key} (${sources.join(', ')})`);
	}
}

function readRuntimeCatalog(file) {
	const source = fs.readFileSync(file, 'utf8');
	const entries = new Map();
	for (const match of source.matchAll(/^\s*'([^']+)': '((?:\\.|[^'])*)',?\s*$/gm)) {
		entries.set(match[1], match[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
	}
	return entries;
}

const runtimeCatalogs = ['src/i18n/messages.ts', 'src/i18n/es.ts'].map(readRuntimeCatalog);
const runtimeKeys = [...runtimeCatalogs[0].keys()];
if (runtimeCatalogs[0].size !== runtimeCatalogs[1].size
	|| runtimeKeys.some(key => !runtimeCatalogs[1].has(key))) {
	errors.push('English and Spanish runtime catalogs must have exactly the same keys');
}
const sourceFiles = [];
function collectSources(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const filename = path.join(directory, entry.name);
		if (entry.isDirectory()) collectSources(filename);
		else if (filename.endsWith('.ts') && !filename.includes(`${path.sep}i18n${path.sep}`)) sourceFiles.push(filename);
	}
}
collectSources('src');
const runtimeReferences = new Map();
for (const file of sourceFiles) {
	const source = fs.readFileSync(file, 'utf8');
	for (const match of source.matchAll(/\bt\('([^']+)'/g)) {
		if (!runtimeReferences.has(match[1])) runtimeReferences.set(match[1], []);
		runtimeReferences.get(match[1]).push(file);
	}
}
for (const [key, sources] of runtimeReferences) {
	for (const [index, catalog] of runtimeCatalogs.entries()) {
		if (!catalog.has(key)) errors.push(`${index === 0 ? 'src/i18n/messages.ts' : 'src/i18n/es.ts'}: missing runtime key ${key} (${sources.join(', ')})`);
	}
	const english = runtimeCatalogs[0].get(key);
	const spanish = runtimeCatalogs[1].get(key);
	const runtimePlaceholders = value => [...value.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort();
	if (english !== undefined && spanish !== undefined
		&& JSON.stringify(runtimePlaceholders(english)) !== JSON.stringify(runtimePlaceholders(spanish))) {
		errors.push(`${key}: English/Spanish runtime placeholders differ`);
	}
}
for (const { values, file } of catalogs) {
	for (const key of Object.keys(values)) {
		if (!referenced.has(key)) errors.push(`${file}: unused key ${key}`);
	}
}

function placeholders(value) {
	return [...value.matchAll(/%([\w.-]+)%/g)].map(match => match[1]).sort();
}
for (const [key, sources] of referenced) {
	const english = catalogs[0].values[key];
	const spanish = catalogs[1].values[key];
	if (typeof english === 'string' && typeof spanish === 'string'
		&& JSON.stringify(placeholders(english)) !== JSON.stringify(placeholders(spanish))) {
		errors.push(`${key}: English/Spanish placeholders differ`);
	}
}

if (errors.length) {
	console.error(errors.map(error => `✗ ${error}`).join('\n'));
	process.exitCode = 1;
} else {
	console.log(`Localization manifest check passed (${referenced.size} keys, ${manifest.contributes.configuration.properties ? Object.keys(manifest.contributes.configuration.properties).length : 0} settings).`);
}

import * as path from 'node:path';

/** Resolve well-known language IDs to a CSV separator without depending on a language extension. */
export function delimiterForLanguageId(languageId: string | undefined): string | undefined {
	if (!languageId) {return undefined;}
	const normalized = languageId.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
	if (normalized === 'tsv' || normalized === 'tab separated values' || normalized === 'csv (tab)') {return '\t';}
	if (normalized === 'csv (semicolon)' || normalized === 'csv semicolon' || normalized === 'semicolon separated values') {return ';';}
	if (normalized === 'csv (pipe)' || normalized === 'csv pipe' || normalized === 'pipe separated values') {return '|';}
	return undefined;
}

/** Filename conventions win; language IDs fill in the dialect when the URI has no known extension. */
export function delimiterForCsvResource(filePath: string, languageId?: string): string | undefined {
	if (/\.(tsv|tab)$/i.test(filePath)) {return '\t';}
	return delimiterForLanguageId(languageId);
}

export function isSupportedCsvLanguageId(languageId: string | undefined): boolean {
	if (!languageId) {return false;}
	const normalized = languageId.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
	return normalized === 'csv' || normalized === 'tsv' || normalized === 'tab separated values'
		|| normalized === 'csv (tab)' || normalized === 'csv (semicolon)' || normalized === 'csv semicolon'
		|| normalized === 'semicolon separated values' || normalized === 'csv (pipe)' || normalized === 'csv pipe'
		|| normalized === 'pipe separated values';
}

/** VS Code materializes `code -` as a temporary file using the `code-stdin` basename prefix. */
export function isStdinTempPath(filePath: string, tempDirectory: string): boolean {
	return path.resolve(path.dirname(filePath)) === path.resolve(tempDirectory)
		&& path.basename(filePath).startsWith('code-stdin');
}


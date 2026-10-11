import initializeWasm, { parse, tokenize } from 'formualizer';
import type { FormulaParserService } from './formula-reference.js';

let initialization: Promise<void> | undefined;

/** Creates the parser lazily; the extension loads this ESM bundle only when formula work needs it. */
export async function createFormulaParserService(): Promise<FormulaParserService> {
	initialization ??= initializeWasm().catch(error => {initialization = undefined; throw error;});
	await initialization;
	return {
		parseFormula: formula => parse(formula),
		tokenizeFormula: async formula => (await tokenize(formula)).tokens,
	};
}

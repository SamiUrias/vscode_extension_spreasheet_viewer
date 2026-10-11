import initializeWasm, { parse, tokenize } from 'formualizer';
import type { FormulaParserService } from './formula-reference.js';

let initialization: Promise<void> | undefined;

export async function createFormulaParserService(): Promise<FormulaParserService> {
	initialization ??= initializeWasm().catch(error => {initialization = undefined; throw error;});
	await initialization;
	return {
		parseFormula: formula => parse(formula),
		tokenizeFormula: async formula => (await tokenize(formula)).tokens,
	};
}

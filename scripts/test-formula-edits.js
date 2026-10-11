const tests = [];
global.suite = (_name, run) => run();
global.test = (name, run) => tests.push({ name, run });

require('../out/test/formats.test.js');
require('../out/test/formula-assistance.test.js');

async function main() {
	const selected = tests.filter(test => test.name === 'XLSX formula edits validate before journaling, clear caches, request recalculation, and undo/redo');
	if (selected.length !== 1) {throw new Error(`Expected one formula edit test, found ${selected.length}.`);}
	const assistance = tests.filter(test => test.name.startsWith('offers only verified') || test.name.startsWith('inserts selected references'));
	if (assistance.length !== 2) {throw new Error(`Expected two formula assistance tests, found ${assistance.length}.`);}
	for (const test of [...selected, ...assistance]) {
		await test.run();
		console.log(`Passed: ${test.name}`);
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});

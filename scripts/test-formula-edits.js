const tests = [];
global.suite = (_name, run) => run();
global.test = (name, run) => tests.push({ name, run });

require('../out/test/formats.test.js');

async function main() {
	const selected = tests.filter(test => test.name === 'XLSX formula edits validate before journaling, clear caches, request recalculation, and undo/redo');
	if (selected.length !== 1) {throw new Error(`Expected one formula edit test, found ${selected.length}.`);}
	for (const test of selected) {
		await test.run();
		console.log(`Passed: ${test.name}`);
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});

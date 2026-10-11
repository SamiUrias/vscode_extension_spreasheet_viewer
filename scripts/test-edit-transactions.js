const tests = [];
global.suite = (_name, run) => run();
global.test = (name, run) => tests.push({ name, run });

require('../out/test/edit-model.test.js');

async function main() {
	for (const test of tests) {
		await test.run();
		console.log(`Passed: ${test.name}`);
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});

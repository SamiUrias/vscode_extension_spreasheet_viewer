const tests = [];
global.suite = (_name, run) => run();
global.test = (name, run) => tests.push({ name, run });
global.setup = (run) => { global.__localizationSetup = run; };
global.teardown = (run) => { global.__localizationTeardown = run; };

require('../out/test/localization.test.js');

async function main() {
	for (const test of tests) {
		global.__localizationSetup?.();
		await test.run();
		global.__localizationTeardown?.();
		console.log(`Passed: ${test.name}`);
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});

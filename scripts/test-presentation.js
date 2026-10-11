const tests = [];
global.suite = (_name, run) => run();
global.test = (name, run) => tests.push({ name, run });

require('../out/test/presentation.test.js');

async function main() {
	if (tests.length !== 5) {throw new Error(`Expected five presentation tests, found ${tests.length}.`);}
	for (const test of tests) {await test.run(); console.log(`Passed: ${test.name}`);}
}

main().catch(error => {console.error(error); process.exitCode = 1;});

const tests = [];
global.suite = (_name, run) => run();
global.test = (name, run) => tests.push({ name, run });

require('../out/test/formats.test.js');

async function main() {
	const test = tests.find(item => item.name === 'value move preflights rectangular ranges and handles overlap from a captured source');
	if (!test) {throw new Error('Value move test was not compiled.');}
	await test.run();
	console.log(`Passed: ${test.name}`);
}

main().catch(error => {console.error(error); process.exitCode = 1;});

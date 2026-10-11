const tests = [];
global.suite = (_name, run) => run();
global.test = (name, run) => tests.push({ name, run });

require('../out/test/formats.test.js');

async function main() {
	const test = tests.find(item => item.name === 'XLSX structural model allows normal formulas only with a parser and rejects out-of-range operations');
	if (!test) {throw new Error('XLSX structural capability test was not compiled.');}
	await test.run();
	console.log(`Passed: ${test.name}`);
}

main().catch(error => {console.error(error); process.exitCode = 1;});

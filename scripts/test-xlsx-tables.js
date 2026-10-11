const tests = [];
global.suite = (_name, run) => run();
global.test = (name, run) => tests.push({ name, run });

require('../out/test/formats.test.js');

async function main() {
	const test = tests.find(item => item.name === 'XLSX tables add isolated OOXML parts and support non-overlapping tables');
	if (!test) {throw new Error('XLSX table creation test was not compiled.');}
	await test.run();
	console.log(`Passed: ${test.name}`);
}

main().catch(error => {console.error(error); process.exitCode = 1;});

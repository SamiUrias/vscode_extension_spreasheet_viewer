const tests = [];
global.suite = (_name, run) => run();
global.test = (name, run) => tests.push({ name, run });

require('../out/test/formats.test.js');

async function main() {
	const test = tests.find(item => item.name === 'XLSX style, merge and freeze operations preserve values and support undo');
	if (!test) {throw new Error('XLSX style operation test was not compiled.');}
	await test.run();
	console.log(`Passed: ${test.name}`);
}

main().catch(error => {console.error(error); process.exitCode = 1;});

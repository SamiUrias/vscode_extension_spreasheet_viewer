const tests = [];
global.suite = (_name, run) => run();
global.test = (name, run) => tests.push({ name, run });

require('../out/test/formats.test.js');

async function main() {
	const relevant = tests.filter(item => ['XLSX style, merge and freeze operations preserve values and support undo',
		'clearing a cell keeps its XLSX number format and undo restores original bytes'].includes(item.name));
	if (relevant.length !== 2) {throw new Error('XLSX style and clear operation tests were not compiled.');}
	for (const test of relevant) {await test.run(); console.log(`Passed: ${test.name}`);}
}

main().catch(error => {console.error(error); process.exitCode = 1;});

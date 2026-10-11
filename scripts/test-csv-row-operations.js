const tests = [];
global.suite = (_name, run) => run();
global.test = (name, run) => tests.push({ name, run });

require('../out/test/formats.test.js');
require('../out/test/edit-model.test.js');

async function main() {
	const relevant = tests.filter(item => ['CSV row operations preserve untouched records, preamble, comments, multiline cells, and EOLs',
		'CSV structural transactions rebase prior cell edits and undo/redo in source order'].includes(item.name));
	if (relevant.length !== 2) {throw new Error('CSV row operation tests were not compiled.');}
	for (const test of relevant) {await test.run(); console.log(`Passed: ${test.name}`);}
}

main().catch(error => {console.error(error); process.exitCode = 1;});

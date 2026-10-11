const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { unzipSync, zipSync } = require('fflate');
const { DOMParser } = require('@xmldom/xmldom');
const { parseCsvBytes, serializeCsvEdits } = require('../out/formats/csv');
const { SpreadsheetEditSession } = require('../out/edit-model');
const { parseXlsxBytes } = require('../out/formats/xlsx');
const { projectRows } = require('../out/table-view');

const iterations = Number(process.env.BENCHMARK_ITERATIONS ?? 5);
const rowCount = 35_290;
const columnCount = 5;
const encoder = new TextEncoder();
const csvText = Array.from({ length: rowCount }, (_, row) =>
	Array.from({ length: columnCount }, (_, column) => `${row}-${column}`).join(','),
).join('\n');
const csvBytes = encoder.encode(csvText);
const wideText = Array.from({ length: 500 }, (_, row) =>
	Array.from({ length: 256 }, (_, column) => `${row}-${column}`).join(','),
).join('\n');
const wideBytes = encoder.encode(wideText);

function measure(label, action) {
	const samples = [];
	let peakHeapUsedBytes = 0;
	let peakRssBytes = 0;
	for (let index = 0; index < iterations; index++) {
		if (global.gc) {global.gc();}
		const started = performance.now();
		action();
		samples.push(performance.now() - started);
		const memory = process.memoryUsage();
		peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
		peakRssBytes = Math.max(peakRssBytes, memory.rss);
	}
	samples.sort((a, b) => a - b);
	const percentile = value => samples[Math.min(samples.length - 1, Math.ceil(samples.length * value) - 1)];
	return { label, p50Ms: round(percentile(0.5)), p95Ms: round(percentile(0.95)), minMs: round(samples[0]), peakHeapUsedBytes, peakRssBytes };
}

function round(value) {return Number(value.toFixed(2));}

async function main() {
	const csv = parseCsvBytes(csvBytes);
	const session = new SpreadsheetEditSession(csv);
	const rows = session.getRows(0);
	const csvPayload = { type: 'csvData', revision: 0, documentId: 'benchmark', sheetId: 'sheet', fileName: 'benchmark.csv', rows,
		rowCount: rows.length, columnCount: rows[0]?.length ?? 0 };
	const xlsxBytes = makeXlsx(rowCount, columnCount);
	const sheetXml = new TextDecoder().decode(unzipSync(xlsxBytes)['xl/worksheets/sheet1.xml']);
	const beforeMemory = process.memoryUsage();
	const timings = [
		measure('read-copy-csv', () => Buffer.from(csvBytes)),
		measure('parse-csv-35290x5', () => parseCsvBytes(csvBytes)),
		measure('getRows-csv', () => session.getRows(0)),
		measure('serialize-csv', () => serializeCsvEdits(csv, [])),
		measure('webview-json-csv', () => JSON.stringify(csvPayload)),
		measure('sort-projection-csv', () => projectRows(rows, [{ column: 0, direction: 'desc', mode: 'text' }])),
		measure('parse-xlsx-xml-dom', () => new DOMParser().parseFromString(sheetXml, 'application/xml')),
		measure('parse-xlsx-35290x5', () => parseXlsxBytes(xlsxBytes)),
		measure('unzip-xlsx', () => unzipSync(xlsxBytes)),
		measure('getRows-wide-500x256', () => new SpreadsheetEditSession(parseCsvBytes(wideBytes)).getRows(0)),
	];
	const jsonBytes = encoder.encode(JSON.stringify(csvPayload)).byteLength;
	if (global.gc) {global.gc();}
	const afterMemory = process.memoryUsage();
	console.log(JSON.stringify({
		generatedAt: new Date().toISOString(),
		runtime: process.version,
		platform: `${os.platform()} ${os.release()} (${os.arch()})`,
		cpu: os.cpus()[0]?.model,
		iterations,
		fixtures: {
			csv35290x5: { bytes: csvBytes.byteLength, rows: rowCount, columns: columnCount },
			csv500x256: { bytes: wideBytes.byteLength, rows: 500, columns: 256 },
			xlsx35290x5: { zipBytes: xlsxBytes.byteLength, worksheetXmlBytes: encoder.encode(sheetXml).byteLength, rows: rowCount, columns: columnCount },
			csvWebviewJsonBytes: jsonBytes,
		},
		timings,
		memory: {
			heapUsedBeforeBytes: beforeMemory.heapUsed,
			heapUsedAfterBytes: afterMemory.heapUsed,
			rssBeforeBytes: beforeMemory.rss,
			rssAfterBytes: afterMemory.rss,
		},
	}, null, 2));
}

function makeXlsx(rows, columns) {
	const columnName = index => {
		let value = index + 1; let name = '';
		while (value > 0) {const remainder = (value - 1) % 26; name = String.fromCharCode(65 + remainder) + name; value = Math.floor((value - 1) / 26);}
		return name;
	};
	let sheetData = '';
	for (let row = 1; row <= rows; row++) {
		sheetData += `<row r="${row}">`;
		for (let column = 0; column < columns; column++) {
			const reference = `${columnName(column)}${row}`;
			sheetData += `<c r="${reference}"><v>${row * columns + column}</v></c>`;
		}
		sheetData += '</row>';
	}
	const files = {
		'[Content_Types].xml': encoder.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
		'xl/workbook.xml': encoder.encode('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
		'xl/_rels/workbook.xml.rels': encoder.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
		'xl/worksheets/sheet1.xml': encoder.encode(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${columnName(columns - 1)}${rows}"/><sheetData>${sheetData}</sheetData></worksheet>`),
	};
	return zipSync(files);
}

main().catch(error => {console.error(error); process.exitCode = 1;});

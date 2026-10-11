const assert = require('node:assert/strict');
const { zipSync } = require('fflate');
const { parseXlsxBytes } = require('../out/formats/xlsx.js');

const bytes = value => new TextEncoder().encode(value);
const workbook = zipSync({
	'[Content_Types].xml': bytes('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>'),
	'xl/workbook.xml': bytes('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
	'xl/_rels/workbook.xml.rels': bytes('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
	'xl/worksheets/sheet1.xml': bytes('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>safe</t></is></c></row></sheetData></worksheet>'),
	'xl/vbaProject.bin': new Uint8Array([0, 1, 2]),
	'_xmlsignatures/sig1.xml': bytes('<Signature/>'),
});
const parsed = parseXlsxBytes(workbook);
assert.equal(parsed.macroEnabled, true);
assert.equal(parsed.hasVbaProject, true);
assert.equal(parsed.hasDigitalSignatures, true);
assert.ok(parsed.warnings.some(warning => warning.includes('macros nunca se ejecutan')));
assert.ok(parsed.warnings.some(warning => warning.includes('firmas digitales')));
assert.equal(parsed.sheets[0].rows[0][0], 'safe');
console.log('XLSM container inspection tests passed');
